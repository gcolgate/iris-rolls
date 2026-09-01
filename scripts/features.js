import { MODULE_ID, localize } from "./constants.js";
import { ownedUpdate } from "./resources.js";
import { actorFromTargetSync } from "./targets.js";

function itemIdent(item) {
  return String(item?.system?.identifier || item?.identifier || "")
    .toLowerCase()
    .replace(/_/g, "-")
    .replace(/\s+/g, "-");
}

function itemName(item) {
  return String(item?.name ?? "").toLowerCase().trim();
}

function usesMax(doc, uses) {
  if (!uses) return 0;
  const max = uses.max;
  if (max == null || max === "") return 0;
  const n = Number(max);
  if (Number.isFinite(n) && !String(max).includes("@")) return n;
  try {
    const data = doc?.actor?.getRollData?.() ?? doc?.getRollData?.() ?? {};
    return Number(new Roll(String(max), data).evaluateSync({ strict: false }).total) || 0;
  } catch {
    return Number(max) || 0;
  }
}

function usesRemaining(doc, uses) {
  const max = usesMax(doc, uses);
  if (!(max > 0)) return null;
  const spent = Number(uses?.spent) || 0;
  const value = Number(uses?.value);
  const remaining = Number.isFinite(value) ? Math.max(0, value) : Math.max(0, max - spent);
  return { max, spent, remaining, path: null };
}

export function findActorItems(actor, { identifiers=[], names=[] }={}) {
  if (!actor?.items) return [];
  const idents = new Set(identifiers.map(s => String(s).toLowerCase()));
  const nms = new Set(names.map(s => String(s).toLowerCase()));
  const found = [];
  for (const item of actor.items) {
    if (idents.has(itemIdent(item)) || nms.has(itemName(item))) found.push(item);
  }
  return found;
}

export function findActorItem(actor, spec) {
  return findActorItems(actor, spec)[0] ?? null;
}

function activityList(item) {
  const acts = item?.system?.activities;
  if (!acts) return [];
  return typeof acts[Symbol.iterator] === "function" ? [...acts] : Object.values(acts);
}

export function featureUses(item) {
  if (!item) return { hasUses: false, remaining: Infinity, max: 0, spent: 0, path: null, item: null };
  const itemUses = usesRemaining(item, item.system?.uses);
  if (itemUses) {
    return { hasUses: true, ...itemUses, path: "system.uses.spent", item };
  }
  for (const activity of activityList(item)) {
    const info = usesRemaining(item, activity.uses);
    if (!info) continue;
    return {
      hasUses: true,
      ...info,
      path: `system.activities.${activity.id}.uses.spent`,
      item
    };
  }
  return { hasUses: false, remaining: Infinity, max: 0, spent: 0, path: null, item };
}

export function findKiItem(actor) {
  return findActorItem(actor, {
    identifiers: ["ki", "ki-points", "ki-point"],
    names: ["ki", "ki points"]
  });
}

export function hasReliableTalent(actor) {
  if (!actor) return false;
  if (actor.getFlag?.("dnd5e", "reliableTalent")) return true;
  return Boolean(findActorItem(actor, {
    identifiers: ["reliable-talent"],
    names: ["reliable talent"]
  }));
}

export function isSkillProficient(actor, skill) {
  if (!actor || !skill) return false;
  return Number(actor.system?.skills?.[skill]?.value) >= 1;
}

export function isToolProficient(actor, tool) {
  if (!actor || !tool) return false;
  return Number(actor.system?.tools?.[tool]?.value) >= 1;
}

export function shouldApplyReliableTalent(actor, { skill, tool, kind }={}) {
  if (!hasReliableTalent(actor)) return false;
  if (skill) return isSkillProficient(actor, skill);
  if (tool) return isToolProficient(actor, tool);
  if (kind === "skill" || kind === "tool") return false;
  return false;
}

function flagArray(doc, ...paths) {
  if (!doc) return [];
  for (const path of paths) {
    const value = foundry.utils.getProperty(doc, path);
    if (Array.isArray(value) && value.length) {
      return value.map(Number).filter(n => Number.isFinite(n) && n >= 1 && n <= 20);
    }
  }
  return [];
}

export function portentValues(item, actor) {
  const pools = [
    flagArray(item, "flags.dnd5e.portent", "flags.midi-qol.portent", `flags.${MODULE_ID}.portent`),
    flagArray(actor, "flags.dnd5e.portent", "flags.midi-qol.portent", `flags.${MODULE_ID}.portent`)
  ];
  for (const effect of actor?.effects ?? []) {
    pools.push(flagArray(effect, "flags.dnd5e.portent", `flags.${MODULE_ID}.portent`));
  }
  return pools.find(list => list.length) ?? [];
}

async function consumePortentValue(item, actor, value) {
  const n = Number(value);
  const docs = [
    { doc: item, paths: ["flags.dnd5e.portent", "flags.midi-qol.portent", `flags.${MODULE_ID}.portent`] },
    { doc: actor, paths: ["flags.dnd5e.portent", "flags.midi-qol.portent", `flags.${MODULE_ID}.portent`] }
  ];
  for (const effect of actor?.effects ?? []) {
    docs.push({ doc: effect, paths: ["flags.dnd5e.portent", `flags.${MODULE_ID}.portent`] });
  }
  for (const { doc, paths } of docs) {
    if (!doc) continue;
    for (const path of paths) {
      const arr = foundry.utils.getProperty(doc, path);
      if (!Array.isArray(arr)) continue;
      const index = arr.findIndex(v => Number(v) === n);
      if (index < 0) continue;
      const next = [...arr];
      next.splice(index, 1);
      await ownedUpdate(doc, { [path]: next });
      return true;
    }
  }
  return false;
}

export async function consumeFeatureUse(item, path="system.uses.spent") {
  if (!item || !path) return false;
  const spent = Number(foundry.utils.getProperty(item, path)) || 0;
  const update = { [path]: spent + 1 };
  if (path === "system.uses.spent") {
    const max = usesMax(item, item.system?.uses);
    if (max > 0) update["system.uses.value"] = Math.max(0, max - spent - 1);
  }
  await ownedUpdate(item, update);
  return true;
}

function isSaveKind(kind) {
  return kind === "save" || kind === "savingThrow" || kind === "concentration";
}

function isCheckKind(kind) {
  return kind === "skill" || kind === "tool" || kind === "check" || kind === "ability";
}

function failedSave(payload, target) {
  if (!isSaveKind(payload.kind)) return false;
  if (target?.success === true || payload.success === true) return false;
  if (target?.success === false || payload.success === false) return true;
  if (payload.dc == null) return true;
  const total = target?.saveTotal ?? payload.displayTotal;
  return Number(total) < Number(payload.dc);
}

function failedCheck(payload) {
  if (!isCheckKind(payload.kind)) return false;
  if (payload.dc == null) return true;
  return Number(payload.displayTotal) < Number(payload.dc);
}

function missedAttack(payload, target) {
  return payload.kind === "attack" && target?.hit === false;
}

function pushOption(list, option) {
  if (!option) return;
  if (list.some(o => o.id === option.id && o.itemUuid === option.itemUuid)) return;
  list.push(option);
}

function makeOption({
  id, item, actor, name, action, setTo=null, advantage=false, ki=null, available=true, detail=""
}) {
  const uses = featureUses(item);
  const kiUses = ki ? featureUses(ki) : null;
  let remaining = uses.remaining;
  let usesLabel = "";
  if (kiUses?.hasUses) {
    remaining = Math.min(remaining, kiUses.remaining);
    usesLabel = localize("UsesKi", { remaining: kiUses.remaining, max: kiUses.max });
  } else if (uses.hasUses) {
    usesLabel = localize("UsesLeft", { remaining: uses.remaining, max: uses.max });
  }
  if (uses.hasUses && uses.remaining <= 0) available = false;
  if (kiUses?.hasUses && kiUses.remaining <= 0) available = false;
  return {
    id,
    itemUuid: item?.uuid ?? "",
    actorUuid: actor?.uuid ?? "",
    kiUuid: ki?.uuid ?? "",
    usesPath: uses.path,
    kiPath: kiUses?.path ?? "system.uses.spent",
    name: name || item?.name || id,
    action,
    setTo,
    advantage,
    available,
    disabled: !available,
    usesLabel,
    remaining,
    detail,
    isPortent: id === "portent"
  };
}

function luckyItems(actor) {
  return findActorItems(actor, { identifiers: ["lucky"], names: ["lucky"] });
}

function optionsFromActor(actor, payload, target, usedFace, { role="self" }={}) {
  const options = [];
  if (!actor) return options;
  const kind = payload.kind;
  const d20Test = ["attack", "save", "savingThrow", "concentration", "skill", "tool", "check", "ability"].includes(kind);

  if (role === "self") {
    const racialLucky = Boolean(actor.getFlag?.("dnd5e", "halflingLucky"));
    const luckies = luckyItems(actor);
    const racialItem = luckies.find(item => !featureUses(item).hasUses);
    const featItem = luckies.find(item => featureUses(item).hasUses);
    if ((racialLucky || racialItem) && usedFace === 1 && d20Test) {
      pushOption(options, makeOption({
        id: "halfling-lucky",
        item: racialItem,
        actor,
        name: racialItem?.name || localize("HalflingLucky"),
        action: "reroll",
        detail: localize("DieReroll"),
        available: true
      }));
    }
    if (featItem && d20Test) {
      pushOption(options, makeOption({
        id: "lucky-feat",
        item: featItem,
        actor,
        name: featItem.name,
        action: "reroll",
        detail: localize("DieExtra"),
        available: true
      }));
    }

    const indomitable = findActorItem(actor, { identifiers: ["indomitable"], names: ["indomitable"] });
    if (indomitable && failedSave(payload, target)) {
      pushOption(options, makeOption({
        id: "indomitable", item: indomitable, actor, name: indomitable.name,
        action: "reroll", detail: localize("DieReroll")
      }));
    }

    const fanatical = findActorItem(actor, {
      identifiers: ["fanatical-focus"],
      names: ["fanatical focus"]
    });
    if (fanatical && failedSave(payload, target)) {
      pushOption(options, makeOption({
        id: "fanatical-focus", item: fanatical, actor, name: fanatical.name,
        action: "reroll", detail: localize("DieReroll")
      }));
    }

    const diamond = findActorItem(actor, {
      identifiers: ["diamond-soul"],
      names: ["diamond soul"]
    });
    if (diamond && failedSave(payload, target)) {
      const ki = findKiItem(actor);
      pushOption(options, makeOption({
        id: "diamond-soul", item: diamond, actor, name: diamond.name, ki,
        action: "reroll", detail: localize("DieReroll")
      }));
    }

    const duelist = findActorItem(actor, {
      identifiers: ["master-duelist"],
      names: ["master duelist"]
    });
    if (duelist && missedAttack(payload, target)) {
      pushOption(options, makeOption({
        id: "master-duelist", item: duelist, actor, name: duelist.name,
        action: "reroll", advantage: true, detail: localize("DieRerollAdv")
      }));
    }

    const chronal = findActorItem(actor, {
      identifiers: ["chronal-shift"],
      names: ["chronal shift"]
    });
    if (chronal && d20Test) {
      pushOption(options, makeOption({
        id: "chronal-shift", item: chronal, actor, name: chronal.name,
        action: "reroll", detail: localize("DieReroll")
      }));
    }

    const luckBlade = findActorItem(actor, {
      identifiers: ["luck-blade", "luckblade"],
      names: ["luck blade"]
    });
    if (luckBlade && d20Test) {
      pushOption(options, makeOption({
        id: "luck-blade", item: luckBlade, actor, name: luckBlade.name,
        action: "reroll", detail: localize("DieReroll")
      }));
    }

    const portent = findActorItem(actor, { identifiers: ["portent"], names: ["portent"] });
    if (portent && d20Test) {
      const values = portentValues(portent, actor);
      const option = makeOption({
        id: "portent", item: portent, actor, name: portent.name,
        action: "set", detail: localize("DieSetPortent")
      });
      option.portentValues = values;
      option.hasPortentValues = values.length > 0;
      pushOption(options, option);
    }

    const stroke = findActorItem(actor, {
      identifiers: ["stroke-of-luck"],
      names: ["stroke of luck"]
    });
    if (stroke && (missedAttack(payload, target) || failedCheck(payload) || failedSave(payload, target))) {
      pushOption(options, makeOption({
        id: "stroke-of-luck", item: stroke, actor, name: stroke.name,
        action: "set", setTo: 20, detail: localize("DieSetTo", { value: 20 })
      }));
    }

    const amulet = findActorItem(actor, {
      identifiers: ["clockwork-amulet"],
      names: ["clockwork amulet"]
    });
    if (amulet && kind === "attack") {
      pushOption(options, makeOption({
        id: "clockwork-amulet", item: amulet, actor, name: amulet.name,
        action: "set", setTo: 10, detail: localize("DieSetTo", { value: 10 })
      }));
    }
  }

  if (role === "target") {
    const shield = findActorItem(actor, {
      identifiers: ["runic-shield"],
      names: ["runic shield"]
    });
    if (shield && kind === "attack") {
      pushOption(options, makeOption({
        id: "runic-shield", item: shield, actor, name: shield.name,
        action: "reroll", detail: localize("DieReroll")
      }));
    }
  }

  return options;
}

function safeDoc(uuid) {
  if (!uuid) return null;
  try {
    return fromUuidSync(uuid);
  } catch {
    return null;
  }
}

export function listDieOptions(payload, target, { isGM=false }={}) {
  const roller = safeDoc(payload.roller?.uuid);
  const targetActor = actorFromTargetSync(target);
  const selfActor = payload.kind === "save" ? (targetActor ?? roller) : roller;
  const usedFace = usedFaceOf(payload, target);
  const options = optionsFromActor(selfActor, payload, target, usedFace, { role: "self" });
  if (payload.kind === "attack" && targetActor && targetActor !== selfActor) {
    options.push(...optionsFromActor(targetActor, payload, target, usedFace, { role: "target" }));
  }
  if (isGM) {
    options.push({
      id: "dm-reroll",
      name: localize("DmReroll"),
      action: "reroll",
      available: true,
      disabled: false,
      detail: localize("DieReroll"),
      isGm: true
    });
    options.push({
      id: "dm-set",
      name: localize("DmSet"),
      action: "set",
      available: true,
      disabled: false,
      detail: localize("DieSetCustom"),
      isGm: true,
      isDmSet: true
    });
  }
  for (const option of options) {
    if (isGM) option.disabled = false;
    option.available = !option.disabled;
  }
  return options;
}

function usedFaceOf(payload, target) {
  if (payload.kind === "attack" && target?.d20) {
    return Number(target.d20[target.usedIndex ?? 0]) || 0;
  }
  if (payload.kind === "save" && target?.saveD20) {
    return Number(target.saveD20[target.usedIndex ?? 0]) || 0;
  }
  return Number(payload.d20?.[payload.usedIndex ?? 0]) || 0;
}

export async function consumeDieOption(option, { portentValue }={}) {
  if (!option || option.id === "dm-reroll" || option.id === "dm-set") return;
  if (option.id === "halfling-lucky") return;
  const item = option.itemUuid ? await fromUuid(option.itemUuid) : null;
  const actor = option.actorUuid ? await fromUuid(option.actorUuid) : item?.actor;
  if (option.id === "portent" && portentValue != null) {
    await consumePortentValue(item, actor, portentValue);
  }
  if (option.kiUuid) {
    const ki = await fromUuid(option.kiUuid);
    if (ki) await consumeFeatureUse(ki, option.kiPath);
  }
  if (item && option.usesPath) await consumeFeatureUse(item, option.usesPath);
}
