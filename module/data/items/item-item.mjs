import SWNBaseGearItem from './base-gear-item.mjs';
import SWNShared from '../shared.mjs';
import { defineAmmoProfileSchema, migrateLegacyAmmoType } from '../../helpers/ammo-profile.mjs';

export default class SWNItemItem extends SWNBaseGearItem {
  static LOCALIZATION_PREFIXES = [
    'SWN.Item.base',
    'SWN.Item.Gear',
  ];

  static defineSchema() {
    const fields = foundry.data.fields;
    const requiredInteger = { required: true, nullable: false, integer: true };
    const schema = super.defineSchema();

    // Break down roll formula into three independent fields
    schema.roll = new fields.SchemaField({
      diceNum: SWNShared.nullableNumber(),
      diceSize: SWNShared.nullableString(),
      diceBonus: SWNShared.nullableString(),
    });
    // OLD roll
    // schema.roll = new fields.SchemaField({
    //   diceNum: new fields.NumberField({
    //     ...requiredInteger,
    //     initial: 1,
    //     min: 0,
    //   }),
    //   diceSize: new fields.StringField({ initial: 'd20' }),
    //   diceBonus: new fields.StringField({
    //     // initial: '+@str.mod+ceil(@lvl / 2)',
    //     initial: '+0',
    //   }),
    // });

    schema.formula = new fields.StringField({ blank: true });
    schema.uses = new fields.SchemaField({
      max: SWNShared.requiredNumber(1),
      value: SWNShared.requiredNumber(1),
      emptyQuantity: SWNShared.requiredNumber(0),
      consumable: SWNShared.stringChoices('none', CONFIG.SWN.itemConsumableTypes),
      ammo: SWNShared.stringChoices("none", CONFIG.SWN.itemAmmoTypes),
      // Magazine compatibility key (see weapon ammo.magClass). Blank = a
      // universal magazine that fits any weapon of the matching ammo type.
      magClass: SWNShared.nullableString(),
      // What these rounds / this magazine fit, e.g. "shotgun", "type-a-cell".
      // Must match the weapon's or magazine's caliber exactly; blank = standard rounds.
      caliber: SWNShared.nullableString(),
      keepEmpty: new fields.BooleanField({
        initial: true,
        required: true,
        nullable: false,
      }),
    });
    // Stat changes this ammunition gives the weapon it's fired from. On a
    // magazine it records the variant currently loaded (copied on load).
    schema.ammoProfile = defineAmmoProfileSchema();
    return schema;
  }

  static migrateData(data) {
    // Pre-caliber ammo types (power cells, missiles, ...) become calibers.
    migrateLegacyAmmoType(data.uses, "ammo", "caliber");
    if (data.uses?.ammo === "infinite") data.uses.ammo = "ammo";
    return super.migrateData(data);
  }

  /**
   * True when this item is a magazine: a self-contained clip whose uses.value
   * holds its own remaining rounds and uses.max its capacity. Magazines are
   * loaded into weapons and swapped by the reload system, retaining partial
   * round counts across swaps.
   * @returns {boolean}
   */
  get isMagazine() {
    return this.uses?.consumable === "magazine";
  }

  /**
   * True for loose ammunition: a `count` consumable tagged with an ammo type.
   * Unlike magazines, an emptied box of loose rounds is not kept.
   * @returns {boolean}
   */
  get isLooseAmmo() {
    return this.uses?.consumable === "count" && !!this.uses?.ammo && this.uses.ammo !== "none";
  }

  prepareDerivedData() {
    // Build the formula dynamically using string interpolation
    const roll = this.roll;
    if (roll) {
      if (roll.diceNum != null && roll.diceNum > 0)  {
        this.formula = `${roll.diceNum}${roll.diceSize}${roll.diceBonus}`;
      } else {
        this.formula = null;
      }

    }  else {
      this.formula = null;
    }
  }

  /**
   * Draw up to `n` loose rounds from this `count` consumable, spanning the
   * boxes in its stack. Exhausting a box is delegated to removeOneUse() so the
   * usual stack / keepEmpty / quantity bookkeeping applies.
   * @param {number} n  rounds wanted
   * @returns {Promise<number>} rounds actually drawn
   */
  async drawRounds(n) {
    const item = this.parent;
    let drawn = 0;
    for (let guard = 0; drawn < n && guard < 100; guard++) {
      const sys = item.system;
      const avail = sys.uses.value;
      if (avail <= 0 || sys.quantity <= 0) break;
      const take = Math.min(n - drawn, avail);
      if (take < avail) {
        await item.update({ "system.uses.value": avail - take });
        drawn += take;
        break;
      }
      // Emptying the current box: drop to its last round, then let
      // removeOneUse() move on to the next box in the stack (or remove it).
      if (avail > 1) await item.update({ "system.uses.value": 1 });
      await item.system.removeOneUse();
      drawn += take;
      // The last empty box of loose rounds is deleted; stop drawing from it.
      if (item.actor && !item.actor.items.has(item.id)) break;
    }
    return drawn;
  }

  async addOneUse() {
    let item = this.parent;
    // Magazines are reusable: just add a round, up to capacity.
    if (this.isMagazine) {
      if (this.uses.value < this.uses.max) await item.update({ "system.uses.value": this.uses.value + 1 });
      return;
    }
    if (item.type === "item" && this.uses.consumable !== "none") {
      const uses = this.uses;
      if (uses.value == 0 && this.uses.keepEmpty && this.uses.emptyQuantity > 0) {
        // If keepEmpty is true, just set to 1
        await item.update({ "system.uses.value": 1, "system.uses.emptyQuantity": this.uses.emptyQuantity - 1 });
        // for modifying qty, "system.quantity": this.quantity + 1 });
        ui.notifications?.info(
          `Removing an empty ${item.name} and adding uses.`
        );
      } else if (uses.value < uses.max) {
        await item.update({ "system.uses.value": uses.value + 1 });
      } else if (uses.value >= uses.max && this.uses.keepEmpty && this.uses.emptyQuantity > 0) {
        // start filling an emtpy item 
        await item.update({ "system.uses.value": 1, "system.uses.emptyQuantity": this.uses.emptyQuantity - 1 });
        ui.notifications?.info(
          `Removing an empty ${item.name} and adding uses.`
        );
      }
    } else {
      console.warn("Cannot add uses to non-item/gear type");
    }
  }

  async removeOneUse() {
    let item = this.parent;
    // Magazines are reusable: just remove a round. An empty magazine is always
    // kept in inventory, regardless of keepEmpty, so it can be refilled.
    if (this.isMagazine) {
      if (this.uses.value > 0) await item.update({ "system.uses.value": this.uses.value - 1 });
      return;
    }
    if (item.type === "item" && this.uses.consumable !== "none") {
      const uses = this.uses;
      if (uses.value > 1) {
        await item.update({ "system.uses.value": uses.value - 1 });
      } else if (uses.value == 1) {
        // Last one
        let newUses = 0;
        const remaining = this.quantity - this.uses.emptyQuantity;
        if (remaining > 1) {
          // If remaining is greater than 1, just reduce the quantity
          newUses = this.uses.max;
        }
        // Uses up the item
        if (this.uses.keepEmpty) {
          // If keepEmpty is true, just set to 0
          const emptyQuantity = this.uses.emptyQuantity || 0;
          await item.update({ "system.uses.value": newUses, "system.uses.emptyQuantity": emptyQuantity + 1 });
          // for updating qty, "system.quantity": this.quantity - 1 });
          ui.notifications?.info(
            `Adding an empty ${item.name}.`
          );
        } else {
          // If keepEmpty is false, remove the item
          if (this.quantity > 1) {
            // If quantity is greater than 1, just reduce the quantity
            await item.update({ "system.quantity": this.quantity - 1, "system.uses.value": newUses });
          } else if (this.isLooseAmmo && item.actor) {
            // An emptied box of loose rounds is discarded rather than kept.
            ui.notifications?.info(game.i18n.format("swnr.weapon.emptyAmmoRemoved", { name: item.name }));
            await item.delete();
          } else {
            ui.notifications?.info(
              `Setting item ${item.name} to quantity 0. Delete if no longer needed.`
            );
            await item.update({ "system.quantity": 0, "system.uses.value": 0 });

            // OLD CODE for deletintg the item
            // // If quantity is 1, delete the item
            // ui.notifications?.info(
            //   `Removing item ${item.name} as it has no uses left and it does not keep empties.`
            // );
            // await item.delete();
          }
        }
      }
    } else {
      console.warn("Cannot remove uses from non-item/gear type");
    }
  }
}
