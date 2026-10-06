const { api, sheets } = foundry.applications;
import { ContainerHelper } from '../helpers/container-helper.mjs';
import { getChatMessageMode } from '../helpers/utils.mjs';

/**
 * An actor's non-empty loose rounds (`count` consumables) of `ammoType`, in
 * draw order: readied items first, then partially used boxes before full ones
 * so fewer half-empty boxes remain.
 * @param {Actor} actor
 * @param {string} ammoType
 * @param {string|null} excludeId
 * @returns {Item[]}
 */
function looseRoundsFor(actor, ammoType, excludeId = null) {
  return actor.items
    .filter((i) => i.type === 'item'
      && i.system.uses?.consumable === 'count'
      && i.system.uses?.ammo === ammoType
      && i.id !== excludeId
      && i.system.uses.value > 0
      && i.system.quantity > 0)
    .sort((a, b) =>
      ((b.system.location === 'readied') - (a.system.location === 'readied'))
      || (a.system.uses.value - b.system.uses.value));
}

/**
 * Draw up to `needed` loose rounds of `ammoType` from an actor's inventory:
 * the preferred item first, then the rest in looseRoundsFor() order.
 * @param {Actor} actor
 * @param {string} ammoType
 * @param {number} needed
 * @param {Item|null} preferred
 * @returns {Promise<{drawn: number, used: {name: string, n: number}[]}>}
 */
async function drawLooseRounds(actor, ammoType, needed, preferred = null) {
  const others = looseRoundsFor(actor, ammoType, preferred?.id ?? null);
  const order = preferred ? [preferred, ...others] : others;
  let drawn = 0;
  const used = [];
  for (const src of order) {
    if (drawn >= needed) break;
    const n = await src.system.drawRounds(needed - drawn);
    if (n > 0) {
      drawn += n;
      used.push({ name: src.name, n });
    }
  }
  return { drawn, used };
}

const describeRounds = (used) => used.map((u) => `${u.n} from ${u.name}`).join(", ");

/**
 * Extend the basic ActorSheet with some very simple modifications
 * @extends {ActorSheetV2}
 */
export class SWNBaseSheet extends api.HandlebarsApplicationMixin(
  sheets.ActorSheetV2
) {
  #dragDrop;

  constructor(options = {}) {
    super(options);
    this.#dragDrop = this._createDragDropHandlers();
  }

  /* -------------------------------------------- */

  /**
   * Actions performed after any render of the Application.
   * Post-render steps are not awaited by the render process.
   * @param {ApplicationRenderContext} context      Prepared context data
   * @param {RenderOptions} options                 Provided render options
   * @protected
   * @override
   */
  _onRender(context, options) {
    this.#dragDrop.forEach((d) => d.bind(this.element));
    this._disableOverrides();
  }

  /**
   * Handle dropping of an item reference or item data onto an Actor Sheet
   * @param {DragEvent} event            The concluding DragEvent which contains drop data
   * @param {object} data                The data transfer extracted from the event
   * @returns {Promise<Item[]|boolean>}  The created or updated Item instances, or false if the drop was not permitted.
   * @protected
   */
  async _onDropItem(event, data) {
    if (!this.actor.isOwner) return false;
    const item = await Item.implementation.fromDropData(data);

    // Handle item sorting within the same Actor
    if (this.actor.uuid === item.parent?.uuid)
      return this._onSortItem(event, item);

    // Handle powers added to NPC 
    if (this.actor.type === "npc" && item.type === "power" && item.system.consumptions.length > 0) {
      for (const consumption of item.system.consumptions) {
        if (consumption.type == "poolResource") {
          this.actor.system.findOrCreatePool(consumption.resourceName, consumption.subResource);
        }
      }
    }
    // Toggle show power type on features tab
    if (this.actor.type === "character" && (item.type === "power" || item.type === "cyberware")) {
      const mapping = {
        "psychic": "showPsychic",
        "art": "showArts",
        "adept": "showAdept",
        "spell": "showSpells",
        "mutation": "showMutation",
        "cyberware": "showCyberware"
      }
      let propertyToUpdate = null;
      if (mapping[item.system.subType]) {
        propertyToUpdate = mapping[item.system.subType];
      } else if (item.type === "cyberware") {
        propertyToUpdate = mapping[item.type];
      }
      if (propertyToUpdate) {
        await this.actor.update({
          "system": {
            "tweak": {
              [propertyToUpdate]: true
            }
          }
        });
      }
    }

    // Create the owned item
    return this._onDropItemCreate(item, event);
  }

  /**
   * Handle dropping of a Folder on an Actor Sheet.
   * The core sheet currently supports dropping a Folder of Items to create all items as owned items.
   * @param {DragEvent} event     The concluding DragEvent which contains drop data
   * @param {object} data         The data transfer extracted from the event
   * @returns {Promise<Item[]>}
   * @protected
   */
  async _onDropFolder(event, data) {
    if (!this.actor.isOwner) return [];
    const folder = await Folder.implementation.fromDropData(data);
    if (folder.type !== 'Item') return [];
    const droppedItemData = await Promise.all(
      folder.contents.map(async (item) => {
        if (!(document instanceof Item)) item = await fromUuid(item.uuid);
        return item;
      })
    );
    return this._onDropItemCreate(droppedItemData, event);
  }

  /**
   * Handle the final creation of dropped Item data on the Actor.
   * This method is factored out to allow downstream classes the opportunity to override item creation behavior.
   * @param {object[]|object} itemData      The item data requested for creation
   * @param {DragEvent} event               The concluding DragEvent which provided the drop data
   * @returns {Promise<Item[]>}
   * @private
   */
  async _onDropItemCreate(itemData, event) {
    itemData = itemData instanceof Array ? itemData : [itemData];
    return this.actor.createEmbeddedDocuments('Item', itemData);
  }

  /**
   * Handle a drop event for an existing embedded Item to sort that Item relative to its siblings
   * @param {Event} event
   * @param {Item} item
   * @private
   */
  async _onSortItem(event, item) {
    // Get the drag source and drop target
    const items = this.actor.items;
    const dropTarget = event.target.closest('[data-item-id]');

    // Check if this is a container drop first (before checking for valid dropTarget)
    const containerInfo = ContainerHelper.getDropTargetContainer(event.target);
    if (containerInfo) {
      const container = items.get(containerInfo.itemId);
      if (container && container.id !== item.id) {
        // This is a drop onto a container, handle it specially
        return ContainerHelper.addItemToContainer(container, item);
      }
    }

    // Check if item is being removed from a container (dropped outside of containers)
    if (item.system.containerId) {
      // Item was in a container but dropped elsewhere, remove it from container
      await ContainerHelper.removeItemFromContainer(item);
    }

    // If no valid drop target, we're done (item was just removed from container)
    if (!dropTarget) return;
    const target = items.get(dropTarget.dataset.itemId);

    // Don't sort on yourself
    if (item.id === target.id) return;

    // Identify sibling items based on adjacent HTML elements
    const siblings = [];
    for (let el of dropTarget.parentElement.children) {
      const siblingId = el.dataset.itemId;
      if (siblingId && siblingId !== item.id)
        siblings.push(items.get(el.dataset.itemId));
    }

    // Perform the sort
    const sortUpdates = foundry.utils.SortingHelpers.performIntegerSort(item, {
      target,
      siblings,
    });
    const updateData = sortUpdates.map((u) => {
      const update = u.update;
      update._id = u.target._id;
      return update;
    });

    // Perform the update
    return this.actor.updateEmbeddedDocuments('Item', updateData);
  }

  /** The following pieces set up drag handling and are unlikely to need modification  */

  /**
   * Returns an array of DragDrop instances
   * @type {DragDrop[]}
   */
  get dragDrop() {
    return this.#dragDrop;
  }

  // This is marked as private because there's no real need
  // for subclasses or external hooks to mess with it directly

  /**
   * Create drag-and-drop workflow handlers for this Application
   * @returns {DragDrop[]}     An array of DragDrop handlers
   * @private
   */
  _createDragDropHandlers() {
    return this.options.dragDrop.map((d) => {
      d.permissions = {
        dragstart: this._canDragStart.bind(this),
        drop: this._canDragDrop.bind(this),
      };
      d.callbacks = {
        dragstart: this._onDragStart.bind(this),
        dragover: this._onDragOver.bind(this),
        dragleave: this._onDragLeave.bind(this),
        drop: this._onDrop.bind(this),
      };
      return new foundry.applications.ux.DragDrop.implementation(d);
    });
  }

  /** Helper Functions */

  /**
   * Fetches the embedded document representing the containing HTML element
   *
   * @param {HTMLElement} target    The element subject to search
   * @returns {Item | ActiveEffect} The embedded Item or ActiveEffect
   */
  _getEmbeddedDocument(target) {
    const docRow = target.closest('li[data-document-class]');
    if (docRow.dataset.documentClass === 'Item') {
      return this.actor.items.get(docRow.dataset.itemId);
    } else if (docRow.dataset.documentClass === 'ActiveEffect') {
      const parent =
        docRow.dataset.parentId === this.actor.id
          ? this.actor
          : this.actor.items.get(docRow?.dataset.parentId);
      return parent.effects.get(docRow?.dataset.effectId);
    } else return console.warn('Could not find document class');
  }

  /***************
   *
   * Shared Utils - Edit and Docs
   *
   ***************/

  /**
   * Handle changing a Document's image.
   *
   * @this SWNActorSheet
   * @param {PointerEvent} event   The originating click event
   * @param {HTMLElement} target   The capturing HTML element which defined a [data-action]
   * @returns {Promise}
   * @protected
   */
  static async _onEditImage(event, target) {
    const attr = target.dataset.edit;
    const current = foundry.utils.getProperty(this.document, attr);
    const { img } =
      this.document.constructor.getDefaultArtwork?.(this.document.toObject()) ??
      {};
    const fp = new FilePicker({
      current,
      type: 'image',
      redirectToRoot: img ? [img] : [],
      callback: (path) => {
        this.document.update({ [attr]: path });
      },
      top: this.position.top + 40,
      left: this.position.left + 10,
    });
    return fp.browse();
  }

  /**
   * Renders an embedded document's sheet
   *
   * @this SWNActorSheet
   * @param {PointerEvent} event   The originating click event
   * @param {HTMLElement} target   The capturing HTML element which defined a [data-action]
   * @protected
   */
  static async _viewDoc(event, target) {
    const doc = this._getEmbeddedDocument(target);
    doc.sheet.render(true);
  }

  /**
   * Handles item deletion
   *
   * @this SWNActorSheet
   * @param {PointerEvent} event   The originating click event
   * @param {HTMLElement} target   The capturing HTML element which defined a [data-action]
   * @protected
   */
  static async _deleteDoc(event, target) {
    const doc = this._getEmbeddedDocument(target);
    const skipConfirmation = target.dataset?.skipconfirmation?.toLowerCase() === "true";
    
    const executeDelete = async () => {
      // Clean up any consumed resources before deletion
      if (doc.type === "power") {
        await SWNBaseSheet._cleanupPowerResourcesBeforeDeletion(doc);
      }
      await doc.delete();
    }

    if (skipConfirmation) {
      await executeDelete();
      return;
    }
    
    await this._promptDelete(event, doc.name, doc.parent.name, executeDelete);
  }

  /**
   * Displays a prompt to confirm deletion
   * 
   * @param {PointerEvent} event  The originating click event
   * @param {String} name         The name of the item to delete
   * @param {String} parentName   The name of the parent of the deleted item
   * @param {Function} callback   The function to call on confirmed deletion
   * @protected
   */
  async _promptDelete(event, name, parentName, callback) {
    
    if (event.shiftKey){
      await callback();
      return;
    }
    
    await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.format("swnr.deleteTitle", { name: name}) },
      content: game.i18n.format("swnr.deleteContent", { name: name, actor: parentName}),
      yes: {
        callback: callback,
      }
    })
  }

  /**
   * Clean up any consumed resources before a power is deleted
   * @param {Item} power - The power being deleted
   * @private
   */
  static async _cleanupPowerResourcesBeforeDeletion(power) {
    try {
      const actor = power.parent;
      if (!actor || power.type !== "power") return;

      const pools = actor.system.pools || {};
      const poolUpdates = {};
      let restoredResources = [];

      // Check if power is prepared - restore preparation costs
      if (power.system.prepared) {
        const prepConsumptions = power.system.consumptions?.filter(c => c.spendOnPrep) || [];
        
        for (const consumption of prepConsumptions) {
          if (consumption.type === "poolResource" && consumption.resourceName) {
            const poolKey = `${consumption.resourceName}:${consumption.subResource || "Default"}`;
            const pool = pools[poolKey];
            
            if (pool && consumption.usesCost > 0) {
              const newValue = Math.min(pool.max, pool.value + consumption.usesCost);
              poolUpdates[`system.pools.${poolKey}.value`] = newValue;
              restoredResources.push(`${consumption.usesCost} ${consumption.resourceName}${consumption.subResource ? `:${consumption.subResource}` : ""} (prep cost)`);
            }
          }
        }
      }

      // Clean up any committed effort for this power
      const commitments = actor.system.effortCommitments || {};
      const newCommitments = {};
      let hasCommitmentChanges = false;

      for (const [poolKey, poolCommitments] of Object.entries(commitments)) {
        const remainingCommitments = poolCommitments.filter(c => c.powerId !== power.id);
        
        if (remainingCommitments.length !== poolCommitments.length) {
          // Some commitments were removed
          hasCommitmentChanges = true;
          newCommitments[poolKey] = remainingCommitments;
          
          // Calculate restored effort
          const releasedCommitments = poolCommitments.filter(c => c.powerId === power.id);
          const releasedAmount = releasedCommitments.reduce((sum, c) => sum + c.amount, 0);
          
          if (releasedAmount > 0 && pools[poolKey]) {
            const totalCommitted = remainingCommitments.reduce((sum, c) => sum + c.amount, 0);
            const newValue = Math.min(pools[poolKey].max, pools[poolKey].value + releasedAmount);
            
            poolUpdates[`system.pools.${poolKey}.value`] = newValue;
            poolUpdates[`system.pools.${poolKey}.committed`] = totalCommitted;
            poolUpdates[`system.pools.${poolKey}.commitments`] = remainingCommitments;
            
            restoredResources.push(`${releasedAmount} ${poolKey} (committed effort)`);
          }
        } else {
          newCommitments[poolKey] = poolCommitments;
        }
      }

      // Update commitments if changed
      if (hasCommitmentChanges) {
        poolUpdates["system.effortCommitments"] = newCommitments;
      }

      // Apply updates if any resources need to be restored
      if (Object.keys(poolUpdates).length > 0) {
        await actor.update(poolUpdates);
        
        // Create chat message about resource restoration
        if (restoredResources.length > 0) {
          let content = `<div class="power-deletion-cleanup">
            <h3><i class="fas fa-recycle"></i> Resources Restored</h3>
            <p><strong>${power.name}</strong> was deleted and the following resources were restored:</p>
            <ul>`;
          
          restoredResources.forEach(resource => {
            content += `<li>${resource}</li>`;
          });
          
          content += `</ul></div>`;
          
          ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ actor: actor }),
            content
          });
        }
      }
    } catch (error) {
      console.error("Error cleaning up power resources before deletion:", error);
      // Don't prevent deletion even if cleanup fails
    }
  }

  /**
   * Handle creating a new Owned Item or ActiveEffect for the actor using initial data defined in the HTML dataset
   *
   * @this SWNActorSheet
   * @param {PointerEvent} event   The originating click event
   * @param {HTMLElement} target   The capturing HTML element which defined a [data-action]
   * @private
   */
  static async _createDoc(event, target) {
    // Retrieve the configured document class for Item or ActiveEffect
    const docCls = getDocumentClass(target.dataset.documentClass);
    // Prepare the document creation data by initializing it a default name.
    const docData = {
      name: docCls.defaultName({
        // defaultName handles an undefined type gracefully
        type: target.dataset.type,
        parent: this.actor,
      }),
    };
    // Loop through the dataset and add it to our docData
    for (const [dataKey, value] of Object.entries(target.dataset)) {
      // These data attributes are reserved for the action handling
      if (['action', 'documentClass'].includes(dataKey)) continue;
      // Nested properties require dot notation in the HTML, e.g. anything with `system`
      // An example exists in spells.hbs, with `data-system.spell-level`
      // which turns into the dataKey 'system.spellLevel'
      foundry.utils.setProperty(docData, dataKey, value);
    }

    // Finally, create the embedded document!
    await docCls.create(docData, { parent: this.actor });
  }

  /**
   * Determines effect parent to pass to helper
   *
   * @this SWNActorSheet
   * @param {PointerEvent} event   The originating click event
   * @param {HTMLElement} target   The capturing HTML element which defined a [data-action]
   * @private
   */
  static async _toggleEffect(event, target) {
    const effect = this._getEmbeddedDocument(target);
    await effect.update({ disabled: !effect.disabled });
  }

  /**
   * Toggles a boolean property
   * 
   * @this SWNActorSheet
   * @param {PointerEvent} event   The originating click event
   * @param {HTMLElement} target   The capturing HTML element which defined a [data-action]
   * @private
   */
  static async _toggleProperty(event, target) {
    const item = this._getEmbeddedDocument(target);
    const property = target.dataset.property;
    const value = item.system[property];
    
    if (value === undefined) {
      console.log(`Unable to find ${property} property on item `, item.system);
    }
    
    if (typeof  value != "boolean"){
      console.log(`Property ${property} on item is not a boolean`);
    }

    await item.update({ [`system.${property}`]: !value });
  }

  /**
   * Handle clickable rolls.
   *
   * @this SWNActorSheet
   * @param {PointerEvent} event   The originating click event
   * @param {HTMLElement} target   The capturing HTML element which defined a [data-action]
   * @protected
   */
  static async _onRoll(event, target) {
    event.preventDefault();
    const dataset = target.dataset;

    // Handle item rolls.
    switch (dataset.rollType) {
      case 'item':
        const item = this._getEmbeddedDocument(target);
        if (item) return item.roll(event);
    }

    // Handle rolls that supply the formula directly.
    if (dataset.roll) {
      let label = dataset.label ? `[stat] ${dataset.label}` : '';
      let roll = new Roll(dataset.roll, this.actor.getRollData());
      await roll.toMessage({
        speaker: ChatMessage.getSpeaker({ actor: this.actor }),
        flavor: label,
        rollMode: getChatMessageMode(),
      });
      return roll;
    }
  }

  /**
   * Reload an item
   *
   * @this SWNActorSheet
   * @param {PointerEvent} event   The originating click event
   * @param {HTMLElement} target   The capturing HTML element which defined a [data-action]
   * @protected
   */
    static async _onReload(event, target) {
      const item = this._getEmbeddedDocument(target);
      if (!item || (item.type !== 'weapon' && item.type !== 'shipWeapon')) {
        ui.notifications.error("Only weapons can be reloaded.");
        return;
      }
      if (!item.system.ammo) {
        ui.notifications.error("This weapon does not use ammo.");
        return;
      }

      const ammoMax = item.system.ammo?.max;
      if (ammoMax == null) {
        console.log("Unable to find ammo max value in item", item.system);
        return;
      }

      const shift = event?.shiftKey || false;
      const ammoType = item.system.ammo.type;
      const loadedMagId = item.system.ammo.loadedMagazine;

      // Refill the current source to full without consuming stock (GM bypass /
      // ship weapons). In magazine mode this tops off the loaded magazine.
      const instantFill = async (bypassNote) => {
        const loadedMag = loadedMagId ? this.actor.items.get(loadedMagId) : null;
        if (loadedMag) {
          await loadedMag.update({ "system.uses.value": loadedMag.system.uses.max });
        } else {
          await item.update({ "system.ammo.value": ammoMax });
        }
        ChatMessage.create({
          speaker: ChatMessage.getSpeaker({ actor: this.actor }),
          content: `<p>Reloaded ${item.name}.${bypassNote}</p>`,
        });
      };

      // Shift-click or ship weapons bypass ammo/source tracking entirely.
      if (item.type === 'shipWeapon' || shift) {
        return instantFill(shift ? " (Shift-clicked to bypass checks)" : "");
      }

      // ── Magazine mode ──────────────────────────────────────────────────
      // Active when magazine-type ammo items of the matching type exist in
      // inventory (or one is already loaded). Reloading swaps magazines: the
      // outgoing magazine stays in inventory holding its remaining rounds, so
      // partially-spent magazines persist and can be topped off later.
      // A stale loaded-magazine id (its item was deleted) shouldn't trap a
      // loose-ammo weapon in magazine mode — clear it and fall through.
      const loadedMagExists = loadedMagId && this.actor.items.get(loadedMagId);
      if (loadedMagId && !loadedMagExists) {
        await item.update({ "system.ammo.loadedMagazine": "" });
      }
      // Per-weapon coupling: a weapon with a magClass only accepts magazines of
      // the same magClass. Blank on either side is a wildcard (power cells).
      // Only magazines that fit count towards magazine mode, so a magazine for
      // a different gun doesn't block the loose-ammo fallback below.
      const weaponMagClass = item.system.ammo.magClass;
      const magClassFits = (m) =>
        !weaponMagClass || !m.system.uses?.magClass || m.system.uses.magClass === weaponMagClass;
      const spareMags = this.actor.items.filter(
        (i) => i.type === 'item'
          && i.system.uses?.consumable === 'magazine'
          && i.system.uses?.ammo === ammoType
          && i.id !== loadedMagId
          && magClassFits(i)
      );
      if (spareMags.length > 0 || loadedMagExists) {
        // Loadable = generic (uses.max 0, sizes to the weapon on load) or a
        // concrete magazine that still has rounds.
        const usable = spareMags.filter(
          (m) => m.system.uses.max === 0 || m.system.uses.value > 0
        );
        if (usable.length === 0) {
          ui.notifications?.error(
            game.i18n.localize("swnr.weapon.noLoadedMagazine")
          );
          return;
        }

        // Pick a magazine — dialog when there is more than one choice.
        let chosen = usable[0];
        if (usable.length > 1) {
          const fresh = game.i18n.localize("swnr.weapon.freshMagazine");
          const options = usable
            .map((m) => {
              const lbl = m.system.uses.max === 0 ? fresh : `${m.system.uses.value}/${m.system.uses.max}`;
              return `<option value="${m.id}">${foundry.utils.escapeHTML(m.name)} (${lbl})</option>`;
            })
            .join("");
          const content = `<div class="form-group"><label>${game.i18n.localize("swnr.weapon.selectMagazine")}</label>
            <select name="mag" style="flex:2;">${options}</select></div>`;
          const magId = await foundry.applications.api.DialogV2.wait({
            window: { title: game.i18n.localize("swnr.weapon.reloadTitle") },
            content,
            rejectClose: false,
            buttons: [
              {
                action: "ok",
                label: game.i18n.localize("swnr.sheet.reload-item"),
                default: true,
                callback: (_e, button) => button.form.elements.mag.value,
              },
              { action: "cancel", label: game.i18n.localize("Cancel") },
            ],
          });
          if (!magId || magId === "cancel") return;
          chosen = usable.find((m) => m.id === magId);
          if (!chosen) return;
        }

        const oldMag = loadedMagId ? this.actor.items.get(loadedMagId) : null;

        // Loading from a stack (quantity > 1) splits one magazine off so that
        // firing only drains the loaded copy, not the whole stack.
        let loadedMag = chosen;
        if (chosen.system.quantity > 1) {
          await chosen.update({ "system.quantity": chosen.system.quantity - 1 });
          const data = chosen.toObject();
          data.system.quantity = 1;
          delete data._id;
          const [created] = await this.actor.createEmbeddedDocuments("Item", [data]);
          loadedMag = created;
        }

        // Generic magazine/cell (uses.max === 0): size it to the weapon's own
        // capacity and fill it. From then on it is a concrete magazine that
        // retains partial rounds/charge across future swaps.
        if (loadedMag.system.uses.max === 0) {
          const weaponCap = item.system.ammo.max || 0;
          if (weaponCap <= 0) {
            ui.notifications?.error(`${item.name} has no defined ammo capacity to size this magazine to.`);
            return;
          }
          await loadedMag.update({ "system.uses.max": weaponCap, "system.uses.value": weaponCap });
        }

        await item.update({
          "system.ammo.loadedMagazine": loadedMag.id,
          "system.ammo.max": loadedMag.system.uses.max,
          "system.ammo.value": loadedMag.system.uses.value,
        });

        // The outgoing magazine always stays in inventory as an ordinary item,
        // keeping its remaining rounds — even when empty, so it can be reloaded
        // (topped off) later. Magazines are reusable objects, not spent brass.
        let note = "";
        if (oldMag) {
          note = oldMag.system.uses.value > 0
            ? ` Previous magazine (${oldMag.name}) set aside with ${oldMag.system.uses.value} round(s).`
            : ` Empty magazine (${oldMag.name}) set aside to reload later.`;
        }
        if (item.system.ammo.longReload) {
          note += " This weapon takes extra time to reload.";
        }
        ChatMessage.create({
          speaker: ChatMessage.getSpeaker({ actor: this.actor }),
          content: `<p>Reloaded ${item.name} with ${loadedMag.name} (${loadedMag.system.uses.value}/${loadedMag.system.uses.max}).${note}</p>`,
        });
        return;
      }

      // ── Legacy loose / bundle mode ─────────────────────────────────────
      // Pours rounds from a chosen ammo-source item into the weapon's own
      // ammo.value (SWN abstract loose ammo / clip bundles).
      let currentAmmo = item.system.ammo.value;
      let ammoNeeded = ammoMax - currentAmmo;
      if (ammoNeeded <= 0) {
        ui.notifications.info("Weapon already full.");
        return;
      }

      let ammoReloadDesc = '';
      let extraMessage = "";
      if (item.system.ammo.longReload) {
        extraMessage = " This weapon takes extra time to reload.<br>";
      }
      let ammoToAdd = 0;
      if (item.system.ammo.current == null || item.system.ammo.current == "") {
        ui.notifications?.error("No ammo source currently set. Not reloading. Hold shift+click to bypass and reload.");
        return;
      }

      let ammoItem = this.actor.items.get(item.system.ammo.current);
      if (ammoItem == null) {
        // The selected source is gone (e.g. an emptied box of loose rounds was
        // removed): switch to another box of the same ammo type, if any.
        const replacement = looseRoundsFor(this.actor, ammoType)[0];
        if (!replacement) {
          ui.notifications?.error(`No loose rounds left for ${item.name}. Hold shift+click to bypass and reload.`);
          return;
        }
        await item.update({ "system.ammo.current": replacement.id });
        ammoItem = replacement;
      }
      if (ammoItem.system.uses.consumable == 'bundle') {
        if (ammoItem.system.quantity == 0 || ammoItem.system.uses.emptyQuantity == ammoItem.system.quantity) {
          ui.notifications?.error(`All ${ammoItem.name} are empty. Hold shift+click to bypass and reload.`);
          return;
        }
        //uses the whole clip with capacity set by the weapon
        ammoToAdd = ammoMax;
        await ammoItem.system.removeOneUse();
        ammoReloadDesc = ` using ${ammoItem.name} from your inventory`;
      }  else if (ammoItem.system.uses.consumable == "count") {
        // Take exactly the loose rounds needed: the selected source first, then
        // any other loose rounds of the same ammo type in the inventory.
        const { drawn, used } = await drawLooseRounds(this.actor, ammoType, ammoNeeded, ammoItem);
        ammoToAdd = drawn;
        if (ammoToAdd <= 0) {
          ui.notifications?.error(`No loose rounds left for ${item.name}. Hold shift+click to bypass and reload.`);
          return;
        }
        ammoReloadDesc = ` with ${describeRounds(used)}`;
        // If the selected box was emptied and removed, point the weapon at the
        // next box of the same ammo type so the "Ammo Used" field stays useful.
        if (!this.actor.items.has(ammoItem.id)) {
          const next = looseRoundsFor(this.actor, ammoType)[0];
          if (next) await item.update({ "system.ammo.current": next.id });
        }
      } else {
        ui.notifications.error("Item/Ammo consumable is not set to bundle or count");
        return;
      }
      if (ammoItem.system.location != "readied") {
        extraMessage+=" Ammo source was not readied.";
      }

      // Update the weapon with the ammo that was consumed.
      let newAmmoValue = currentAmmo + ammoToAdd;
      if (newAmmoValue > ammoMax) newAmmoValue = ammoMax;

      await item.update({ "system.ammo.value": newAmmoValue });

      const content = `<p>Reloaded ${item.name}${ammoReloadDesc}.${extraMessage}</p>`;
      ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor: this.actor }),
        content: content,
      });
    }

  /**
   * Top off a magazine from loose rounds (a `count` consumable of the same ammo
   * type) in the actor's inventory. Works on loaded magazines too, since the
   * weapon derives its rounds from the magazine.
   *
   * @this SWNActorSheet
   * @param {PointerEvent} event   The originating click event
   * @param {HTMLElement} target   The capturing HTML element which defined a [data-action]
   * @protected
   */
    static async _onLoadMagazine(event, target) {
      const mag = this._getEmbeddedDocument(target);
      if (!mag || mag.type !== 'item' || mag.system.uses?.consumable !== 'magazine') return;
      const { value, max, ammo } = mag.system.uses;
      if (max <= 0) {
        ui.notifications?.info(game.i18n.localize("swnr.weapon.magazineUnsized"));
        return;
      }
      const needed = max - value;
      if (needed <= 0) {
        ui.notifications?.info(game.i18n.format("swnr.weapon.magazineFull", { name: mag.name }));
        return;
      }

      const sources = this.actor.items.filter(
        (i) => i.type === 'item'
          && i.system.uses?.consumable === 'count'
          && i.system.uses?.ammo === ammo
          && i.system.uses.value > 0
          && i.system.quantity > 0
      );
      if (sources.length === 0) {
        ui.notifications?.error(game.i18n.format("swnr.weapon.noLooseRounds", { name: mag.name }));
        return;
      }

      let source = sources[0];
      if (sources.length > 1) {
        const options = sources
          .map((s) => `<option value="${s.id}">${foundry.utils.escapeHTML(s.name)} (${s.system.uses.value}/${s.system.uses.max}${s.system.quantity > 1 ? ` ×${s.system.quantity}` : ""})</option>`)
          .join("");
        const content = `<div class="form-group"><label>${game.i18n.localize("swnr.weapon.selectRounds")}</label>
          <select name="src" style="flex:2;">${options}</select></div>`;
        const srcId = await foundry.applications.api.DialogV2.wait({
          window: { title: game.i18n.format("swnr.weapon.loadMagazineTitle", { name: mag.name }) },
          content,
          rejectClose: false,
          buttons: [
            {
              action: "ok",
              label: game.i18n.localize("swnr.weapon.loadMagazine"),
              default: true,
              callback: (_e, button) => button.form.elements.src.value,
            },
            { action: "cancel", label: game.i18n.localize("Cancel") },
          ],
        });
        if (!srcId || srcId === "cancel") return;
        source = sources.find((s) => s.id === srcId);
        if (!source) return;
      }

      // The chosen source first, then any other loose rounds of this ammo type.
      const { drawn, used } = await drawLooseRounds(this.actor, ammo, needed, source);
      if (drawn <= 0) return;
      const newValue = value + drawn;
      await mag.update({ "system.uses.value": newValue });

      ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor: this.actor }),
        content: `<p>Loaded ${drawn} round(s) into ${mag.name} (${describeRounds(used)}; ${newValue}/${max}).</p>`,
      });
    }

    static async _onCreditChange(event, target) {
      event.preventDefault();
      const _doAdd = async (_event, button, _html) => {
        const amount = button.form.elements.amount.value;
        if (isNaN(parseInt(amount))) {
          ui.notifications?.error(game.i18n.localize("swnr.InvalidNumber"));
          return;
        }
        if (this.actor.type === 'ship') {
          const creditField = target.dataset.creditType;

          const oldAmount = this.actor.system[creditField];
          if (oldAmount == undefined || oldAmount == null) {
            ui.notifications?.error("Invalid currency type");
            return;
          }
          const newAmount = oldAmount + parseInt(amount);
          await this.actor.update({
            system: {
                [creditField]: newAmount,
              },
          });
        } else if (this.actor.type === 'character') {
          const currencyType = target.dataset.currencyType;

          if (currencyType === 'custom') {
            const currencyIdx = target.dataset.currencyIdx;
            let extraCurrencies = foundry.utils.duplicate(this.actor.system.credits.extraCurrencies);
            const currency = extraCurrencies[currencyIdx];
            if (currency == undefined || currency == null) {
              ui.notifications?.error("Invalid currency");
              return;
            }
            extraCurrencies[currencyIdx].value = currency.value + parseInt(amount);
            await this.actor.update({
              "system.credits.extraCurrencies": extraCurrencies,
            });
          } else if (currencyType === 'base') {
            const oldAmount = this.actor.system.credits.carriedBase;
            const newAmount = oldAmount + parseInt(amount);
            await this.actor.update({
              "system.credits.carriedBase": newAmount,
            });
          } else {
            ui.notifications?.error("Invalid currency type");
          }
        } else {
          ui.notifications?.error("Credit change not supported for this actor type");
        }

      };
  
      const currencyName = target.dataset.creditType;
      const description = game.i18n.format("swnr.dialog.addCurrency", { type: currencyName });
      const proceed = await foundry.applications.api.DialogV2.prompt({
        window: { title: "Proceed" },
        content: `<p>${description}</p> <input type="number" name="amount">`,
        modal: false,
        rejectClose: false,
        ok: {
          callback: _doAdd,
        }
      });
    }

  /***************
   *
   * Drag and Drop
   *
   ***************/

  /**
   * Define whether a user is able to begin a dragstart workflow for a given drag selector
   * @param {string} selector       The candidate HTML selector for dragging
   * @returns {boolean}             Can the current user drag this selector?
   * @protected
   */
  _canDragStart(selector) {
    // game.user fetches the current user
    return this.isEditable;
  }

  /**
   * Define whether a user is able to conclude a drag-and-drop workflow for a given drop selector
   * @param {string} selector       The candidate HTML selector for the drop target
   * @returns {boolean}             Can the current user drop on this selector?
   * @protected
   */
  _canDragDrop(selector) {
    // game.user fetches the current user
    return this.isEditable;
  }

  /**
   * Callback actions which occur at the beginning of a drag start workflow.
   * @param {DragEvent} event       The originating DragEvent
   * @protected
   */
  _onDragStart(event) {
    const docRow = event.currentTarget.closest('li');
    if ('link' in event.target.dataset) return;

    // Chained operation
    let dragData = this._getEmbeddedDocument(docRow)?.toDragData();

    if (!dragData) return;

    // Set data transfer
    event.dataTransfer.setData('text/plain', JSON.stringify(dragData));
  }

  /**
   * Callback actions which occur when a dragged element is over a drop target.
   * @param {DragEvent} event       The originating DragEvent
   * @protected
   */
  _onDragOver(event, target) {
    // Handle container drag over visual feedback
    ContainerHelper.handleContainerDragOver(event, target);
  }

  /**
   * Callback actions which occur when a dragged element leaves a drop target.
   * @param {DragEvent} event       The originating DragEvent
   * @protected
   */
  _onDragLeave(event, target) {
    // Handle container drag leave visual feedback
    ContainerHelper.handleContainerDragLeave(event, target);
  }

  /**
   * Callback actions which occur when a dragged element is dropped on a target.
   * @param {DragEvent} event       The originating DragEvent
   * @protected
   */
  async _onDrop(event, target) {
    const data = foundry.applications.ux.TextEditor.implementation.getDragEventData(event);
    const actor = this.actor;
    const allowed = Hooks.call('dropActorSheetData', actor, this, data);
    if (allowed === false) return;

    // Handle different data types
    switch (data.type) {
      case 'ActiveEffect':
        return this._onDropActiveEffect(event, data);
      case 'Actor':
        return this._onDropActor(event, data);
      case 'Item':
        return this._onDropItem(event, data);
      case 'Folder':
        return this._onDropFolder(event, data);
    }
  }

  /**
   * Handle dropping of an Actor data onto another Actor sheet
   * @param {DragEvent} event            The concluding DragEvent which contains drop data
   * @param {object} data                The data transfer extracted from the event
   * @returns {Promise<object|boolean>}  A data object which describes the result of the drop, or false if the drop was
   *                                     not permitted.
   * @protected
   */
  async _onDropActor(event, data) {
    if (!this.actor.isOwner) return false;
  }


  /**
 * Handle the dropping of ActiveEffect data onto an Actor Sheet
 * @param {DragEvent} event                  The concluding DragEvent which contains drop data
 * @param {object} data                      The data transfer extracted from the event
 * @returns {Promise<ActiveEffect|boolean>}  The created ActiveEffect object or false if it couldn't be created.
 * @protected
 */
  async _onDropActiveEffect(event, data) {
    const aeCls = getDocumentClass('ActiveEffect');
    const effect = await aeCls.fromDropData(data);
    if (!this.actor.isOwner || !effect) return false;
    if (effect.target === this.actor)
      return this._onSortActiveEffect(event, effect);
    return aeCls.create(effect, { parent: this.actor });
  }

  /**
   * Handle a drop event for an existing embedded Active Effect to sort that Active Effect relative to its siblings
   *
   * @param {DragEvent} event
   * @param {ActiveEffect} effect
   */
  async _onSortActiveEffect(event, effect) {
    /** @type {HTMLElement} */
    const dropTarget = event.target.closest('[data-effect-id]');
    if (!dropTarget) return;
    const target = this._getEmbeddedDocument(dropTarget);

    // Don't sort on yourself
    if (effect.uuid === target.uuid) return;

    // Identify sibling items based on adjacent HTML elements
    const siblings = [];
    for (const el of dropTarget.parentElement.children) {
      const siblingId = el.dataset.effectId;
      const parentId = el.dataset.parentId;
      if (
        siblingId &&
        parentId &&
        (siblingId !== effect.id || parentId !== effect.parent.id)
      )
        siblings.push(this._getEmbeddedDocument(el));
    }

    // Perform the sort
    const sortUpdates = SortingHelpers.performIntegerSort(effect, {
      target,
      siblings,
    });

    // Split the updates up by parent document
    const directUpdates = [];

    const grandchildUpdateData = sortUpdates.reduce((items, u) => {
      const parentId = u.target.parent.id;
      const update = { _id: u.target.id, ...u.update };
      if (parentId === this.actor.id) {
        directUpdates.push(update);
        return items;
      }
      if (items[parentId]) items[parentId].push(update);
      else items[parentId] = [update];
      return items;
    }, {});

    // Effects-on-items updates
    for (const [itemId, updates] of Object.entries(grandchildUpdateData)) {
      await this.actor.items
        .get(itemId)
        .updateEmbeddedDocuments('ActiveEffect', updates);
    }

    // Update on the main actor
    return this.actor.updateEmbeddedDocuments('ActiveEffect', directUpdates);
  }

  /**
   * Determines effect parent to pass to helper
   *
   * @this SWNActorSheet
   * @param {PointerEvent} event   The originating click event
   * @param {HTMLElement} target   The capturing HTML element which defined a [data-action]
   * @private
   */
  static async _toggleEffect(event, target) {
    const effect = this._getEmbeddedDocument(target);
    await effect.update({ disabled: !effect.disabled });
  }


  /********************
  *
  * Actor Override Handling
  *
  ********************/

  /**
   * Submit a document update based on the processed form data.
   * @param {SubmitEvent} event                   The originating form submission event
   * @param {HTMLFormElement} form                The form element that was submitted
   * @param {object} submitData                   Processed and validated form data to be used for a document update
   * @returns {Promise<void>}
   * @protected
   * @override
   */
  async _processSubmitData(event, form, submitData) {
    const overrides = foundry.utils.flattenObject(this.actor.overrides);
    for (let k of Object.keys(overrides)) delete submitData[k];
    await this.document.update(submitData);
  }

  /**
   * Disables inputs subject to active effects
   * @private
   */
  _disableOverrides() {
    const flatOverrides = foundry.utils.flattenObject(this.actor.overrides);
    for (const override of Object.keys(flatOverrides)) {
      const input = this.element.querySelector(`[name="${override}"]`);
      if (input) {
        input.disabled = true;
      }
    }
  }

}