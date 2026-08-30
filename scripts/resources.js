import { MODULE_ID, localize } from "./constants.js";

export function slotLevelLabel(level) {
  const raw = CONFIG.DND5E?.spellLevels?.[level];
  if (!raw) return `Level ${level}`;
  return game.i18n.has(raw) ? game.i18n.localize(raw) : raw;
}

function currentValue(doc, path) {
  return Number(foundry.utils.getProperty(doc, path)) || 0;
}

const DMG_SPELL_POINT_COSTS = { 0: 0, 1: 2, 2: 3, 3: 5, 4: 6, 5: 7, 6: 9, 7: 10, 8: 11, 9: 13 };

function evalFormula(formula, actor) {
  if (formula == null || formula === "") return 0;
  const numeric = Number(formula);
  if (Number.isFinite(numeric) && !String(formula).includes("@")) return numeric;
  try {
    return Number(new Roll(String(formula), actor?.getRollData?.() ?? {}).evaluateSync({ strict: false }).total) || 0;
  } catch {
    return Number(formula) || 0;
  }
}

export function getSpellPointsItem(actor) {
  if (!actor) return null;
  if (typeof globalThis.getSpellPointsItem === "function") {
    try {
      const found = globalThis.getSpellPointsItem(actor);
      if (found) return found;
    } catch { /* fall through */ }
  }
  const flagId = actor.getFlag?.("dnd5espellpoints", "item") || actor.flags?.dnd5espellpoints?.item;
  if (flagId && actor.items?.get(flagId)) return actor.items.get(flagId);
  const label = game.settings.get("dnd5e-spellpoints", "settings")?.spResource || "Spell Points";
  return actor.items?.find(item => {
    if (item.type !== "feat" && item.type !== "class") return false;
    return item.system?.source?.custom === label || item.name === label;
  }) ?? null;
}

export function actorUsesSpellPoints(actor) {
  return Boolean(getSpellPointsItem(actor));
}

function spellPointSettings(actor) {
  const defaults = game.settings.get("dnd5e-spellpoints", "settings") ?? {};
  const item = getSpellPointsItem(actor);
  if (item?.flags?.spellpoints?.override && item.flags.spellpoints.config) {
    return foundry.utils.mergeObject(defaults, item.flags.spellpoints.config, { inplace: false });
  }
  return defaults;
}

export function spellPointsMax(item, actor) {
  if (!item) return 0;
  return evalFormula(item.system?.uses?.max, actor);
}

export function spellPointsRemaining(item, actor) {
  if (!item) return 0;
  const max = spellPointsMax(item, actor);
  const spent = Number(item.system?.uses?.spent) || 0;
  const value = Number(item.system?.uses?.value);
  if (Number.isFinite(value)) return Math.max(0, value);
  return Math.max(0, max - spent);
}

export function spellPointCostForLevel(actor, level) {
  const settings = spellPointSettings(actor);
  const costs = settings.spellPointsCosts ?? DMG_SPELL_POINT_COSTS;
  const formula = costs[level] ?? costs[String(level)] ?? DMG_SPELL_POINT_COSTS[level] ?? 0;
  return Math.max(0, evalFormula(formula, actor));
}

export function wouldConsumeSpellSlot(activity, usageConfig={}) {
  const consume = usageConfig.consume;
  return consume !== false
    && (consume === true || consume?.spellSlot !== false)
    && Boolean(activity?.requiresSpellSlot)
    && Boolean(activity?.consumption?.spellSlot);
}

export function shouldUseSpellPoints(activity, usageConfig={}) {
  if (!activity?.actor || !getSpellPointsItem(activity.actor)) return false;
  if (activity.item?.type !== "spell") return false;
  const level = Number(activity.item?.system?.level) || 0;
  if (level === 0) return spellPointCostForLevel(activity.actor, 0) > 0;
  return wouldConsumeSpellSlot(activity, usageConfig) || Boolean(usageConfig.irisUseSpellPoints);
}

export function castSlotKey(activity, usageConfig={}) {
  const item = activity?.item;
  const actor = activity?.actor;
  const mode = item?.system?.preparation?.mode;
  return usageConfig.spell?.slot
    || ((mode && mode in (actor?.system?.spells ?? {})) ? mode : `spell${item?.system?.level ?? 1}`);
}

export function slotKeyLevel(actor, key, item) {
  const itemLevel = Number(item?.system?.level);
  const fallback = Number.isFinite(itemLevel) ? itemLevel : 1;
  if (!key) return fallback;
  if (key === "pact") return Number(actor?.system?.spells?.pact?.level) || fallback;
  const fromSlot = Number(actor?.system?.spells?.[key]?.level);
  if (Number.isFinite(fromSlot) && fromSlot > 0) return fromSlot;
  const parsed = Number(String(key).replace(/^spell/, ""));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export async function consumeSpellPoints(actor, cost) {
  const item = getSpellPointsItem(actor);
  if (!item || !(cost > 0)) return false;
  if (spellPointsRemaining(item, actor) < cost) return false;
  const spent = Number(item.system?.uses?.spent) || 0;
  const max = spellPointsMax(item, actor);
  const nextSpent = spent + cost;
  await ownedUpdate(item, {
    "system.uses.spent": nextSpent,
    "system.uses.value": Math.max(0, max - nextSpent)
  });
  return true;
}

export function snapshotConsumption(activity, usageConfig={}) {
  const actor = activity?.actor;
  const item = activity?.item;
  if (!actor) return [];
  const entries = [];
  const consume = usageConfig.consume;

  if (usageConfig.irisUseSpellPoints) {
    const spItem = getSpellPointsItem(actor);
    if (spItem) {
      entries.push({
        kind: "spellPoints",
        type: "item",
        itemId: spItem.id,
        itemUuid: spItem.uuid,
        path: "system.uses.spent",
        label: spItem.name,
        before: currentValue(spItem, "system.uses.spent")
      });
    }
  } else {
    const consumeSlot = consume !== false
      && (consume === true || consume?.spellSlot !== false)
      && activity.requiresSpellSlot
      && activity.consumption?.spellSlot;
    if (consumeSlot) {
      const mode = item?.system?.preparation?.mode;
      const key = usageConfig.spell?.slot
        || ((mode && mode in (actor.system.spells ?? {})) ? mode : `spell${item?.system?.level ?? 1}`);
      entries.push({
        kind: "spellSlot",
        type: "actor",
        key,
        path: `system.spells.${key}.value`,
        before: currentValue(actor, `system.spells.${key}.value`)
      });
    }
  }

  if (consume !== false && (consume === true || consume?.action)
    && activity.activation?.type === "legendary") {
    entries.push({
      kind: "attribute",
      type: "actor",
      path: "system.resources.legact.value",
      label: game.i18n.localize("DND5E.LegendaryAction.Label"),
      before: currentValue(actor, "system.resources.legact.value")
    });
  }

  const targets = activity.consumption?.targets;
  const targetEntries = targets?.entries ? Array.from(targets.entries()) : [];
  const targetByIndex = new Map();
  for (const [index, target] of targetEntries) {
    targetByIndex.set(index, target);
    targetByIndex.set(Number(index), target);
    targetByIndex.set(String(index), target);
  }
  const indexes = consume === false ? []
    : (consume === true || consume?.resources === true)
      ? targetEntries.map(([index]) => index)
      : (Array.isArray(consume?.resources) ? consume.resources : []);

  for (const index of indexes) {
    const target = targetByIndex.get(index) ?? targets?.[index];
    if (!target) continue;
    if (target.type === "itemUses") {
      const used = target.target ? actor.items.get(target.target) : item;
      if (!used) continue;
      entries.push({
        kind: "itemUses",
        type: "item",
        itemId: used.id,
        itemUuid: used.uuid,
        path: "system.uses.spent",
        label: used.name,
        before: currentValue(used, "system.uses.spent")
      });
    } else if (target.type === "activityUses") {
      entries.push({
        kind: "activityUses",
        type: "item",
        itemId: item.id,
        itemUuid: item.uuid,
        path: `system.activities.${activity.id}.uses.spent`,
        label: activity.name || item.name,
        before: currentValue(activity, "uses.spent")
      });
    } else if (target.type === "attribute") {
      const path = `system.${target.target}`;
      entries.push({
        kind: "attribute",
        type: "actor",
        path,
        label: target.target,
        before: currentValue(actor, path)
      });
    }
  }
  return entries;
}

export async function finalizeConsumption(activity, usageConfig={}) {
  const actor = activity?.actor;
  const item = activity?.item;
  const consumption = {
    scaling: Number(usageConfig.scaling) || 0,
    baseLevel: item?.system?.level ?? 0,
    canScale: Boolean(activity?.canScale && activity?.requiresSpellSlot && (item?.system?.level > 0)),
    spellSlot: null,
    spellPoints: null,
    resources: [],
    refunded: false
  };
  if (!actor) return consumption;

  for (const snap of usageConfig.irisSnapshot ?? []) {
    let doc = actor;
    if (snap.type === "item") doc = actor.items.get(snap.itemId);
    const after = currentValue(doc, snap.path);
    if (after === snap.before && snap.kind !== "spellPoints") continue;
    const rec = { ...snap, after };
    if (snap.kind === "spellSlot") {
      const slot = actor.system.spells?.[snap.key];
      rec.level = slot?.level ?? consumption.baseLevel;
      rec.label = slot?.label || slotLevelLabel(slot?.level ?? rec.level);
      consumption.spellSlot = rec;
    } else if (snap.kind === "spellPoints") {
      continue;
    } else {
      if (after === snap.before) continue;
      rec.label = rec.label || snap.kind;
      consumption.resources.push(rec);
    }
  }

  if (usageConfig.irisUseSpellPoints) {
    const spItem = getSpellPointsItem(actor);
    const key = castSlotKey(activity, usageConfig);
    const level = slotKeyLevel(actor, key, item);
    const cost = spellPointCostForLevel(actor, level);
    const snap = (usageConfig.irisSnapshot ?? []).find(entry => entry.kind === "spellPoints");
    const before = snap?.before ?? (spItem ? currentValue(spItem, "system.uses.spent") : 0);
    let after = spItem ? currentValue(spItem, "system.uses.spent") : before;
    if (spItem && cost > 0 && after === before) {
      const ok = await consumeSpellPoints(actor, cost);
      after = ok ? before + cost : before;
    }
    if (spItem && after !== before) {
      consumption.spellPoints = {
        kind: "spellPoints",
        type: "item",
        itemId: spItem.id,
        itemUuid: spItem.uuid,
        path: "system.uses.spent",
        before,
        after,
        cost: after - before,
        key,
        level,
        label: spItem.name,
        restored: false
      };
    } else if (cost > 0 && after === before) {
      ui.notifications.warn(localize("NoSpellPoints", {
        name: spItem?.name || "Spell Points",
        cost,
        remaining: spItem ? spellPointsRemaining(spItem, actor) : 0
      }));
    }
  }
  return consumption;
}

export function listSlotOptions(actor, item, currentKey) {
  const minLevel = item?.system?.level ?? 1;
  if (!minLevel) return [];
  const options = [];
  for (const [key, slot] of Object.entries(actor?.system?.spells ?? {})) {
    const level = Number(slot?.level) || 0;
    if (!level || level < minLevel) continue;
    if (!(slot.max > 0) && key !== currentKey) continue;
    const remaining = Number(slot.value) || 0;
    const selected = key === currentKey;
    options.push({
      value: key,
      level,
      label: slot.label || slotLevelLabel(level),
      remaining,
      disabled: !selected && remaining <= 0,
      selected
    });
  }
  return options.sort((a, b) => a.level - b.level || a.value.localeCompare(b.value));
}

export function listSpellPointOptions(actor, item, current={}) {
  const minLevel = item?.system?.level ?? 1;
  if (!minLevel) return [];
  const spItem = getSpellPointsItem(actor);
  const remaining = spellPointsRemaining(spItem, actor);
  const currentKey = current?.key || `spell${current?.level || minLevel}`;
  const restoredCost = current && !current.restored ? (current.cost || 0) : 0;
  const available = remaining + restoredCost;
  const options = [];
  for (let level = minLevel; level <= 9; level++) {
    const key = `spell${level}`;
    const cost = spellPointCostForLevel(actor, level);
    const selected = key === currentKey;
    options.push({
      value: key,
      level,
      cost,
      remaining: available,
      label: localize("SpellPointLevel", {
        level: slotLevelLabel(level),
        cost,
        remaining: available,
        name: spItem?.name || "Spell Points"
      }),
      disabled: !selected && available < cost,
      selected
    });
  }
  return options;
}

export function remainingConsumption(consumption) {
  if (!consumption) return [];
  const out = [];
  if (consumption.spellSlot && !consumption.spellSlot.restored) out.push(consumption.spellSlot);
  if (consumption.spellPoints && !consumption.spellPoints.restored) out.push(consumption.spellPoints);
  for (const rec of consumption.resources ?? []) {
    if (!rec.restored) out.push(rec);
  }
  return out;
}

export function consumptionLabels(consumption) {
  return remainingConsumption(consumption).map(r => r.label).filter(Boolean);
}

export async function ownedUpdate(doc, update) {
  if (!doc || foundry.utils.isEmpty(update)) return;
  if (game.user.isGM || doc.isOwner || doc.canUserModify?.(game.user, "update")) {
    return doc.update(update);
  }
  game.socket.emit(`module.${MODULE_ID}`, { op: "updateDoc", uuid: doc.uuid, update });
}

export async function restoreRecord(actor, rec) {
  if (!actor || !rec || rec.restored) return;
  if (rec.type === "item") {
    const item = actor.items.get(rec.itemId) ?? (rec.itemUuid ? await fromUuid(rec.itemUuid) : null);
    if (!item) return;
    const update = { [rec.path]: rec.before };
    if (rec.kind === "spellPoints") {
      update["system.uses.value"] = Math.max(0, spellPointsMax(item, actor) - rec.before);
    }
    await ownedUpdate(item, update);
  } else {
    await ownedUpdate(actor, { [rec.path]: rec.before });
  }
  rec.restored = true;
}

export function remainingResources(consumption) {
  return (consumption?.resources ?? []).filter(r => !r.restored);
}

export async function refundResources(actor, consumption) {
  const labels = [];
  for (const rec of remainingResources(consumption)) {
    await restoreRecord(actor, rec);
    if (rec.label) labels.push(rec.label);
  }
  return labels;
}

export async function refundRemaining(actor, consumption) {
  const labels = [];
  for (const rec of remainingConsumption(consumption)) {
    await restoreRecord(actor, rec);
    if (rec.label) labels.push(rec.label);
  }
  if (consumption) consumption.refunded = remainingConsumption(consumption).length === 0;
  return labels;
}

export async function consumeSpellSlot(actor, slotKey, amount=1) {
  if (!actor || !slotKey) return;
  const path = `system.spells.${slotKey}.value`;
  const current = currentValue(actor, path);
  const next = Math.max(0, current - Math.abs(amount));
  if (next === current) return false;
  await ownedUpdate(actor, { [path]: next });
  return true;
}

export function scaledActivity(item, activityId, scaling=0) {
  if (!item) return null;
  if (!scaling) return item.system.activities.get(activityId);
  const clone = item.clone({ "flags.dnd5e.scaling": scaling }, { keepId: true });
  if (clone.actor) {
    clone.actor._embeddedPreparation = true;
    try { clone.prepareFinalAttributes(); } catch { /* clone may not be fully embedded */ }
    delete clone.actor._embeddedPreparation;
  }
  return clone.system.activities.get(activityId);
}
