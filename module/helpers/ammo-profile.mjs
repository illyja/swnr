/**
 * Ammo profiles: per-variant stat changes carried by ammunition (slugs, sabot,
 * bean bags, ...). A box of loose rounds holds a profile in `system.ammoProfile`;
 * loading copies it onto the magazine (`system.ammoProfile`) or, for loose-ammo
 * weapons, onto the weapon (`system.ammo.profile`). The weapon then reads the
 * active profile through its effective* getters at attack time.
 *
 * Blank fields mean "use the weapon's own value", so an all-blank profile is
 * plain standard ammunition.
 */

import SWNShared from '../data/shared.mjs';

/** Schema for an ammo profile, shared by ammo items, magazines and weapons. */
export function defineAmmoProfileSchema() {
  const fields = foundry.data.fields;
  return new fields.SchemaField({
    // Short display name ("Slugs"). Blank = the source item's name.
    label: new fields.StringField({ required: true, blank: true, initial: "" }),
    // Replaces the weapon's damage dice. Blank = weapon's own.
    damage: SWNShared.diceString(""),
    // Added to the attack roll.
    hitMod: new fields.NumberField({ required: true, nullable: false, integer: true, initial: 0 }),
    // Replace the weapon's range bands. Null = weapon's own.
    rangeNormal: SWNShared.nullableNumber(),
    rangeMax: SWNShared.nullableNumber(),
    // Replace the weapon's trauma die / rating. Blank / null = weapon's own.
    traumaDie: SWNShared.diceString(""),
    traumaRating: SWNShared.nullableNumber(),
    // Drops a target to Unconscious rather than dying, unless trauma triggers.
    nonLethal: new fields.BooleanField({ initial: false }),
    // Targets wearing advanced armor take no damage from it.
    stoppedByAdvancedArmor: new fields.BooleanField({ initial: false }),
  });
}

/** Profile data meaning "standard ammunition". */
export function blankProfile() {
  return {
    label: "", damage: "", hitMod: 0, rangeNormal: null, rangeMax: null,
    traumaDie: "", traumaRating: null, nonLethal: false, stoppedByAdvancedArmor: false,
  };
}

/**
 * Stable key for comparing variants: two boxes with the same stats are the
 * same ammo, whatever they're called. "" for standard ammunition.
 * @param {object|null|undefined} profile
 * @returns {string}
 */
export function profileKey(profile) {
  const normalize = (p) => JSON.stringify([
    (p?.damage ?? "").trim(),
    Number(p?.hitMod) || 0,
    p?.rangeNormal ?? null,
    p?.rangeMax ?? null,
    (p?.traumaDie ?? "").trim(),
    p?.traumaRating ?? null,
    !!p?.nonLethal,
    !!p?.stoppedByAdvancedArmor,
  ]);
  const key = normalize(profile);
  return key === normalize(null) ? "" : key;
}

/** True when the profile changes nothing (standard ammunition). */
export function isBlankProfile(profile) {
  return profileKey(profile) === "";
}

/**
 * The profile a source item hands to whatever it's loaded into, with its
 * label defaulted to the item name. Standard ammunition yields a blank profile.
 * @param {Item} source  a loose-ammo box or a magazine
 * @returns {object}
 */
export function profileFromSource(source) {
  const p = source?.system?.ammoProfile;
  if (!p || isBlankProfile(p)) return blankProfile();
  return { ...blankProfile(), ...foundry.utils.deepClone(p), label: p.label || source.name };
}

/**
 * Caliber compatibility. A box with no caliber fits anything (generic rounds);
 * a box with a caliber only fits a receiver (weapon or magazine) of that caliber.
 * @param {string|null} boxCaliber
 * @param {string|null} receiverCaliber
 */
export function caliberFits(boxCaliber, receiverCaliber) {
  return !boxCaliber || boxCaliber === receiverCaliber;
}

/**
 * True when a target counts as wearing advanced armor: a readied, equipped
 * armor item flagged isAdvanced, or an NPC whose armor type is combat/powered.
 * @param {Actor} actor
 */
export function hasAdvancedArmor(actor) {
  if (!actor) return false;
  if (actor.type === "npc" && ["combat", "powered"].includes(actor.system?.armorType)) return true;
  return actor.items.some((i) => i.type === "armor"
    && i.system.use
    && i.system.location === "readied"
    && i.system.isAdvanced);
}
