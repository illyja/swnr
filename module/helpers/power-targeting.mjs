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
const WEAPON_CARD_TEMPLATE = "systems/swnr/templates/chat/attack-roll.hbs";
const SUPPRESS_CARD_TEMPLATE = "systems/swnr/templates/chat/suppress-fire.hbs";

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

/* -------------------------------------------- */
/* Weapon targeting                             */
/* -------------------------------------------- */

/**
 * The AC an attack must meet to hit this actor. Uses the CWN melee AC for melee
 * weapons when that rule is enabled; falls back to 10 when no AC is available.
 */
function weaponTargetAC(actor, isMelee) {
  let ac = actor?.system?.ac;
  const useCWN = game.settings.get("swnr", "useCWNArmor");
  if (useCWN && isMelee && actor?.system?.meleeAc != null) ac = actor.system.meleeAc;
  const n = Number(ac);
  return Number.isFinite(n) ? n : 10;
}

/**
 * Resolve the raw amount and hit outcome for one target from an attack context.
 * A hit deals main damage (or the traumatic-hit damage when trauma triggered);
 * a non-hit that still meets the weapon's shock AC deals shock damage; otherwise
 * it's a clean miss.
 * @returns {{hitLabel: "hit"|"shock"|"miss", base: number}}
 */
function computeWeaponOutcome(ctx, actor) {
  const targetAC = weaponTargetAC(actor, ctx.isMelee);
  if (ctx.attackTotal >= targetAC) {
    const base = ctx.traumaTriggered && ctx.traumaDamage != null ? ctx.traumaDamage : ctx.mainDamage;
    return { hitLabel: "hit", base };
  }
  if (ctx.shockDamage != null && ctx.shockAC != null && ctx.attackTotal >= ctx.shockAC) {
    return { hitLabel: "shock", base: ctx.shockDamage };
  }
  return { hitLabel: "miss", base: 0 };
}

/** Apply a weapon's save behavior (negates/half) to a raw amount. Weapons are damage-only. */
function applyWeaponSave(system, base, save) {
  let amt = Math.max(0, Math.floor(Number(base) || 0));
  if (save && save.success) {
    if (system.saveBehavior === "negates") amt = 0;
    else if (system.saveBehavior === "half") amt = Math.floor(amt / 2);
  }
  return amt;
}

function weaponAmountLabel(amount, hitLabel) {
  if (hitLabel === "miss") return game.i18n.localize("swnr.weapon.targeting.miss");
  if (hitLabel === "shock") return game.i18n.format("swnr.weapon.targeting.shockAmount", { n: amount });
  if (amount > 0) return game.i18n.format("swnr.power.amount.damage", { n: amount });
  return game.i18n.localize("swnr.power.amount.none");
}

/**
 * Resolve the current user's targets into per-target result rows for a weapon
 * attack. Pure: rolls saves (for weapons that have one) and computes amounts but
 * writes nothing to actors.
 * @param {Item} weapon - the weapon item
 * @param {object} ctx - attack context (attackTotal, mainDamage, shockDamage,
 *   shockAC, traumaTriggered, traumaDamage, isMelee)
 * @returns {Promise<Array<object>|null>} rows, or null if targeting doesn't apply
 */
export async function resolveWeaponTargets(weapon, ctx) {
  const system = weapon.system;
  if (!system?.applyToTargets) return null;

  const targets = Array.from(game.user?.targets ?? []);
  if (!targets.length) return null;

  const saveType = system.save || null;
  const rows = [];

  for (const token of targets) {
    const actor = token.actor;
    if (!actor) continue;

    const { hitLabel, base } = computeWeaponOutcome(ctx, actor);
    // Only roll a save for a target that actually took a hit and where a raw
    // amount exists (a clean miss never gets to save).
    const save = saveType && base > 0 ? await rollSaveForActor(actor, saveType) : null;
    const amount = applyWeaponSave(system, base, save);
    const effects = hitLabel !== "miss" ? pickTargetEffects(weapon, save) : [];

    rows.push({
      tokenId: token.id,
      sceneId: token.scene?.id ?? canvas?.scene?.id ?? null,
      actorId: actor.id,
      name: token.name ?? actor.name,
      save,
      amount,
      amountLabel: weaponAmountLabel(amount, hitLabel),
      hitLabel,
      effects,
      canModify: actor.isOwner,
      status: "pending", // pending | applied | awaitingGM | manual | reverted
      snapshot: null,
    });
  }

  return rows.length ? rows : null;
}

/* -------------------------------------------- */
/* Suppressive fire                             */
/* -------------------------------------------- */

function suppressAmountLabel(amount, hitLabel) {
  if (hitLabel === "saved" || amount <= 0) return game.i18n.localize("swnr.weapon.suppress.saved");
  if (hitLabel === "trauma") return game.i18n.format("swnr.weapon.suppress.trauma", { n: amount });
  return game.i18n.format("swnr.weapon.suppress.damage", { n: amount });
}

/**
 * Resolve one suppression outcome for a target from a rolled Evasion save.
 * Suppression auto-hits (no to-hit): a successful save negates, a failed save
 * takes half the weapon's damage (SWN rounds down, CWN rounds up). Under CWN a
 * per-victim trauma die can turn it into a Traumatic Hit.
 * @returns {Promise<{hitLabel: "saved"|"hit"|"trauma", amount: number}>}
 */
async function computeSuppressionOutcome(ctx, save) {
  if (save?.success) return { hitLabel: "saved", amount: 0 };
  const total = Math.max(0, Number(ctx.damageTotal) || 0);
  let amount = ctx.ruleset === "cwn" ? Math.ceil(total / 2) : Math.floor(total / 2);
  let hitLabel = "hit";
  // CWN: roll the weapon's Trauma Die individually against this victim.
  if (
    ctx.ruleset === "cwn" &&
    ctx.useTrauma &&
    ctx.traumaDie && ctx.traumaDie !== "none" &&
    ctx.traumaRating != null
  ) {
    const tRoll = new Roll(ctx.traumaDie);
    await tRoll.roll();
    if ((tRoll.total ?? 0) >= 6) {
      amount = Math.ceil(amount * ctx.traumaRating);
      hitLabel = "trauma";
    }
  }
  return { hitLabel, amount };
}

/**
 * Resolve the current user's targets into per-target suppression rows.
 * Pure: rolls each target's Evasion save (and CWN trauma) but writes nothing.
 * @param {Item} weapon - the weapon item
 * @param {object} ctx - { damageTotal, ruleset, useTrauma, traumaDie, traumaRating }
 * @returns {Promise<Array<object>|null>} rows, or null if targeting doesn't apply
 */
export async function resolveSuppressionTargets(weapon, ctx) {
  const targets = Array.from(game.user?.targets ?? []);
  if (!targets.length) return null;

  const rows = [];
  for (const token of targets) {
    const actor = token.actor;
    if (!actor) continue;

    const save = await rollSaveForActor(actor, "evasion");
    const { hitLabel, amount } = await computeSuppressionOutcome(ctx, save);
    const effects = hitLabel !== "saved" ? pickTargetEffects(weapon, save) : [];

    rows.push({
      tokenId: token.id,
      sceneId: token.scene?.id ?? canvas?.scene?.id ?? null,
      actorId: actor.id,
      name: token.name ?? actor.name,
      save,
      amount,
      amountLabel: suppressAmountLabel(amount, hitLabel),
      hitLabel,
      effects,
      canModify: actor.isOwner,
      status: "pending",
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
 * After the chat message exists, apply each resolved target row. Runs once, on
 * the triggering user's client. Owned targets are applied directly; others are
 * routed to the active GM for approval (falling back to a manual Apply button
 * when there is no active GM). Item-agnostic: works for powers and weapons.
 * @param {ChatMessage} message
 * @param {Item} item - the source item (power or weapon), used for GM prompts
 */
export async function applyPowerResults(message, item) {
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
      requestGMApply(row, message, item);
      changed = true;
    }
  }

  if (changed) {
    await message.setFlag("swnr", "targetResults", rows);
    await rerenderCard(message);
  }
}

// Neutral alias: the apply pipeline is item-agnostic (used by weapons too).
export { applyPowerResults as applyTargetResults };

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

/**
 * Re-render a card from its stored flags, dispatching on the target kind so the
 * shared apply/undo/relay code works for both powers and weapons.
 * @param {ChatMessage} message
 */
export async function rerenderCard(message) {
  const kind = message.flags?.swnr?.targetKind ?? "power";
  if (kind === "weapon") return rerenderWeaponCard(message);
  return rerenderPowerCard(message);
}

/**
 * Re-render a weapon attack card from its stored flags, preserving the rolled
 * hit/damage/shock/trauma display and reflecting the latest targetResults.
 * The renderable pieces are persisted in `flags.swnr.weaponCardData` at fire
 * time so re-rendering never re-rolls anything.
 * @param {ChatMessage} message
 */
export async function rerenderWeaponCard(message) {
  const f = message.flags?.swnr ?? {};
  let weapon = null;
  try {
    weapon = f.weaponUuid ? await fromUuid(f.weaponUuid) : null;
  } catch (_e) {
    weapon = null;
  }
  const actor = weapon?.actor ?? (f.actorId ? game.actors.get(f.actorId) : null);
  const cd = f.weaponCardData ?? {};

  // Suppressive fire uses its own compact card.
  if (f.suppress) {
    const templateData = {
      actor,
      weapon,
      suppress: true,
      ruleset: f.ruleset ?? "swn",
      damageRoll: cd.damageRoll ?? null,
      ammoSpent: cd.ammoSpent ?? 0,
      targetResults: f.targetResults ?? [],
    };
    const content = await foundry.applications.handlebars.renderTemplate(SUPPRESS_CARD_TEMPLATE, templateData);
    await message.update({ content });
    return;
  }

  const templateData = {
    actor,
    weapon,
    diceTooltip: cd.diceTooltip ?? {},
    shock_roll: cd.shock_roll ?? null,
    shock_content: cd.shock_content ?? null,
    ammoRatio: cd.ammoRatio ?? 0,
    traumaRollRender: cd.traumaRollRender ?? null,
    traumaDamage: cd.traumaDamage ?? null,
    gearCondition: cd.gearCondition ?? null,
    targetResults: f.targetResults ?? [],
  };

  const content = await foundry.applications.handlebars.renderTemplate(WEAPON_CARD_TEMPLATE, templateData);
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
function requestGMApply(row, message, power, revertSnapshot = null) {
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
    actorId: row.actorId,
    amount: row.amount,
    effects: row.effects ?? [],
    // When present, the GM reverts this snapshot before applying (reroll re-resolve).
    revertSnapshot: revertSnapshot ?? null,
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
    // Reroll re-resolve: undo the prior application before applying the new one.
    if (msg.revertSnapshot) {
      await revertTargetRow({
        snapshot: msg.revertSnapshot,
        sceneId: msg.sceneId,
        tokenId: msg.tokenId,
        actorId: msg.actorId,
      });
    }
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
    await rerenderCard(message);
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

/** Resolve the source item behind a card from whichever uuid flag it carries. */
async function resolveSourceItem(message) {
  const uuid = message.flags?.swnr?.powerUuid || message.flags?.swnr?.weaponUuid;
  if (!uuid) return null;
  try {
    return await fromUuid(uuid);
  } catch (_e) {
    return null;
  }
}

/** Apply a single row from its Apply button (owner/GM directly, else GM relay). */
export async function applyTargetFromButton(message, index) {
  const rows = foundry.utils.deepClone(message.flags?.swnr?.targetResults ?? []);
  const row = rows[index];
  if (!row || (row.status !== "manual" && row.status !== "pending")) return;

  const actor = game.actors.get(row.actorId);
  if ((actor?.isOwner ?? false) || game.user.isGM) {
    await applyTargetRow(row);
    row.status = "applied";
    ui.notifications?.info(game.i18n.format("swnr.power.notify.applied", { effect: row.amountLabel, target: row.name }));
  } else {
    const item = await resolveSourceItem(message);
    requestGMApply(row, message, item);
  }
  await message.setFlag("swnr", "targetResults", rows);
  await rerenderCard(message);
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
  await rerenderCard(message);
  ui.notifications?.info(game.i18n.format("swnr.power.notify.reverted", { target: row.name }));
}

/** GM-only: undo every applied row. */
export async function revertAllFromButton(message) {
  if (!game.user.isGM) return;
  const rows = foundry.utils.deepClone(message.flags?.swnr?.targetResults ?? []);
  let count = 0;
  for (const row of rows) {
    if (row.status !== "applied") continue;
    await revertTargetRow(row);
    row.status = "reverted";
    count++;
  }
  if (count) {
    await message.setFlag("swnr", "targetResults", rows);
    await rerenderCard(message);
    ui.notifications?.info(game.i18n.format("swnr.power.notify.revertedAll", { count }));
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
  await rerenderCard(message);
  ui.notifications?.info(game.i18n.format("swnr.power.notify.reapplied", { effect: row.amountLabel, target: row.name }));
}

/** GM-only: re-roll a row and re-apply. Dispatches on the target kind. */
export async function rerollFromButton(message, index) {
  if (!game.user.isGM) return;
  const kind = message.flags?.swnr?.targetKind ?? "power";
  if (kind === "weapon") return rerollWeaponRow(message, index);
  return rerollPowerRow(message, index);
}

/** GM-only: re-roll a power row's save, recompute the amount/effects, and re-apply. */
async function rerollPowerRow(message, index) {
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
  await rerenderCard(message);
  ui.notifications?.info(game.i18n.format("swnr.power.notify.rerolled", { target: row.name, effect: row.amountLabel }));
}

/**
 * GM-only: re-roll a single target's attack, recompute hit/shock/miss + amount,
 * and re-apply. The damage/shock/trauma totals were rolled once for the whole
 * attack and are reused from flags; only this target's to-hit is re-rolled.
 */
async function rerollWeaponRow(message, index) {
  const rows = foundry.utils.deepClone(message.flags?.swnr?.targetResults ?? []);
  const row = rows[index];
  if (!row) return;

  const f = message.flags?.swnr ?? {};
  const weapon = f.weaponUuid ? await fromUuid(f.weaponUuid) : null;
  if (!weapon?.system) return;

  // Suppression rerolls the Evasion save (+ CWN trauma), not a to-hit.
  if (f.suppress) return rerollSuppressionRow(message, rows, row);

  // Undo the existing application first (if any).
  if (row.status === "applied" && row.snapshot) await revertTargetRow(row);

  // Re-roll a fresh attack for this one target from the stored attack spec.
  const attackRoll = new Roll(f.attackDieString || "1d20", f.attackRollData ?? {});
  await attackRoll.roll();

  const actor = game.actors.get(row.actorId) ?? resolveToken(row.sceneId, row.tokenId)?.actor;
  const ctx = {
    attackTotal: attackRoll.total,
    mainDamage: f.mainDamage ?? 0,
    shockDamage: f.shockDamage ?? null,
    shockAC: f.shockAC ?? null,
    traumaTriggered: f.traumaTriggered ?? false,
    traumaDamage: f.traumaDamage ?? null,
    isMelee: f.isMelee ?? false,
  };
  const { hitLabel, base } = computeWeaponOutcome(ctx, actor);
  const saveType = weapon.system.save || null;
  const save = saveType && base > 0 && actor ? await rollSaveForActor(actor, saveType) : null;
  const amount = applyWeaponSave(weapon.system, base, save);
  row.save = save;
  row.amount = amount;
  row.amountLabel = weaponAmountLabel(amount, hitLabel);
  row.hitLabel = hitLabel;
  row.effects = hitLabel !== "miss" ? pickTargetEffects(weapon, save) : [];

  // Re-apply (GM can modify anything).
  await applyTargetRow(row);
  row.status = "applied";

  await message.setFlag("swnr", "targetResults", rows);
  await rerenderCard(message);
  ui.notifications?.info(game.i18n.format("swnr.weapon.targeting.notify.rerolled", { target: row.name, effect: row.amountLabel }));
}

/** GM-only: re-roll a suppression row's Evasion save (+ CWN trauma) and re-apply. */
async function rerollSuppressionRow(message, rows, row) {
  const f = message.flags?.swnr ?? {};
  const weapon = f.weaponUuid ? await fromUuid(f.weaponUuid) : null;
  if (!weapon) return;

  // Undo the existing application first (if any).
  if (row.status === "applied" && row.snapshot) await revertTargetRow(row);

  const actor = game.actors.get(row.actorId) ?? resolveToken(row.sceneId, row.tokenId)?.actor;
  const ctx = {
    damageTotal: f.damageTotal ?? 0,
    ruleset: f.ruleset ?? "swn",
    useTrauma: f.useTrauma ?? false,
    traumaDie: f.traumaDie ?? null,
    traumaRating: f.traumaRating ?? null,
  };
  const save = actor ? await rollSaveForActor(actor, "evasion") : { success: false };
  const { hitLabel, amount } = await computeSuppressionOutcome(ctx, save);
  row.save = save;
  row.amount = amount;
  row.amountLabel = suppressAmountLabel(amount, hitLabel);
  row.hitLabel = hitLabel;
  row.effects = hitLabel !== "saved" ? pickTargetEffects(weapon, save) : [];

  await applyTargetRow(row);
  row.status = "applied";

  await message.setFlag("swnr", "targetResults", rows);
  await rerenderCard(message);
  ui.notifications?.info(game.i18n.format("swnr.weapon.suppress.notify.rerolled", { target: row.name, effect: row.amountLabel }));
}

/** Apply every still-manual row. */
export async function applyAllFromButton(message) {
  const rows = foundry.utils.deepClone(message.flags?.swnr?.targetResults ?? []);
  const item = await resolveSourceItem(message);
  let changed = false;
  let appliedCount = 0;
  for (const row of rows) {
    if (row.status !== "manual" && row.status !== "pending") continue;
    const actor = game.actors.get(row.actorId);
    if ((actor?.isOwner ?? false) || game.user.isGM) {
      await applyTargetRow(row);
      row.status = "applied";
      appliedCount++;
    } else {
      requestGMApply(row, message, item);
    }
    changed = true;
  }
  if (changed) {
    await message.setFlag("swnr", "targetResults", rows);
    await rerenderCard(message);
    if (appliedCount) {
      ui.notifications?.info(game.i18n.format("swnr.power.notify.appliedAll", { count: appliedCount }));
    }
  }
}

/* -------------------------------------------- */
/* In-place shared-roll reroll                  */
/* -------------------------------------------- */

function safeRoll(formula, data) {
  return Roll.validate(formula) ? new Roll(formula, data) : new Roll("1d0");
}

/**
 * Re-roll a card's shared hit/damage/power die in place and re-resolve the
 * target table: the rolled total updates, and every already-applied row is
 * undone and re-applied against the new number (rows the user can't modify go
 * through the GM relay). Non-applied rows only get their displayed amount
 * recomputed. Available to any user.
 * @param {ChatMessage} message
 * @param {"hit"|"damage"|"power"} which
 */
export async function rerollSharedRoll(message, which) {
  const f = message.flags?.swnr ?? {};
  const kind = f.targetKind ?? "power";
  const rows = foundry.utils.deepClone(f.targetResults ?? []);
  if (!rows.length) return;

  const item = await resolveSourceItem(message);
  if (!item?.system) return;

  // Flag updates to persist alongside the re-resolved rows.
  const updates = {};
  let recompute; // async (row) => { amount, amountLabel, hitLabel, effects, save }

  if (kind === "weapon" && f.suppress) {
    // Suppression: re-roll the shared damage, re-resolve each Evasion outcome.
    const sd = f.suppressDamageData ?? { stat: 0, damageBonus: 0 };
    const roll = safeRoll(item.system.damage + " + @stat + @damageBonus", { stat: sd.stat, damageBonus: sd.damageBonus });
    await roll.roll();
    updates["flags.swnr.damageTotal"] = roll.total;
    updates["flags.swnr.weaponCardData.damageRoll"] = await roll.render();
    const ctx = {
      damageTotal: roll.total,
      ruleset: f.ruleset ?? "swn",
      useTrauma: f.useTrauma ?? false,
      traumaDie: f.traumaDie ?? null,
      traumaRating: f.traumaRating ?? null,
    };
    recompute = async (row) => {
      const { hitLabel, amount } = await computeSuppressionOutcome(ctx, row.save);
      return { amount, amountLabel: suppressAmountLabel(amount, hitLabel), hitLabel, effects: hitLabel !== "saved" ? pickTargetEffects(item, row.save) : [], save: row.save };
    };
  } else if (kind === "weapon" && which === "hit") {
    // Weapon to-hit: re-roll the attack, re-evaluate hit/shock/miss vs each AC.
    const roll = new Roll(f.attackDieString || "1d20", f.attackRollData ?? {});
    await roll.roll();
    updates["flags.swnr.attackTotal"] = roll.total;
    updates["flags.swnr.weaponCardData.diceTooltip.hit"] = await roll.render();
    const baseCtx = {
      attackTotal: roll.total,
      mainDamage: f.mainDamage ?? 0,
      shockDamage: f.shockDamage ?? null,
      shockAC: f.shockAC ?? null,
      traumaTriggered: f.traumaTriggered ?? false,
      traumaDamage: f.traumaDamage ?? null,
      isMelee: f.isMelee ?? false,
    };
    recompute = async (row) => {
      const actor = game.actors.get(row.actorId) ?? resolveToken(row.sceneId, row.tokenId)?.actor;
      const { hitLabel, base } = computeWeaponOutcome(baseCtx, actor);
      // Reuse the existing save; roll one only if a miss just became a hit.
      let save = row.save;
      if (base > 0 && item.system.save && !save && actor) save = await rollSaveForActor(actor, item.system.save);
      const amount = applyWeaponSave(item.system, base, save);
      return { amount, amountLabel: weaponAmountLabel(amount, hitLabel), hitLabel, effects: hitLabel !== "miss" ? pickTargetEffects(item, save) : [], save };
    };
  } else if (kind === "weapon" && which === "shock") {
    // Weapon shock: re-roll only the shock die; only shock-hit rows change.
    const shockFormula = item.system.shock.dmg + " + @stat" + (item.system.skillBoostsShock ? " + @damageBonus" : "");
    const roll = safeRoll(shockFormula, f.attackRollData ?? {});
    await roll.roll();
    const newShock = roll.total;
    updates["flags.swnr.shockDamage"] = newShock;
    updates["flags.swnr.weaponCardData.shock_roll"] = await roll.render();
    recompute = async (row) => {
      let base = 0;
      if (row.hitLabel === "shock") base = newShock;
      else if (row.hitLabel === "hit") base = f.traumaTriggered && f.traumaDamage != null ? f.traumaDamage : f.mainDamage;
      const amount = applyWeaponSave(item.system, base, row.save);
      return { amount, amountLabel: weaponAmountLabel(amount, row.hitLabel), hitLabel: row.hitLabel, effects: row.hitLabel !== "miss" ? pickTargetEffects(item, row.save) : [], save: row.save };
    };
  } else if (kind === "weapon") {
    // Weapon damage: re-roll main damage; hit/miss is unchanged, only hit-row amounts move.
    const roll = safeRoll(item.system.damage + " + @burstFire + @stat + @damageBonus", f.attackRollData ?? {});
    await roll.roll();
    const newMain = roll.total;
    const rating = item.system.trauma?.rating;
    const newTrauma = f.traumaTriggered && rating != null ? newMain * rating : null;
    updates["flags.swnr.mainDamage"] = newMain;
    if (newTrauma != null) updates["flags.swnr.traumaDamage"] = newTrauma;
    updates["flags.swnr.weaponCardData.diceTooltip.damage"] = await roll.render();
    recompute = async (row) => {
      let base = 0;
      if (row.hitLabel === "hit") base = newTrauma != null ? newTrauma : newMain;
      else if (row.hitLabel === "shock") base = f.shockDamage ?? 0;
      const amount = applyWeaponSave(item.system, base, row.save);
      return { amount, amountLabel: weaponAmountLabel(amount, row.hitLabel), hitLabel: row.hitLabel, effects: row.hitLabel !== "miss" ? pickTargetEffects(item, row.save) : [], save: row.save };
    };
  } else {
    // Power: re-roll the power roll, re-resolve amounts from the new total.
    const roll = new Roll(item.system.roll ? item.system.roll : "0");
    await roll.roll();
    updates["flags.swnr.powerRollTotal"] = roll.total;
    updates["flags.swnr.powerRollHTML"] = await roll.render();
    recompute = async (row) => {
      const amount = computeAmount(item.system, roll.total, row.save);
      return { amount, amountLabel: labelForAmount(amount), hitLabel: row.hitLabel, effects: pickTargetEffects(item, row.save), save: row.save };
    };
  }

  // Re-resolve rows: undo + reapply the applied ones; recompute numbers on the rest.
  for (const row of rows) {
    const rec = await recompute(row);
    // Isolation: a row this die didn't affect (same amount + outcome) is left untouched.
    if (rec.amount === row.amount && rec.hitLabel === row.hitLabel) continue;
    if (row.status === "applied") {
      const actor = game.actors.get(row.actorId);
      const canModify = (actor?.isOwner ?? false) || game.user.isGM;
      if (canModify) {
        await revertTargetRow(row); // clears row.snapshot
        Object.assign(row, rec);
        await applyTargetRow(row);
        row.status = "applied";
      } else {
        const oldSnapshot = row.snapshot;
        Object.assign(row, rec);
        requestGMApply(row, message, item, oldSnapshot); // GM reverts old, applies new
      }
    } else {
      // Not applied: refresh the displayed amount only, leave HP/effects/status.
      row.amount = rec.amount;
      row.amountLabel = rec.amountLabel;
      row.hitLabel = rec.hitLabel;
    }
  }

  updates["flags.swnr.targetResults"] = rows;
  await message.update(updates);
  await rerenderCard(message);
}
