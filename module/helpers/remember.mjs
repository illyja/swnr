/**
 * Shared helpers for "Remember settings for this roll" on skills and weapons.
 *
 * A remembered item skips its roll dialog and rolls with the stored settings.
 * The stored settings live entirely under `system.remember`, so forgetting
 * them never touches the item's own defaults.
 */

/** Whether the GM allows remembered roll settings in this world. */
export function rememberEnabled() {
  return game.settings.get("swnr", "rememberRollSettings") !== false;
}

/** Format a modifier with an explicit sign, e.g. "+2", "-1", "+0". */
export function signedModifier(value) {
  const n = Number(value) || 0;
  return n >= 0 ? `+${n}` : `${n}`;
}

/**
 * Clear remembered roll settings on every skill and weapon an actor owns.
 * @param {Actor} actor
 * @returns {Promise<number>} The number of items cleared
 */
export async function clearAllRemembered(actor) {
  const updates = actor.items
    .filter((i) => i.system?.remember?.use && typeof i.system.forgetRemembered === "function")
    .map((i) => ({ _id: i.id, "system.remember": i.system.constructor.forgottenRemember() }));
  if (updates.length) {await actor.updateEmbeddedDocuments("Item", updates);}
  return updates.length;
}
