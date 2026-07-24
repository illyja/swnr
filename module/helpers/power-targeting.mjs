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
 * directly; others are left as manual (a GM relay is added later).
 * @param {ChatMessage} message
 * @param {Item} _power - reserved for later phases
 */
export async function applyPowerResults(message, _power) {
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
      // Later phase: request GM approval via socket. For now, offer a manual button.
      row.status = "manual";
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
