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
/**
 * Whether the power's target effects should transfer, given the save outcome.
 */
function shouldApplyEffects(system, save) {
  const timing = system.effectApplyTiming;
  if (!timing || timing === "never") return false;
  if (timing === "always") return true;
  if (!save) return false; // onFail/onSave need a save to have been rolled
  if (timing === "onFail") return !save.success;
  if (timing === "onSave") return save.success;
  return false;
}

/**
 * Serialize the power's target-flagged ActiveEffects for creation on a target,
 * gated by the power's effectApplyTiming and the save outcome.
 * @returns {Array<object>} ActiveEffect creation data (empty if none apply)
 */
export function pickTargetEffects(power, save) {
  if (!shouldApplyEffects(power.system, save)) return [];
  const marked = (power.effects?.contents ?? power.effects ?? []).filter(
    (e) => e.getFlag?.("swnr", "applyToTarget")
  );
  return marked.map((e) => {
    const data = e.toObject();
    delete data._id;
    data.transfer = false;
    data.origin = power.uuid;
    // Don't carry the "apply to target" marker onto the target's own copy.
    if (data.flags?.swnr) delete data.flags.swnr.applyToTarget;
    return data;
  });
}

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
    const effects = pickTargetEffects(power, save);

    rows.push({
      tokenId: token.id,
      sceneId: token.scene?.id ?? canvas?.scene?.id ?? null,
      actorId: actor.id,
      name: token.name ?? actor.name,
      save,
      amount,
      amountLabel: labelForAmount(amount),
      effects,
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
  if (row.effects?.length && token.actor) {
    const created = await token.actor.createEmbeddedDocuments(
      "ActiveEffect",
      foundry.utils.deepClone(row.effects)
    );
    if (!row.snapshot) row.snapshot = { createdEffectIds: [] };
    row.snapshot.createdEffectIds = created.map((e) => e.id);
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
    if (token) {
      if (msg.amount !== 0) {
        const res = await applyHealthDropToToken(token, msg.amount);
        snapshot = res?.snapshot ?? null;
      }
      if (msg.effects?.length && token.actor) {
        const created = await token.actor.createEmbeddedDocuments(
          "ActiveEffect",
          foundry.utils.deepClone(msg.effects)
        );
        if (!snapshot) snapshot = { createdEffectIds: [] };
        snapshot.createdEffectIds = created.map((e) => e.id);
      }
    }
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

/* -------------------------------------------- */
/* GM-only undo & reroll                        */
/* -------------------------------------------- */

/** Restore a row's target from its undo snapshot (health, soak, effects, defeated). */
async function revertTargetRow(row) {
  const snap = row.snapshot;
  if (!snap) return;
  const token = resolveToken(row.sceneId, row.tokenId);
  const actor = token?.actor ?? game.actors.get(row.actorId);
  if (actor) {
    const updates = {};
    if (snap.health != null) updates["system.health.value"] = snap.health;
    if (actor.type === "npc" && snap.baseSoak != null) updates["system.baseSoakTotal.value"] = snap.baseSoak;
    if (Object.keys(updates).length) await actor.update(updates);

    // Restore depleted armor soak values
    if (Array.isArray(snap.soak) && snap.soak.length) {
      const embedded = snap.soak
        .filter((s) => actor.items.get(s.itemId))
        .map((s) => ({ _id: s.itemId, "system.soak.value": s.value }));
      if (embedded.length) await actor.updateEmbeddedDocuments("Item", embedded);
    }

    // Restore hacker health (cyberdeck path)
    if (snap.hackerId && snap.hackerHealth != null) {
      const hacker = game.actors.get(snap.hackerId);
      if (hacker) await hacker.update({ "system.health.value": snap.hackerHealth });
    }

    // Remove any ActiveEffects this application created
    if (Array.isArray(snap.createdEffectIds) && snap.createdEffectIds.length) {
      const existing = snap.createdEffectIds.filter((id) => actor.effects.get(id));
      if (existing.length) await actor.deleteEmbeddedDocuments("ActiveEffect", existing);
    }

    // Restore the DEFEATED status/combatant state
    const status = CONFIG.statusEffects.find((e) => e.id === CONFIG.specialStatusEffects.DEFEATED);
    if (status && typeof actor.toggleStatusEffect === "function") {
      const currentlyDefeated = actor.statuses?.has?.(status.id) ?? false;
      if (!!snap.defeated !== currentlyDefeated) {
        await actor.toggleStatusEffect(status.id, { active: !!snap.defeated, overlay: true });
      }
    }
    if (token?.combatant) await token.combatant.update({ defeated: !!snap.defeated });
  }
  row.snapshot = null;
}

/** GM-only: undo a single applied row. */
export async function revertFromButton(message, index) {
  if (!game.user.isGM) return;
  const rows = foundry.utils.deepClone(message.flags?.swnr?.targetResults ?? []);
  const row = rows[index];
  if (!row || row.status !== "applied") return;
  await revertTargetRow(row);
  row.status = "reverted";
  await message.setFlag("swnr", "targetResults", rows);
  await rerenderPowerCard(message);
}

/** GM-only: undo every applied row. */
export async function revertAllFromButton(message) {
  if (!game.user.isGM) return;
  const rows = foundry.utils.deepClone(message.flags?.swnr?.targetResults ?? []);
  let changed = false;
  for (const row of rows) {
    if (row.status !== "applied") continue;
    await revertTargetRow(row);
    row.status = "reverted";
    changed = true;
  }
  if (changed) {
    await message.setFlag("swnr", "targetResults", rows);
    await rerenderPowerCard(message);
  }
}

/** GM-only: re-apply a reverted row exactly as it was (no re-roll). */
export async function reapplyFromButton(message, index) {
  if (!game.user.isGM) return;
  const rows = foundry.utils.deepClone(message.flags?.swnr?.targetResults ?? []);
  const row = rows[index];
  if (!row || row.status !== "reverted") return;
  await applyTargetRow(row); // re-applies the stored amount + effects, captures a fresh snapshot
  row.status = "applied";
  await message.setFlag("swnr", "targetResults", rows);
  await rerenderPowerCard(message);
}

/** GM-only: re-roll a row's save, recompute the amount/effects, and re-apply. */
export async function rerollFromButton(message, index) {
  if (!game.user.isGM) return;
  const rows = foundry.utils.deepClone(message.flags?.swnr?.targetResults ?? []);
  const row = rows[index];
  if (!row) return;

  const power = message.flags?.swnr?.powerUuid ? await fromUuid(message.flags.swnr.powerUuid) : null;
  if (!power?.system) return;

  // Undo the existing application first (if any).
  if (row.status === "applied" && row.snapshot) await revertTargetRow(row);

  // Re-roll the save and recompute the outcome against the stored roll total
  // (SWN rolls damage once for all targets; only the save is re-rolled).
  const actor = game.actors.get(row.actorId);
  const saveType = power.system.save || null;
  const save = saveType && actor ? await rollSaveForActor(actor, saveType) : null;
  const base = message.flags?.swnr?.powerRollTotal ?? 0;
  const amount = computeAmount(power.system, base, save);
  row.save = save;
  row.amount = amount;
  row.amountLabel = labelForAmount(amount);
  row.effects = pickTargetEffects(power, save);

  // Re-apply (GM can modify anything).
  await applyTargetRow(row);
  row.status = "applied";

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
