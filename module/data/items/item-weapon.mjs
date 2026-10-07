import SWNBaseGearItem from './base-gear-item.mjs';
import SWNShared from '../shared.mjs';
import { applyChatMessageMode, getChatMessageMode } from '../../helpers/utils.mjs';
import { rememberEnabled, signedModifier } from '../../helpers/remember.mjs';
import { resolveWeaponTargets, resolveSuppressionTargets, applyTargetResults } from '../../helpers/power-targeting.mjs';
import { defineAmmoProfileSchema, isBlankProfile, migrateLegacyAmmoType } from '../../helpers/ammo-profile.mjs';

export default class SWNWeapon extends SWNBaseGearItem {
  static LOCALIZATION_PREFIXES = [
    'SWN.Item.base',
    'SWN.Item.Weapon',
  ];

  static defineSchema() {
    const fields = foundry.data.fields;
    const schema = super.defineSchema();
    schema.stat = SWNShared.stats("dex", false, true);
    schema.secondStat = SWNShared.stats(null, true, false);
    schema.skill = SWNShared.requiredString("ask");
    schema.skillBoostsDamage = new fields.BooleanField({ initial: false });
    schema.skillBoostsShock = new fields.BooleanField({ initial: false });
    schema.shock = new fields.SchemaField({
      dmg: SWNShared.diceString("0"),
      ac: SWNShared.requiredNumber(10),
    });
    schema.ab = SWNShared.diceString("0", true, false);
    schema.ammo = new fields.SchemaField({
      longReload: new fields.BooleanField({ initial: false }),
      suppress: new fields.BooleanField({ initial: false }),
      type: SWNShared.stringChoices("none", CONFIG.SWN.ammoTypes),
      max: SWNShared.requiredNumber(10),
      value: SWNShared.requiredNumber(10),
      burst: new fields.BooleanField({ initial: false }),
      // Preferred loose/bundle ammo source item (legacy "pour rounds" reload).
      current: new fields.DocumentIdField({ readonly: false }),
      // Magazine mode: the item id of the magazine currently loaded in the
      // weapon. When set, that item is the source of truth for loaded rounds
      // and capacity (see prepareDerivedData / consumeAmmo). Null = the weapon
      // uses loose/abstract ammo tracked directly on ammo.value.
      loadedMagazine: new fields.DocumentIdField({ readonly: false }),
      // Magazine compatibility key. When set, only magazines whose
      // uses.magClass matches (or is blank) can be loaded — per-weapon coupling.
      // Blank = accepts any magazine of the right ammo type (freeform).
      magClass: SWNShared.nullableString(),
      // What ammunition fits (e.g. "shotgun", "type-a-cell"). Must match the
      // rounds' / magazine's caliber exactly; blank = standard rounds.
      caliber: SWNShared.nullableString(),
      // Holds ammo only through a loaded magazine/cell: no loose rounds, and
      // empty without one (energy weapons). Characters and NPCs only.
      magazineOnly: new fields.BooleanField({ initial: false }),
      // Loose-ammo mode only: the variant of the rounds poured into ammo.value.
      // In magazine mode the loaded magazine's own ammoProfile applies instead.
      profile: defineAmmoProfileSchema(),
    });
    schema.range = new fields.SchemaField({
      normal: SWNShared.requiredNumber(1),
      max: SWNShared.requiredNumber(2),
    });
    schema.damage = SWNShared.diceString("1d6");
    schema.remember = new fields.SchemaField({
      use: new fields.BooleanField({ initial: false }),
      burst: new fields.BooleanField({ initial: false }),
      modifier: SWNShared.requiredNumber(0),
      isNonLethal: new fields.BooleanField({ initial: false }),
      // Remembered skill is kept here rather than overwriting `skill`, so
      // forgetting restores the weapon's own skill. Null falls back to `skill`.
      skill: SWNShared.nullableString(),
      // Stat picked in the dialog, only used when the weapon's stat is "ask".
      stat: SWNShared.nullableString(),
    });
    //schema.quantity = SWNShared.requiredNumber(1);
    schema.save = SWNShared.stringChoices(null, CONFIG.SWN.saveTypes, false);
    schema.trauma = new fields.SchemaField({
      die: SWNShared.diceString("1d6"),
      rating: SWNShared.nullableNumber(),
    });
    schema.isTwoHanded = new fields.BooleanField({ initial: false });
    schema.isNonLethal = new fields.BooleanField({ initial: false });
    schema.isMelee = new fields.BooleanField({ initial: false });

    // Targeted-effect automation (see helpers/power-targeting.mjs). Mirrors the
    // power fields minus effectKind (weapon amounts are always damage). Defaults
    // are inert: applyToTargets=false gates the whole pipeline.
    schema.applyToTargets = new fields.BooleanField({ initial: false });
    // What a successful save does to the amount (for weapons with a save, e.g.
    // grenades): nothing / negates it / halves it.
    schema.saveBehavior = SWNShared.stringChoices("none", CONFIG.SWN.powerSaveBehaviors);
    // When ActiveEffects flagged for targets are transferred, relative to the save.
    schema.effectApplyTiming = SWNShared.stringChoices("never", CONFIG.SWN.powerEffectTimings);

    return schema;
  }

  static migrateData(data) {

    if (data.trauma && (data.trauma.rating == "none" || data.trauma.rating == "")) {
      data.trauma.rating = null;
    }

    if (!(data.stat in CONFIG.SWN.stats)) {
      data.stat = "ask";
    }

    // Pre-caliber ammo types: the family becomes the caliber, and power-cell
    // weapons keep their "charge only from a loaded cell" rule.
    const legacy = migrateLegacyAmmoType(data.ammo, "type", "caliber");
    if (CONFIG.SWN.legacyCellAmmoTypes.includes(legacy) && data.ammo.magazineOnly === undefined) {
      data.ammo.magazineOnly = true;
    }

    return data;
  }

  /**
   * The magazine item currently loaded into this weapon, or null if the weapon
   * is not in magazine mode (loose/abstract ammo). Resolves against the owning
   * actor and validates the item is still a magazine-consumable.
   * @returns {Item|null}
   */
  get loadedMagazineItem() {
    const magId = this.ammo?.loadedMagazine;
    if (!magId) return null;
    const mag = this.parent?.actor?.items?.get(magId);
    if (!mag || mag.system?.uses?.consumable !== "magazine") return null;
    return mag;
  }

  /**
   * True when this weapon only holds ammo through a loaded magazine or cell
   * (the magazineOnly flag, e.g. energy weapons) and is carried by a character
   * or NPC. Vehicle-mounted weapons keep abstract charge.
   * @returns {boolean}
   */
  get requiresCell() {
    const actorType = this.parent?.actor?.type;
    return !!this.ammo?.magazineOnly
      && this.tracksAmmo
      && (actorType === "character" || actorType === "npc");
  }

  /** Limited ammo: a round count that is spent, reloaded and unloaded. */
  get tracksAmmo() {
    return this.ammo?.type === "ammo";
  }

  /** The weapon is itself the ammunition: using it spends one (grenades, mines). */
  get isDisposable() {
    return this.ammo?.type === "disposable";
  }

  /** Shows the reload control: limited (and, as before, unlimited) ammo. */
  get reloadable() {
    return this.ammo?.type === "ammo" || this.ammo?.type === "infinite";
  }

  prepareDerivedData() {
    super.prepareDerivedData();
    // In magazine mode the loaded magazine item owns the loaded-round count and
    // capacity. Mirror them onto ammo.value/ammo.max so every existing getter,
    // template, and chat card keeps reading ammo.value unchanged. In loose /
    // abstract mode (no loaded magazine) ammo.value stays authoritative —
    // except for energy weapons, which have no charge without a loaded cell.
    const mag = this.loadedMagazineItem;
    if (mag) {
      this.ammo.value = mag.system.uses.value;
      this.ammo.max = mag.system.uses.max;
    } else if (this.requiresCell) {
      this.ammo.value = 0;
    }
  }

  /**
   * The ammo profile of the rounds currently loaded: the loaded magazine's, or
   * the weapon's own in loose-ammo mode. Null for standard ammunition.
   * These getters never write the overrides into damage/range/trauma, since
   * the weapon sheet would then save the ammo's stats as the weapon's own.
   * @returns {object|null}
   */
  get activeAmmoProfile() {
    const mag = this.loadedMagazineItem;
    const profile = mag ? mag.system.ammoProfile : this.ammo?.profile;
    return profile && !isBlankProfile(profile) ? profile : null;
  }

  /** Display name of the loaded ammo variant, or null for standard rounds. */
  get ammoLabel() {
    const p = this.activeAmmoProfile;
    if (!p) return null;
    return p.label || this.loadedMagazineItem?.name || game.i18n.localize("swnr.ammoProfile.special");
  }

  get effectiveDamage() {
    return this.activeAmmoProfile?.damage || this.damage;
  }

  get ammoHitMod() {
    return this.activeAmmoProfile?.hitMod || 0;
  }

  get effectiveRange() {
    const p = this.activeAmmoProfile;
    return {
      normal: p?.rangeNormal ?? this.range.normal,
      max: p?.rangeMax ?? this.range.max,
    };
  }

  get effectiveTrauma() {
    const p = this.activeAmmoProfile;
    return {
      die: p?.traumaDie || this.trauma.die,
      rating: p?.traumaRating ?? this.trauma.rating,
    };
  }

  /** Hits drop targets to Unconscious rather than dying (unless trauma triggers). */
  get attackIsNonLethal() {
    return !!this.isNonLethal || !!this.activeAmmoProfile?.nonLethal;
  }

  /** Notification text for a weapon that can't fire for lack of ammo. */
  get outOfAmmoMessage() {
    const name = this.parent?.name ?? "";
    return this.requiresCell && !this.loadedMagazineItem
      ? game.i18n.format("swnr.weapon.needsCell", { name })
      : `Your ${name} is out of ammo!`;
  }

  /**
   * Spend ammunition for a shot/burst/suppression. In magazine mode this
   * decrements the loaded magazine item (so a swapped-out magazine retains its
   * remaining rounds); otherwise it decrements the weapon's own ammo.value.
   * No-op for none/infinite ammo types.
   * @param {number} rounds
   */
  async consumeAmmo(rounds) {
    if (!rounds || rounds <= 0) return;
    if (!this.tracksAmmo) return;
    const mag = this.loadedMagazineItem;
    if (mag) {
      const newVal = Math.max(0, mag.system.uses.value - rounds);
      await mag.update({ "system.uses.value": newVal });
    } else {
      const newVal = Math.max(0, this.ammo.value - rounds);
      await this.parent.update({ "system.ammo.value": newVal });
    }
  }

  /** The `system.remember` value for a weapon with nothing remembered. */
  static forgottenRemember() {
    return { use: false, burst: false, modifier: 0, isNonLethal: false, skill: null, stat: null };
  }

  /** Remembered settings are set and the world allows them. */
  get rememberActive() {
    return !!this.remember?.use && rememberEnabled();
  }

  get rememberedSkill() {
    return this.remember?.skill ?? this.skill;
  }

  /** Human-readable summary, e.g. "Shoot · Burst · +1". */
  get rememberSummary() {
    const skillName = this.parent?.actor?.items.get(this.rememberedSkill)?.name;
    const stat = this.stat === "ask" ? this.remember?.stat : null;
    return [
      skillName,
      stat ? game.i18n.localize(`swnr.stat.short.${stat}`) : null,
      this.remember?.burst ? game.i18n.localize("swnr.remember.burst") : null,
      signedModifier(this.remember?.modifier),
    ].filter(Boolean).join(" · ");
  }

  async forgetRemembered({ notify = true } = {}) {
    await this.parent.update({ "system.remember": this.constructor.forgottenRemember() });
    if (notify) {
      ui.notifications?.info(
        game.i18n.format("swnr.remember.forgotten", { name: this.parent.name })
      );
    }
  }

  get canBurstFire() {
    return (
      this.ammo.burst &&
      (this.ammo.type === "infinite" ||
        (this.tracksAmmo && this.ammo.value >= 3))
    );
  }

  get hasAmmo() {
    if (this.isDisposable) return (this.quantity ?? 1) > 0;
    return (
      this.ammo.type === "none" ||
      this.ammo.type === "infinite" ||
      this.ammo.value > 0
    );
  }

  /**
   * Spend one use of a disposable weapon: one off the stack, and the last one
   * is removed (like an emptied box of loose rounds). Called after the attack's
   * chat message exists, since that still needs the item.
   */
  async spendDisposable() {
    const item = this.parent;
    if (!this.isDisposable || !item?.actor) return;
    const qty = this.quantity ?? 1;
    if (qty > 1) {
      await item.update({ "system.quantity": qty - 1 });
    } else {
      ui.notifications?.info(game.i18n.format("swnr.weapon.disposableUsedUp", { name: item.name }));
      await item.delete();
    }
  }

  safeDamageRoll(damageRoll) {
    if (!Roll.validate(damageRoll.formula)) {
      damageRoll = new Roll("1d0");
    }
    return damageRoll;
  };

  async rollAttack(
    damageBonus, // number
    stat, // number
    skillMod, // number
    modifier, // number
    useBurst // boolean
  ) {
    let item = this.parent;
    const actor = item.actor;

    if (!actor) {
      const message = `Called rollAttack on item without an actor.`;
      ui.notifications?.error(message);
      throw new Error(message);
    }
    if (!this.hasAmmo) {
      ui.notifications?.error(this.outOfAmmoMessage);
      return;
    }
    if (
      useBurst &&
      this.ammo.type !== "infinite" &&
      (this.ammo.type !== "ammo" || this.ammo.value < 3)
    ) {
      ui.notifications?.error(
        `Your ${item.name} is does not have enough ammo to burst!`
      );
      return;
    }
    const template = "systems/swnr/templates/chat/attack-roll.hbs";
    const burstFire = useBurst ? 2 : 0;
    // Read the loaded ammo variant up front: firing may empty the magazine.
    const ammoProfile = this.activeAmmoProfile;
    const ammoLabel = this.ammoLabel;
    const trauma = this.effectiveTrauma;
    const nonLethal = this.attackIsNonLethal;
    const stoppedByAdvancedArmor = !!ammoProfile?.stoppedByAdvancedArmor;
    const attackRollDie = game.settings.get("swnr", "attackRoll");
    let gearCondition = null;
    if (game.settings.get("swnr", "useAWNGearCondition")) {
      gearCondition = this.condition;
    }
    const rollData = {
      actor: actor.getRollData(),
      weapon: this,
      hitRoll: undefined,
      stat,
      burstFire,
      modifier,
      damageBonus,
      effectiveSkillRank: skillMod < 0 ? -2 : skillMod,
      attackRollDie,
      ammoMod: this.ammoHitMod,
    };
    let hitExplainTip = "1d20 +burst +mod +CharAB +WpnAB +Stat +Skill +Ammo";
    let dieString =
      "@attackRollDie + @burstFire + @modifier + @actor.ab + @weapon.ab + @stat + @effectiveSkillRank + @ammoMod";

    // if using CWN armor and NPC grab melee AB.
    const useA = game.settings.get("swnr", "useCWNArmor") ? true : false;
    if (useA && item.system.isMelee && actor.type == "npc") {
      dieString =
        "@attackRollDie + @burstFire + @modifier + @actor.meleeAb + @weapon.ab + @stat + @effectiveSkillRank + @ammoMod";
      hitExplainTip = "1d20 +burst +mod +CharMeleeAB +WpnAB +Stat +Skill +Ammo";
    }
    let hitRoll = new Roll(dieString, rollData);
    hitRoll = this.safeDamageRoll(hitRoll);
    await hitRoll.roll();
    rollData.hitRoll = +(hitRoll.dice[0].total?.toString() ?? 0);

    let traumaRollRender = null;
    let traumaDamage = null;
    let traumaRoll = null;
    let traumaRating = null;
    let useTrauma = (game.settings.get("swnr", "useTrauma") ? true : false);
    let damageRoll = null;
    // Numeric captures for target automation (see helpers/power-targeting.mjs).
    let traumaTriggered = false;
    let traumaDamageValue = null;
    let shockDamageValue = null;

    const rollArray = [hitRoll];

    const damageExplainTip = "roll +burst +statBonus +dmgBonus";
    const damageFormula = this.effectiveDamage + " + @burstFire + @stat + @damageBonus";
    damageRoll = new Roll(damageFormula, rollData);

    let diceTooltip = {
      hitExplain: hitExplainTip,
      hit: await hitRoll.render(),
      damage: null,
      damageFormula: damageRoll.formula,
      damageExplain: damageExplainTip,
    };


    // Roll Damage automatically if the setting is enabled
    const damageRollEnabled = game.settings.get("swnr", "damageRoll");
    if (damageRollEnabled) {

      damageRoll = this.safeDamageRoll(damageRoll);
      await damageRoll.roll();
      diceTooltip.damage = await damageRoll.render();

      if (
        useTrauma &&
        trauma.die != null &&
        trauma.die !== "none" &&
        trauma.rating != null
      ) {
        traumaRoll = new Roll(trauma.die);
        await traumaRoll.roll();
        traumaRollRender = await traumaRoll.render();
        if (
          traumaRoll &&
          traumaRoll.total &&
          traumaRoll.total >= 6 &&
          damageRoll?.total
        ) {
          const traumaDamageRoll = new Roll(
            `${damageRoll.total} * ${trauma.rating}`
          );
          await traumaDamageRoll.roll();
          traumaDamage = await traumaDamageRoll.render();
          traumaTriggered = true;
          traumaDamageValue = traumaDamageRoll.total;
        }
      }
    } // End of Damage Roll if setting is enabled
    else {
      if (
        useTrauma &&
        trauma.die != null &&
        trauma.die !== "none" &&
        trauma.rating != null
      ) {
        traumaRoll = new Roll(trauma.die);
        traumaRating = trauma.rating;
      }
    } // end of no damage roll setting
    // Placeholder for shock damage
    let shock_content = null;
    let shockAC = null;
    let shockFormula = null;
    let shock_roll = null;
    // Show shock damage
    if (game.settings.get("swnr", "addShockMessage")) {
      const npcShock = actor?.type === "npc" ? actor.system.attacks.shock : null;
      if (npcShock?.dmg && npcShock.dmg !== "0") {
        shockFormula = `${npcShock.dmg}`;
      } else if (
        this.shock &&
        this.shock.dmg != null &&
        this.shock.dmg != "" &&
        this.shock.dmg != "0"
      ) {
        shockFormula =
          this.shock.dmg +
          " + @stat " +
          (this.skillBoostsShock ? ` + ${damageBonus}` : "");
      }

      if (shockFormula) {
        if (actor?.type == "npc" && actor.system.attacks.shock.ac) {
          shockAC = Number(actor.system.attacks.shock.ac);
        } else {
          shockAC = Number(this.shock.ac);
        }
        shock_content = `Shock Damage  AC ${shockAC}`;

        let _shockRoll = new Roll(shockFormula, rollData);
        _shockRoll = this.safeDamageRoll(_shockRoll);
        await _shockRoll.roll();
        shock_roll = await _shockRoll.render();
        shockDamageValue = _shockRoll.total;
        rollArray.push(_shockRoll);
      }
    }

    // Resolve targeted-effect rows (null unless applyToTargets + user has targets).
    // Requires the damage roll to have happened (deferred damage skips targeting).
    const shockConfigured = shock_content != null;
    let targetResults = null;
    if (damageRollEnabled && this.applyToTargets) {
      const targetCtx = {
        attackTotal: hitRoll.total,
        mainDamage: damageRoll?.total ?? 0,
        shockDamage: shockDamageValue,
        shockAC: shockConfigured ? shockAC : null,
        traumaTriggered,
        traumaDamage: traumaDamageValue,
        isMelee: this.isMelee,
        nonLethal,
        stoppedByAdvancedArmor,
      };
      targetResults = await resolveWeaponTargets(this.parent, targetCtx);
    }

    // Compact, JSON-safe attack spec so a GM reroll can re-roll one target's hit.
    const attackRollData = {
      attackRollDie,
      burstFire,
      modifier,
      stat,
      damageBonus,
      effectiveSkillRank: rollData.effectiveSkillRank,
      ammoMod: rollData.ammoMod,
      actor: { ab: rollData.actor?.ab ?? 0, meleeAb: rollData.actor?.meleeAb ?? 0 },
      weapon: { ab: this.ab },
    };

    const dialogData = {
      actor,
      weapon: this.parent,
      hitRoll,
      stat,
      damageRoll,
      burstFire,
      modifier,
      effectiveSkillRank: rollData.effectiveSkillRank,
      diceTooltip,
      ammoRatio: Math.clamp(
        Math.floor((this.ammo.value * 20) / this.ammo.max),
        0,
        20
      ),
      shock_roll,
      shock_content,
      traumaDamage,
      traumaRollRender,
      gearCondition,
      targetResults,
      ammoLabel,
      nonLethal,
    };
    const rollMode = getChatMessageMode();
    const diceData = Roll.fromTerms([foundry.dice.terms.PoolTerm.fromRolls(rollArray)]);
    if (this.tracksAmmo) {
      const spent = 1 + burstFire;
      const projected = Math.max(0, this.ammo.value - spent);
      await this.consumeAmmo(spent);
      if (projected === 0)
        ui.notifications?.warn(`Your ${item.name} is now out of ammo!`);
    }
    const chatContent = await foundry.applications.handlebars.renderTemplate(template, dialogData);
    const chatData = {
      speaker: ChatMessage.getSpeaker({ actor: actor ?? undefined }),
      rolls: rollArray, // Added for dice so nice trigger. 
      content: chatContent
    };
    if (!damageRollEnabled) {
      chatData.flags = {
        "swnr": {
          "damageRoll": {
            "formula": damageRoll.formula,
            "damageExplain": damageExplainTip,
            "actorId": actor.id,
            "flavor": `Damage roll for ${dialogData.weapon.name}`,
            "weaponId": this.id,
            "traumaFormula": traumaRoll?.formula || null,
            "traumaRating": traumaRating,
            "ammoLabel": ammoLabel,
            "nonLethal": nonLethal,
          },
        }
      };
    }
    // Persist everything the target table needs to re-render without re-rolling.
    if (targetResults) {
      chatData.flags = foundry.utils.mergeObject(chatData.flags ?? {}, {
        swnr: {
          targetKind: "weapon",
          weaponUuid: this.parent.uuid,
          actorId: actor?.id ?? null,
          attackDieString: dieString,
          attackRollData,
          mainDamage: damageRoll?.total ?? 0,
          shockDamage: shockDamageValue,
          shockFormula,
          shockAC: shockConfigured ? shockAC : null,
          traumaTriggered,
          traumaDamage: traumaDamageValue,
          isMelee: this.isMelee,
          // Snapshot of the ammo variant fired, so rerolls after a magazine
          // swap still use these stats rather than the weapon's current ones.
          damageFormula,
          traumaRating: trauma.rating,
          nonLethal,
          stoppedByAdvancedArmor,
          targetResults,
          weaponCardData: {
            diceTooltip,
            shock_roll,
            shock_content,
            ammoRatio: dialogData.ammoRatio,
            traumaRollRender,
            traumaDamage,
            gearCondition,
            ammoLabel,
            nonLethal,
          },
        },
      });
    }
    applyChatMessageMode(chatData, rollMode);
    const chatMessage = await getDocumentClass("ChatMessage").create(chatData);

    // Apply resolved targets (owned directly; others fall back to GM relay).
    if (targetResults && chatMessage) {
      await applyTargetResults(chatMessage, this.parent);
    }
    await this.spendDisposable();
  }

  /**
   * Suppressive fire: auto-hit every targeted (eligible) token for half the
   * weapon's damage; a successful Evasion save negates it. SWN rounds the half
   * down; CWN rounds up and rolls the Trauma Die per victim (Traumatic Hits).
   * Cover eligibility is DM fiat via which tokens are targeted. Spends double ammo.
   * @param {number} damageBonus
   * @param {number} stat - the attacker's damage stat mod
   * @param {number} _modifier - unused (suppression auto-hits); kept for call parity
   */
  async rollSuppression(damageBonus, stat, _modifier) {
    const item = this.parent;
    const actor = item.actor;
    if (!actor) return;

    const ruleset = game.settings.get("swnr", "suppressiveFire");
    if (ruleset === "off") return;
    if (!this.ammo.suppress) {
      ui.notifications?.error(`${item.name} cannot fire to suppress.`);
      return;
    }
    if (!this.hasAmmo) {
      ui.notifications?.error(this.outOfAmmoMessage);
      return;
    }

    // Suppression spends double the usual single-shot ammunition (2 rounds).
    const SUPPRESS_COST = 2;
    const finiteAmmo = this.tracksAmmo;
    if (finiteAmmo && this.ammo.value < SUPPRESS_COST) {
      ui.notifications?.error(`Your ${item.name} does not have enough ammo to suppress!`);
      return;
    }

    if (!game.user?.targets?.size) {
      ui.notifications?.warn("Target the tokens caught in the suppression (not under hard cover), then fire.");
      return;
    }

    const rollData = { actor: actor.getRollData(), weapon: this, stat, damageBonus };
    const trauma = this.effectiveTrauma;
    const ammoLabel = this.ammoLabel;
    const damageFormula = this.effectiveDamage + " + @stat + @damageBonus";
    let damageRoll = new Roll(damageFormula, rollData);
    damageRoll = this.safeDamageRoll(damageRoll);
    await damageRoll.roll();
    const damageRender = await damageRoll.render();

    const ctx = {
      damageTotal: damageRoll.total,
      ruleset,
      useTrauma: game.settings.get("swnr", "useTrauma") ? true : false,
      traumaDie: trauma.die ?? null,
      traumaRating: trauma.rating ?? null,
      nonLethal: this.attackIsNonLethal,
      stoppedByAdvancedArmor: !!this.activeAmmoProfile?.stoppedByAdvancedArmor,
    };
    const targetResults = await resolveSuppressionTargets(item, ctx);
    if (!targetResults) return;

    // Spend double ammo.
    const ammoSpent = finiteAmmo ? SUPPRESS_COST : 0;
    if (finiteAmmo) {
      const projected = Math.max(0, this.ammo.value - SUPPRESS_COST);
      await this.consumeAmmo(SUPPRESS_COST);
      if (projected === 0) ui.notifications?.warn(`Your ${item.name} is now out of ammo!`);
    }

    const template = "systems/swnr/templates/chat/suppress-fire.hbs";
    const cardData = {
      actor,
      weapon: item,
      suppress: true,
      ruleset,
      damageRoll: damageRender,
      ammoSpent,
      targetResults,
      ammoLabel,
      nonLethal: ctx.nonLethal,
    };
    const chatContent = await foundry.applications.handlebars.renderTemplate(template, cardData);
    const rollMode = getChatMessageMode();
    const chatData = {
      speaker: ChatMessage.getSpeaker({ actor: actor ?? undefined }),
      content: chatContent,
      roll: JSON.stringify(damageRoll),
      rolls: [damageRoll],
      flags: {
        swnr: {
          targetKind: "weapon",
          suppress: true,
          ruleset,
          weaponUuid: item.uuid,
          actorId: actor?.id ?? null,
          damageTotal: damageRoll.total,
          useTrauma: ctx.useTrauma,
          traumaDie: ctx.traumaDie,
          traumaRating: ctx.traumaRating,
          damageFormula,
          nonLethal: ctx.nonLethal,
          stoppedByAdvancedArmor: ctx.stoppedByAdvancedArmor,
          suppressDamageData: { stat, damageBonus },
          targetResults,
          weaponCardData: { damageRoll: damageRender, ammoSpent, ammoLabel, nonLethal: ctx.nonLethal },
        },
      },
    };
    applyChatMessageMode(chatData, rollMode);
    const chatMessage = await getDocumentClass("ChatMessage").create(chatData);

    if (chatMessage) await applyTargetResults(chatMessage, item);
  }

  async roll(shiftKey = false) {
    let item = this.parent;
    const actor = item.actor;

    if (!actor) {
      const message = `Called weapon.roll on item without an actor.`;
      ui.notifications?.error(message);
      new Error(message);
      return;
    }
    if (!this.hasAmmo) {
      ui.notifications?.error(this.outOfAmmoMessage);
      return;
    }

    const title = game.i18n.format("swnr.dialog.attackRoll", {
      actorName: actor.name,
      weaponName: item.name,
    });
    const ammo = this.ammo;
    const burstFireHasAmmo =
      ammo.type !== "none" && !this.isDisposable && ammo.burst && ammo.value >= 3;
    // Suppressive fire is offered when the world rule is on and the weapon supports it.
    const canSuppress =
      game.settings.get("swnr", "suppressiveFire") !== "off" && ammo.suppress && !this.isDisposable;

    let dmgBonus = 0;

    // for finesse weapons take the stat with the higher mod
    let statName = this.stat;
    const secStatName = this.secondStat;
    // check if there is 2nd stat name and its mod is better
    if (
      actor.type == "character" &&
      statName != "ask" &&
      secStatName != null &&
      secStatName != "none" &&
      actor.system["stats"]?.[statName]?.mod <
      actor.system["stats"]?.[secStatName].mod
    ) {
      statName = secStatName;
    }

    // A weapon set to "ask" for its stat quick-rolls with the remembered
    // stat; older remembered weapons without one fall through to the dialog.
    const quickStatName = statName === "ask" ? this.remember?.stat : statName;

    // Set to not ask and just roll
    if (!shiftKey && this.rememberActive && quickStatName) {
      const stat = actor.system["stats"]?.[quickStatName] || {
        mod: 0,
      };

      const skill = actor.getEmbeddedDocument(
        "Item",
        this.rememberedSkill
      );
      let skillMod = -2;
      if (skill) {
        skillMod = skill?.system.rank < 0 ? -2 : skill.system.rank;
      } else {
        ui.notifications?.info("No skill found, using -2. Unsetting remember.");
        await this.forgetRemembered({ notify: false });
      }

      if (actor?.type == "character") {
        dmgBonus = this.skillBoostsDamage ? (skill?.system.rank ?? 0) : 0;
      }
      return this.rollAttack(
        dmgBonus,
        stat.mod,
        skillMod,
        this.remember.modifier,
        this.remember.burst
      );
    }

    // Pre-fill the dialog with the remembered settings (shift+click on a
    // remembered weapon), otherwise with the weapon's own defaults.
    const remembered = this.rememberActive;
    const dialogData = {
      actor: actor,
      weapon: this,
      skills: actor.itemTypes.skill,
      statName: statName,
      selectedStat: remembered ? this.remember.stat : null,
      skill: remembered ? this.rememberedSkill : this.skill,
      modifier: remembered ? this.remember.modifier : 0,
      burstChecked: burstFireHasAmmo && (!remembered || this.remember.burst),
      burstFireHasAmmo,
      canSuppress,
      stats: actor.system.stats,
      allowRemember: rememberEnabled() && actor.type == "character",
      rememberChecked: remembered,
    };
    const template = "systems/swnr/templates/dialogs/roll-attack.hbs";
    const html = await foundry.applications.handlebars.renderTemplate(template, dialogData);

    const _rollForm = async (_event, button, html) => {
      const modifier = parseInt(button.form.elements.modifier.value);
      const burstFire = (button.form.elements.burstFire?.checked) ? true : false;
      const suppress = (button.form.elements.suppress?.checked) ? true : false;
      const skillId = button.form.elements.skill?.value || this.skill;

      if (!actor) {
        console.log("Error actor no longer exists ");
        return;
      }
      let skillMod = 0;

      const skill = actor.getEmbeddedDocument(
        "Item",
        skillId
      );

      if (actor?.type == "npc") {
        const npcSkillMod = button.form.elements.skilled?.checked ? actor.system.skillBonus : 0;
        if (npcSkillMod) skillMod = npcSkillMod;
      } else if (skill) {
        skillMod = skill.system.rank < 0 ? -2 : skill.system.rank;
      } else {
        skillMod = -2;
      }
      // for finesse weapons take the stat with the higher mod
      let statName = this.stat;
      const secStatName = this.secondStat;
      // check if there is 2nd stat name and its mod is better
      if (
        actor?.type == "character" &&
        statName != "ask" && 
        secStatName != null &&
        secStatName != "none" &&
        actor.system.stats[statName].mod <
        actor.system.stats[secStatName].mod
      ) {
        statName = secStatName;
      }
      // "ask" weapons use the stat picked in the dialog.
      const askedStat = statName === "ask" ? button.form.elements.stat?.value : null;
      if (askedStat) {
        statName = askedStat;
      }

      const stat = actor.system.stats?.[statName] || {
        mod: 0,
      };
      // 1d20 + attack bonus (PC plus weapon) + skill mod (-2 if untrained)
      // weapon dice + stat mod + skill if enabled or punch.
      // shock: damage + stat
      // const skill = actor.items.filter(w => w.)
      // Burst is +2 To hit and to damage
      if (actor?.type == "character") {
        dmgBonus = this.skillBoostsDamage ? skill.system.rank : 0;
      } else if (actor?.type == "npc") {
        dmgBonus = this.skillBoostsDamage
          ? actor.system.skillBonus
          : 0;
        if (actor.system.attacks.bonusDamage) {
          dmgBonus += actor.system.attacks.bonusDamage;
        }
      }
      // If remember is checked, set the skill and data
      // Unchecked on a remembered weapon: forget. (No checkbox for NPCs or
      // when the world disables the feature.)
      const rememberBox = button.form.elements.remember;
      if (rememberBox?.checked) {
        await this.parent.update({
          "system.remember": {
            use: true,
            burst: burstFire,
            modifier: modifier,
            skill: skillId,
            stat: askedStat,
          },
        });
      } else if (rememberBox && this.remember?.use) {
        await this.forgetRemembered();
      }

      // Suppressive fire is a distinct resolution (auto-hit, Evasion save, half damage).
      if (suppress) {
        return this.rollSuppression(dmgBonus, stat.mod, modifier);
      }

      return this.rollAttack(dmgBonus, stat.mod, skillMod, modifier, burstFire);
      // END roll form
    };

    const attackDialog = await foundry.applications.api.DialogV2.wait({
      window: { title: title },
      content: html,
      modal: false,
      rejectClose: false,
      buttons: [
        {
          label: game.i18n.localize("swnr.chat.roll"),
          callback: _rollForm,
        },
      ],
    });

  }
}
