/**
 * Targeted-power automation.
 *
 * When a power has `system.applyToTargets` enabled and the triggering user has
 * Foundry tokens targeted, using the power rolls each target's save, computes a
 * per-target amount (damage or healing) honoring the save behavior, and applies
 * it. Application happens directly for targets the user can modify; other targets
 * fall back to a manual Apply button (a GM-approval relay is added in a later phase).
 *
 * Per-target results are stored in `message.flags.swnr.targetResults` so that chat
 * re-renders never re-roll saves or re-apply effects.
 */

import { applyHealthDropToToken } from "./chat.mjs";

const POWER_CARD_TEMPLATE = "systems/swnr/templates/chat/power-usage.hbs";

/**
 * Compute the signed amount applied to a single target.
 * Positive = damage, negative = healing.
 * @param {object} system - power.system
 * @param {number} base - the power roll total
 * @param {object|null} save - result from rollSaveResult, or null if no save
 * @returns {number}
 */
export function computeAmount(system, base, save) {
  let amt = Math.max(0, Math.floor(Number(base) || 0));
  if (save && save.success) {
    if (system.saveBehavior === "negates") amt = 0;
    else if (system.saveBehavior === "half") amt = Math.floor(amt / 2);
  }
  if (system.effectKind === "healing") amt = -amt;
  return amt;
}

function labelForAmount(amount) {
  if (amount > 0) return game.i18n.format("swnr.power.amount.damage", { n: amount });
  if (amount < 0) return game.i18n.format("swnr.power.amount.healing", { n: -amount });
  return game.i18n.localize("swnr.power.amount.none");
}

/**
 * Roll a save for a target actor without any dialog, returning the outcome.
 * Falls back to auto-success for actor types that don't implement rollSaveResult.
 */
async function rollSaveForActor(actor, saveType) {
  if (typeof actor.system?.rollSaveResult === "function") {
    return await actor.system.rollSaveResult(saveType);
  }
  return { saveType, target: null, total: null, success: true, rollJSON: null };
}

function resolveToken(sceneId, tokenId) {
  const scene = sceneId ? game.scenes.get(sceneId) : canvas?.scene;
  const doc = scene?.tokens?.get(tokenId);
  return doc?.object ?? null;
}

/**
 * Resolve the current user's targets into per-target result rows.
 * Pure: rolls saves and computes amounts but writes nothing to actors.
 * @param {Item} power - the power item
 * @param {Roll|null} powerRoll - the (already-evaluated) power roll
 * @returns {Promise<Array<object>|null>} rows, or null if targeting doesn't apply
 */
export async function resolvePowerTargets(power, powerRoll) {
  const system = power.system;
  if (!system?.applyToTargets) return null;

  const targets = Array.from(game.user?.targets ?? []);
  if (!targets.length) return null;

  const base = powerRoll?.total ?? 0;
  const saveType = system.save || null;
  const rows = [];

  for (const token of targets) {
    const actor = token.actor;
    if (!actor) continue;

    const save = saveType ? await rollSaveForActor(actor, saveType) : null;
    const amount = computeAmount(system, base, save);

    rows.push({
      tokenId: token.id,
      sceneId: token.scene?.id ?? canvas?.scene?.id ?? null,
      actorId: actor.id,
      name: token.name ?? actor.name,
      save,
      amount,
      amountLabel: labelForAmount(amount),
      effects: [], // populated in the ActiveEffect phase
      canModify: actor.isOwner,
      status: "pending", // pending | applied | awaitingGM | manual | reverted
      snapshot: null,
    });
  }

  return rows.length ? rows : null;
}

/**
 * Apply a single resolved row to its target (damage/healing now; effects later),
 * capturing an undo snapshot onto the row.
 */
async function applyTargetRow(row) {
  const token = resolveToken(row.sceneId, row.tokenId);
  if (!token) return;
  if (row.amount !== 0) {
    const res = await applyHealthDropToToken(token, row.amount);
    row.snapshot = res?.snapshot ?? null;
  }
}

/**
 * After the power's chat message exists, apply each resolved target row.
 * Runs once, on the triggering user's client. Owned targets are applied
 * directly; others are routed to the active GM for approval (falling back to a
 * manual Apply button when there is no active GM).
 * @param {ChatMessage} message
 * @param {Item} power - the power item
 */
export async function applyPowerResults(message, power) {
  const rows = message.getFlag("swnr", "targetResults");
  if (!Array.isArray(rows) || !rows.length) return;

  let changed = false;
  for (const row of rows) {
    if (row.status !== "pending") continue;
    if (row.amount === 0 && (!row.effects || !row.effects.length)) {
      row.status = "applied";
      changed = true;
      continue;
    }
    if (row.canModify) {
      await applyTargetRow(row);
      row.status = "applied";
      changed = true;
    } else {
      // Ask the active GM to approve; sets status awaitingGM or manual (no GM).
      requestGMApply(row, message, power);
      changed = true;
    }
  }

  if (changed) {
    await message.setFlag("swnr", "targetResults", rows);
    await rerenderPowerCard(message);
  }
}

/**
 * Re-render a power chat card from its stored flags, preserving the roll and
 * consumption display and reflecting the latest targetResults. Used after
 * applying targets so status cells update without re-rolling anything.
 * @param {ChatMessage} message
 */
export async function rerenderPowerCard(message) {
  const f = message.flags?.swnr ?? {};
  let power = null;
  try {
    power = f.powerUuid ? await fromUuid(f.powerUuid) : null;
  } catch (_e) {
    power = null;
  }
  const actor = power?.actor ?? (f.actorId ? game.actors.get(f.actorId) : null);
  const consumptions = f.consumptionResults ?? [];
  const targetResults = f.targetResults ?? [];

  let hasManualConsumables = false;
  let consumableRequirements = [];
  let isPassive = false;
  if (power?.system) {
    const all = power.system.consumptions ?? [];
    hasManualConsumables = all.some((c) => c.timing === "manual" && c.type === "consumableItem");
    consumableRequirements = all
      .map((c, idx) => ({ index: idx, ...c }))
      .filter((c) => c && c.timing === "manual" && c.type === "consumableItem" && (c.itemText || "").trim().length > 0)
      .map((c) => ({ index: c.index, amount: c.usesCost || 0, text: (c.itemText || "").trim() }));
    const runtime = all.filter((c) => c.timing === "immediate" || c.timing === "manual");
    isPassive = runtime.length === 0;
  }

  const templateData = {
    actor,
    power,
    powerRoll: f.powerRollHTML ?? null,
    strainCost: f.strainCost ?? 0,
    isPassive,
    consumptions,
    hasManualConsumables,
    hasUnprocessedConsumableManual: hasManualConsumables,
    consumableRequirements,
    targetResults,
  };

  const content = await foundry.applications.handlebars.renderTemplate(POWER_CARD_TEMPLATE, templateData);
  await message.update({ content });
}

/* -------------------------------------------- */
/* GM approval relay                            */
/* -------------------------------------------- */

const SOCKET_NAME = "system.swnr";
const SOCKET_APPLY_REQUEST = "swnr.applyPowerRequest";

/** Register the system socket listener. Call once at `ready`. */
export function registerPowerSocket() {
  game.socket.on(SOCKET_NAME, onPowerSocket);
}

async function onPowerSocket(msg) {
  if (!msg || msg.type !== SOCKET_APPLY_REQUEST) return;
  // Only the single active GM that the request is addressed to acts on it.
  const activeGM = game.users?.activeGM;
  if (!game.user.isGM || !activeGM || activeGM.id !== game.user.id || msg.gmUserId !== game.user.id) return;
  await handleGMApplyRequest(msg);
}

function describeSave(save) {
  if (!save) return game.i18n.localize("swnr.power.saveResult.none");
  return game.i18n.format(
    save.success ? "swnr.power.saveResult.success" : "swnr.power.saveResult.failure",
    { total: save.total, target: save.target }
  );
}

/**
 * Ask the active GM to approve applying a row to a target the caster can't
 * modify. Sets the row status (awaitingGM, or manual if no active GM) and emits
 * the request. The GM updates the message directly when it responds.
 */
function requestGMApply(row, message, power) {
  const gm = game.users?.activeGM;
  if (!gm) {
    row.status = "manual";
    return;
  }
  row.status = "awaitingGM";
  game.socket.emit(SOCKET_NAME, {
    type: SOCKET_APPLY_REQUEST,
    gmUserId: gm.id,
    fromUserId: game.user.id,
    messageId: message.id,
    sceneId: row.sceneId,
    tokenId: row.tokenId,
    amount: row.amount,
    effects: row.effects ?? [],
    casterName: power?.actor?.name ?? null,
    targetName: row.name,
    effectLabel: row.amountLabel,
    saveText: describeSave(row.save),
  });
}

/** GM side: prompt to approve/deny, then apply and update the card. */
async function handleGMApplyRequest(msg) {
  const message = game.messages?.get(msg.messageId);
  const approved = await foundry.applications.api.DialogV2.confirm({
    window: { title: game.i18n.localize("swnr.power.gmApply.title") },
    content: `<p>${foundry.utils.escapeHTML(
      game.i18n.format("swnr.power.gmApply.prompt", {
        caster: msg.casterName ?? "?",
        target: msg.targetName ?? "?",
        effect: msg.effectLabel ?? "",
        save: msg.saveText ?? "",
      })
    )}</p>`,
    rejectClose: false,
    modal: false,
  });

  if (!message) return;

  let snapshot = null;
  if (approved) {
    const token = resolveToken(msg.sceneId, msg.tokenId);
    if (token && msg.amount !== 0) {
      const res = await applyHealthDropToToken(token, msg.amount);
      snapshot = res?.snapshot ?? null;
    }
    // ActiveEffect application to the target is added in a later phase.
  }

  // GMs can update any chat message; reflect the outcome for all clients.
  const rows = foundry.utils.deepClone(message.flags?.swnr?.targetResults ?? []);
  const row = rows.find((r) => r.tokenId === msg.tokenId && r.status === "awaitingGM");
  if (row) {
    row.status = approved ? "applied" : "manual";
    if (approved) row.snapshot = snapshot;
    await message.setFlag("swnr", "targetResults", rows);
    await rerenderPowerCard(message);
  }

  ui.notifications?.info(
    game.i18n.format(approved ? "swnr.power.gmApply.approved" : "swnr.power.gmApply.denied", {
      gm: game.user.name,
      effect: msg.effectLabel ?? "",
      target: msg.targetName ?? "",
    })
  );
}

/* -------------------------------------------- */
/* Manual Apply buttons                         */
/* -------------------------------------------- */

/** Apply a single row from its Apply button (owner/GM directly, else GM relay). */
export async function applyTargetFromButton(message, index) {
  const rows = foundry.utils.deepClone(message.flags?.swnr?.targetResults ?? []);
  const row = rows[index];
  if (!row || (row.status !== "manual" && row.status !== "pending")) return;

  const actor = game.actors.get(row.actorId);
  if ((actor?.isOwner ?? false) || game.user.isGM) {
    await applyTargetRow(row);
    row.status = "applied";
  } else {
    const power = message.flags?.swnr?.powerUuid ? await fromUuid(message.flags.swnr.powerUuid) : null;
    requestGMApply(row, message, power);
  }
  await message.setFlag("swnr", "targetResults", rows);
  await rerenderPowerCard(message);
}

/** Apply every still-manual row. */
export async function applyAllFromButton(message) {
  const rows = foundry.utils.deepClone(message.flags?.swnr?.targetResults ?? []);
  const power = message.flags?.swnr?.powerUuid ? await fromUuid(message.flags.swnr.powerUuid) : null;
  let changed = false;
  for (const row of rows) {
    if (row.status !== "manual" && row.status !== "pending") continue;
    const actor = game.actors.get(row.actorId);
    if ((actor?.isOwner ?? false) || game.user.isGM) {
      await applyTargetRow(row);
      row.status = "applied";
    } else {
      requestGMApply(row, message, power);
    }
    changed = true;
  }
  if (changed) {
    await message.setFlag("swnr", "targetResults", rows);
    await rerenderPowerCard(message);
  }
}
