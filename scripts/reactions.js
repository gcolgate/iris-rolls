import { localize } from "./constants.js";
import { findActorItem, findActorItems, featureUses } from "./features.js";

const ELEMENTAL = new Set(["acid", "cold", "fire", "lightning", "thunder"]);
const MULT_STEPS = [0, 0.25, 0.5, 1, 2];

function snapMult(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return MULT_STEPS.reduce((best, step) => Math.abs(step - n) < Math.abs(best - n) ? step : best);
}

function classLevel(actor, identifier) {
  if (!actor) return 0;
  const classes = actor.classes;
  if (classes) {
    const cls = classes[identifier] ?? classes.get?.(identifier);
    const level = Number(cls?.system?.levels ?? cls?.levels);
    if (level) return level;
  }
  const items = actor.itemTypes?.class ?? [];
  const hit = items.find(i => String(i.system?.identifier || "").toLowerCase() === identifier
    || String(i.name || "").toLowerCase() === identifier);
  return Number(hit?.system?.levels) || 0;
}

function abilityMod(actor, abl) {
  return Number(actor?.system?.abilities?.[abl]?.mod) || 0;
}

function profBonus(actor) {
  return Number(actor?.system?.attributes?.prof) || 0;
}

function activitiesOf(item) {
  const acts = item?.system?.activities;
  if (!acts) return [];
  return typeof acts[Symbol.iterator] === "function" ? [...acts] : Object.values(acts);
}

function isMeleeAttack(payload) {
  try {
    const item = payload.itemUuid ? fromUuidSync(payload.itemUuid) : null;
    const activity = item?.system?.activities?.get?.(payload.activityId)
      ?? activitiesOf(item).find(a => a.id === payload.activityId);
    const atk = activity?.attack?.type?.value || activity?.attack?.type || item?.system?.actionType || "";
    const text = String(atk).toLowerCase();
    if (text.includes("ranged") || text === "rwak" || text === "rsak") return false;
    if (text.includes("melee") || text === "mwak" || text === "msak") return true;
  } catch { /* ignore */ }
  return true;
}

function elementalTypes(target) {
  return (target?.damageLines ?? []).filter(line => ELEMENTAL.has(line.typeKey || line.type));
}

function takingDamage(payload, target) {
  if ((target.applied ?? 0) > 0) return true;
  if (payload.kind === "attack") return Boolean(target.hit);
  if (payload.kind === "save") return target.success !== true;
  return payload.kind === "damage";
}

function usedSet(target) {
  return new Set(target.reactionsUsed ?? []);
}

function findSpell(actor, spec) {
  return findActorItems(actor, spec).find(item => item.type === "spell") ?? null;
}

function findFeat(actor, spec) {
  return findActorItems(actor, spec).find(item => item.type === "feat")
    ?? findActorItem(actor, spec);
}

function reactionOption(id, item, actor, detail) {
  const uses = featureUses(item);
  const disabled = Boolean(uses.hasUses && uses.remaining <= 0);
  return {
    id,
    itemUuid: item?.uuid ?? "",
    name: item?.name || localize(id.split("-").map(p => p[0].toUpperCase() + p.slice(1)).join("")),
    detail,
    usesLabel: uses.hasUses ? localize("UsesLeft", { remaining: uses.remaining, max: uses.max }) : "",
    disabled,
    usesPath: uses.path
  };
}

export function listTargetReactions(payload, target, actor) {
  if (!actor || !target) return [];
  const used = usedSet(target);
  const kind = payload.kind;
  const hit = kind === "attack" && target.hit;
  const miss = kind === "attack" && target.hit === false;
  const dmg = takingDamage(payload, target);
  const elemental = elementalTypes(target);
  const options = [];
  const push = opt => {
    if (!opt || used.has(opt.id) || options.some(o => o.id === opt.id)) return;
    options.push(opt);
  };

  if (hit) {
    const shield = findSpell(actor, { identifiers: ["shield"], names: ["shield"] });
    if (shield) push(reactionOption("shield", shield, actor, localize("ReactShield")));
    const duelist = findFeat(actor, {
      identifiers: ["defensive-duelist"],
      names: ["defensive duelist"]
    });
    if (duelist && isMeleeAttack(payload)) {
      push(reactionOption("defensive-duelist", duelist, actor, localize("ReactDuelist")));
    }
    const uncanny = findFeat(actor, {
      identifiers: ["uncanny-dodge"],
      names: ["uncanny dodge"]
    });
    if (uncanny) push(reactionOption("uncanny-dodge", uncanny, actor, localize("ReactUncanny")));
    const deflect = findFeat(actor, {
      identifiers: ["deflect-attacks", "deflect-missiles", "deflect-energy"],
      names: ["deflect attacks", "deflect missiles", "deflect energy"]
    });
    if (deflect) push(reactionOption("deflect-attacks", deflect, actor, localize("ReactDeflect")));
  }

  if (kind === "attack") {
    const flare = findFeat(actor, {
      identifiers: ["warding-flare"],
      names: ["warding flare"]
    });
    if (flare) push(reactionOption("warding-flare", flare, actor, localize("ReactFlare")));
  }

  if (miss) {
    const riposte = findFeat(actor, { identifiers: ["riposte"], names: ["riposte"] });
    if (riposte) push(reactionOption("riposte", riposte, actor, localize("ReactRiposte")));
  }

  if (dmg && elemental.length) {
    const absorb = findSpell(actor, {
      identifiers: ["absorb-elements"],
      names: ["absorb elements"]
    });
    if (absorb) push(reactionOption("absorb-elements", absorb, actor, localize("ReactAbsorb")));
  }

  if (dmg) {
    const rebuke = findSpell(actor, {
      identifiers: ["hellish-rebuke"],
      names: ["hellish rebuke"]
    });
    if (rebuke) push(reactionOption("hellish-rebuke", rebuke, actor, localize("ReactRebuke")));
    const stone = findFeat(actor, {
      identifiers: ["stones-endurance", "stone-s-endurance", "stonesendurance"],
      names: ["stone's endurance", "stones endurance"]
    });
    if (stone) push(reactionOption("stones-endurance", stone, actor, localize("ReactStone")));
  }

  return options;
}

export async function useReactionItem(item) {
  if (!item) return false;
  const list = activitiesOf(item);
  const activity = list.find(a => a.activation?.type === "reaction") || list[0];
  const usage = { consume: {}, subsequentActions: false, irisReaction: true };
  const dialog = { configure: false };
  const message = { create: false };
  try {
    if (activity?.use) {
      const result = await activity.use(usage, dialog, message);
      return Boolean(result);
    }
    if (typeof item.use === "function") {
      const result = await item.use(usage, dialog, message);
      return Boolean(result);
    }
  } catch (err) {
    console.warn("iris-rolls | reaction item use", err);
  }
  return false;
}

export async function applyTargetReaction(id, payload, target, actor) {
  const options = listTargetReactions(payload, target, actor);
  const option = options.find(o => o.id === id);
  if (!option || option.disabled) return null;
  const item = option.itemUuid ? await fromUuid(option.itemUuid) : null;
  const followUp = { item, title: option.name, rolls: [], note: option.detail };
  target.reactionsUsed = [...usedSet(target), id];

  if (id === "shield") {
    target.acBonus = (Number(target.acBonus) || 0) + 5;
  } else if (id === "defensive-duelist") {
    target.acBonus = (Number(target.acBonus) || 0) + profBonus(actor);
  } else if (id === "uncanny-dodge") {
    target.reactionMult = (Number(target.reactionMult) || 1) * 0.5;
  } else if (id === "warding-flare") {
    if (target.mode === "advantage") target.mode = "normal";
    else target.mode = "disadvantage";
  } else if (id === "absorb-elements") {
    target.damageOverrides ??= {};
    for (const line of elementalTypes(target)) {
      const key = line.typeKey || line.type;
      const current = key in target.damageOverrides ? target.damageOverrides[key] : line.multiplier;
      target.damageOverrides[key] = snapMult((Number(current) || 1) * 0.5);
    }
  } else if (id === "deflect-attacks") {
    const formula = `1d10 + ${abilityMod(actor, "dex")} + ${classLevel(actor, "monk")}`;
    const roll = await new Roll(formula).evaluate();
    target.damageBonus = (Number(target.damageBonus) || 0) - (Number(roll.total) || 0);
    followUp.rolls = [roll];
    followUp.note = localize("ReactReduced", { amount: roll.total });
  } else if (id === "stones-endurance") {
    const formula = `1d12 + ${abilityMod(actor, "con")}`;
    const roll = await new Roll(formula).evaluate();
    target.damageBonus = (Number(target.damageBonus) || 0) - (Number(roll.total) || 0);
    followUp.rolls = [roll];
    followUp.note = localize("ReactReduced", { amount: roll.total });
  }

  followUp.usesPath = option.usesPath;
  return followUp;
}
