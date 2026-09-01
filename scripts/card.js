import { MODULE_ID, TEMPLATE, DIE_EDIT_TEMPLATE, localize, renderHbs, getPayload, hasPayload, state } from "./constants.js";
import { describeActor, resolveTargets, pickSaveAbility, hasEvasion, isDexSave, maxTargetCount, liveTemplateUuids, tokensInTemplates, targetsFromTokens, selectTokens, setRollerFromActor, placeActivityTemplates, deleteTemplates, actorFromTarget, actorFromTargetSync } from "./targets.js";
import { dualFromRoll, usedDieIndex, rollTotal, damageTotal, selectDamage, rollQuiet, rollNormalAndCritDamage, rollD20Face, formatDamageTooltip, formatPartsTooltip } from "./dice.js";
import { listDieOptions, consumeDieOption, consumeFeatureUse } from "./features.js";
import { listTargetReactions, applyTargetReaction, useReactionItem } from "./reactions.js";
import {
  listSlotOptions, listSpellPointOptions, remainingConsumption, remainingResources, ownedUpdate, restoreRecord,
  refundRemaining, refundResources, consumeSpellSlot, consumeSpellPoints, scaledActivity, slotLevelLabel,
  getSpellPointsItem, spellPointCostForLevel, spellPointsRemaining, slotKeyLevel
} from "./resources.js";

function isApplyableEffect(effect) {
  if (!effect) return false;
  if (effect.type === "enchantment") return false;
  if (effect.getFlag?.("dnd5e", "type") === "enchantment") return false;
  return true;
}

export function collectApplyableEffects(item, activity=null) {
  const fromActivity = (activity?.applicableEffects ?? []).filter(isApplyableEffect);
  if (fromActivity.length) return fromActivity;
  const ids = [...(activity?.effects ?? [])].map(entry => entry?._id || entry?.id).filter(Boolean);
  const byId = ids.map(id => item?.effects?.get(id)).filter(isApplyableEffect);
  if (byId.length) return byId;
  return [...(item?.effects ?? [])].filter(isApplyableEffect);
}

function canEdit(message) {
  return game.user.isGM || message.isAuthor;
}

function snapshotTargetRoll(kind, target, payload={}) {
  if (kind === "attack") {
    const d20 = target.d20 ?? payload.d20;
    if (!Array.isArray(d20)) return null;
    return {
      d20: [...d20],
      bonus: target.bonus ?? payload.bonus,
      mode: target.mode ?? payload.mode ?? "normal",
      situational: target.situational ?? payload.situational ?? 0,
      damageOverrides: { ...(target.damageOverrides ?? {}) },
      acBonus: target.acBonus ?? 0,
      damageBonus: target.damageBonus ?? 0,
      reactionMult: target.reactionMult ?? 1,
      reactionsUsed: [...(target.reactionsUsed ?? [])]
    };
  }
  if (kind === "save" && Array.isArray(target.saveD20)) {
    return {
      saveD20: [...target.saveD20],
      saveBonus: target.saveBonus,
      saveAbility: target.saveAbility,
      saveMode: target.saveMode ?? "normal",
      saveSituational: target.saveSituational ?? 0,
      evasion: target.evasion,
      damageOverrides: { ...(target.damageOverrides ?? {}) },
      acBonus: target.acBonus ?? 0,
      damageBonus: target.damageBonus ?? 0,
      reactionMult: target.reactionMult ?? 1,
      reactionsUsed: [...(target.reactionsUsed ?? [])]
    };
  }
  return null;
}

function asCacheList(payload) {
  if (!Array.isArray(payload.rollCache)) payload.rollCache = [];
  return payload.rollCache;
}

function cacheMatch(entry, target) {
  if (!entry || !target) return false;
  const token = target.tokenUuid || "";
  const cached = entry.tokenUuid || "";
  if (token && cached) return token === cached;
  if (token || cached) return false;
  return Boolean(target.uuid && entry.uuid && target.uuid === entry.uuid);
}

function rememberTarget(payload, target) {
  const snap = snapshotTargetRoll(payload.kind, target, payload) ?? {};
  if (target.damageOverrides) snap.damageOverrides = { ...target.damageOverrides };
  if (!(target.tokenUuid || target.uuid)) return;
  if (!snap.d20 && !snap.saveD20 && !Object.keys(snap.damageOverrides ?? {}).length) return;
  const list = asCacheList(payload);
  const entry = {
    uuid: target.uuid || "",
    tokenUuid: target.tokenUuid || "",
    ...snap
  };
  const index = list.findIndex(e => cacheMatch(e, target));
  if (index >= 0) list[index] = entry;
  else list.push(entry);
}

export function rememberTargets(payload) {
  for (const target of payload.targets ?? []) rememberTarget(payload, target);
}

function restoreTargetRoll(payload, target) {
  const entry = asCacheList(payload).find(e => cacheMatch(e, target));
  if (!entry) return false;
  if (entry.damageOverrides) target.damageOverrides = { ...entry.damageOverrides };
  if (entry.acBonus != null) target.acBonus = entry.acBonus;
  if (entry.damageBonus != null) target.damageBonus = entry.damageBonus;
  if (entry.reactionMult != null) target.reactionMult = entry.reactionMult;
  if (entry.reactionsUsed) target.reactionsUsed = [...entry.reactionsUsed];
  if (payload.kind === "attack" && entry.d20) {
    target.d20 = [...entry.d20];
    target.bonus = entry.bonus;
    target.mode = entry.mode ?? "normal";
    target.situational = entry.situational ?? 0;
    return true;
  }
  if (payload.kind === "save" && entry.saveD20) {
    target.saveD20 = [...entry.saveD20];
    target.saveBonus = entry.saveBonus;
    target.saveAbility = entry.saveAbility;
    target.saveMode = entry.saveMode ?? "normal";
    target.saveSituational = entry.saveSituational ?? 0;
    if (entry.evasion != null) target.evasion = entry.evasion;
    return true;
  }
  return false;
}

export async function fillTargetAttack(target, activity) {
  if (!activity) return [];
  const rolls = await rollQuiet(activity, "rollAttack");
  if (rolls[0]) {
    const dual = await dualFromRoll(rolls[0]);
    target.d20 = dual.d20;
    target.bonus = dual.bonus;
  }
  target.mode ??= "normal";
  target.situational ??= 0;
  return rolls;
}

export async function fillTargetSave(target, activity, dc, saveAbilities=[]) {
  const actor = await actorFromTarget(target);
  if (!actor) return [];
  const ability = activity
    ? pickSaveAbility(activity, actor)
    : (saveAbilities[0] ?? target.saveAbility ?? "dex");
  const rolls = await rollQuiet(actor, "rollSavingThrow", { ability, target: dc });
  if (rolls[0]) {
    const dual = await dualFromRoll(rolls[0]);
    target.saveD20 = dual.d20;
    target.saveBonus = dual.bonus;
  }
  target.saveAbility = ability;
  target.evasion = hasEvasion(actor);
  target.saveMode ??= "normal";
  target.saveSituational ??= 0;
  target.img = describeActor(actor).img;
  target.ac = actor.system?.attributes?.ac?.value ?? target.ac;
  return rolls;
}

export async function hydrateTargetRolls(payload, activity) {
  const rolls = [];
  for (const target of payload.targets ?? []) {
    if (restoreTargetRoll(payload, target)) continue;
    if (payload.kind === "attack" && Array.isArray(payload.d20) && !Array.isArray(target.d20)) {
      target.d20 = [...payload.d20];
      target.bonus = payload.bonus;
      target.mode = payload.mode ?? "normal";
      target.situational = payload.situational ?? 0;
      delete payload.d20;
      rememberTarget(payload, target);
      continue;
    }
    if (payload.kind === "attack") rolls.push(...await fillTargetAttack(target, activity));
    else if (payload.kind === "save") {
      rolls.push(...await fillTargetSave(target, activity, payload.dc, payload.saveAbilities));
    }
    rememberTarget(payload, target);
  }
  return rolls;
}

function abilityLabel(ability) {
  return game.i18n.localize(CONFIG.DND5E.abilities[ability]?.label ?? ability ?? "");
}

function skillLabel(skill) {
  return game.i18n.localize(CONFIG.DND5E.skills[skill]?.label ?? skill ?? "");
}

function previewDamage(actor, parts, multiplier) {
  const empty = { amount: 0, immune: false, resistant: false, vulnerable: false };
  if (!actor || !parts?.length) return empty;
  if (multiplier === 0) return empty;
  const damages = parts.map(p => ({
    value: Number(p.total) || 0,
    type: p.type || undefined,
    properties: new Set(p.properties ?? [])
  }));
  if (typeof actor.calculateDamage !== "function") {
    const raw = damageTotal(parts) * multiplier;
    return { ...empty, amount: raw > 0 ? Math.floor(raw) : Math.ceil(raw) };
  }
  const calculated = actor.calculateDamage(damages, { multiplier });
  if (!calculated) return empty;
  let amount = 0;
  let immune = false;
  let resistant = false;
  let vulnerable = false;
  for (const d of calculated) {
    if (d.type === "temphp") continue;
    amount += d.value ?? 0;
    if (d.active?.immunity) immune = true;
    if (d.active?.resistance) resistant = true;
    if (d.active?.vulnerability) vulnerable = true;
  }
  amount = amount > 0 ? Math.floor(amount) : Math.ceil(amount);
  return { amount, immune, resistant, vulnerable };
}

const MULT_STEPS = [0, 0.25, 0.5, 1, 2];

function typeKey(type) {
  return type || "none";
}

function snapMultiplier(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return MULT_STEPS.reduce((best, step) => Math.abs(step - n) < Math.abs(best - n) ? step : best);
}

function groupDamageParts(parts=[]) {
  const groups = new Map();
  for (const part of parts) {
    const key = typeKey(part.type);
    const cur = groups.get(key) ?? { type: part.type || "", total: 0, properties: new Set() };
    cur.total += Number(part.total) || 0;
    for (const prop of part.properties ?? []) cur.properties.add(prop);
    groups.set(key, cur);
  }
  return [...groups.values()];
}

function probeTraits(actor, type, properties) {
  const empty = { immune: false, resistant: false, vulnerable: false, trait: 1 };
  if (!actor || typeof actor.calculateDamage !== "function") return empty;
  const calculated = actor.calculateDamage([{
    value: 100,
    type: type || undefined,
    properties: properties instanceof Set ? properties : new Set(properties ?? [])
  }], { multiplier: 1 });
  const row = calculated?.[0];
  if (!row) return empty;
  const immune = Boolean(row.active?.immunity);
  const resistant = Boolean(row.active?.resistance);
  const vulnerable = Boolean(row.active?.vulnerability);
  let trait = 1;
  if (immune) trait = 0;
  else {
    if (resistant) trait *= 0.5;
    if (vulnerable) trait *= 2;
  }
  return { immune, resistant, vulnerable, trait };
}

function damageTypeLabel(type) {
  if (!type) return localize("Damage");
  const cfg = CONFIG.DND5E?.damageTypes?.[type] ?? CONFIG.DND5E?.healingTypes?.[type];
  const raw = cfg?.label ?? type;
  return game.i18n.has?.(raw) ? game.i18n.localize(raw) : raw;
}

function assignTargetDamage(payload, target, actor, parts) {
  const hitContext = payload.kind === "attack"
    ? (target.hit ? 1 : 0)
    : payload.kind === "save" ? (target.multiplier ?? 1) : 1;
  const context = hitContext * (Number(target.reactionMult) || 1);
  const overrides = target.damageOverrides ?? {};
  const lines = [];
  let immune = false;
  let resistant = false;
  let vulnerable = false;
  let amount = 0;
  for (const group of groupDamageParts(parts)) {
    const traits = probeTraits(actor, group.type, group.properties);
    const def = snapMultiplier(context * traits.trait);
    const key = typeKey(group.type);
    const overridden = key in overrides;
    const multiplier = overridden ? snapMultiplier(overrides[key]) : def;
    immune ||= traits.immune;
    resistant ||= traits.resistant;
    vulnerable ||= traits.vulnerable;
    const raw = group.total * multiplier;
    const taken = raw > 0 ? Math.floor(raw) : Math.ceil(raw);
    amount += taken;
    lines.push({
      type: group.type,
      typeKey: key,
      total: group.total,
      defaultMult: def,
      multiplier,
      overridden,
      immune: traits.immune,
      resistant: traits.resistant,
      vulnerable: traits.vulnerable,
      taken
    });
  }
  target.damageLines = lines;
  const extra = (Number(payload.damageBonus) || 0) + (Number(target.damageBonus) || 0);
  const canTake = lines.some(line => line.multiplier > 0);
  target.applied = canTake ? Math.max(0, amount + extra) : 0;
  target.immune = immune;
  target.resistant = resistant;
  target.vulnerable = vulnerable;
  if (lines.length === 1) target.multiplier = lines[0].multiplier;
  return lines;
}

function saveMultiplier(payload, target) {
  const onSave = payload.onSave ?? "half";
  const evasionApplies = Boolean(target.evasion) && isDexSave(payload, target) && onSave === "half";
  target.evasionApplies = evasionApplies;
  if (target.success) {
    if (evasionApplies) return 0;
    if (onSave === "none") return 0;
    if (onSave === "half") return 0.5;
    return 1;
  }
  return evasionApplies ? 0.5 : 1;
}

function attackRollOf(target, payload) {
  return {
    d20: target.d20 ?? payload.d20,
    mode: target.mode ?? payload.mode ?? "normal",
    bonus: target.bonus ?? payload.bonus ?? 0,
    situational: target.situational ?? payload.situational ?? 0
  };
}

function saveRollOf(target) {
  return {
    d20: target.saveD20,
    mode: target.saveMode ?? "normal",
    bonus: target.saveBonus ?? 0,
    situational: target.saveSituational ?? 0
  };
}

export function computeOutcomes(payload) {
  const minFace = payload.reliableTalent ? 10 : 0;
  const shared = rollTotal(payload.d20, payload.mode ?? "normal", payload.bonus, payload.situational, { minFace });
  const critThreshold = payload.critThreshold ?? 20;
  const sharedParts = selectDamage(payload).parts;
  let anyCrit = false;
  let anyFumble = false;

  for (const target of payload.targets ?? []) {
    const actor = actorFromTargetSync(target);
    if (actor && target.evasion == null) target.evasion = hasEvasion(actor);

    if (payload.kind === "attack") {
      if (!Array.isArray(target.d20) && Array.isArray(payload.d20)) {
        target.d20 = [...payload.d20];
        target.bonus ??= payload.bonus;
        target.mode ??= payload.mode ?? "normal";
        target.situational ??= payload.situational ?? 0;
      }
      const attack = attackRollOf(target, payload);
      const { index, face, total } = rollTotal(attack.d20, attack.mode, attack.bonus, attack.situational);
      const isFumble = Array.isArray(attack.d20) && face === 1;
      const isCrit = Array.isArray(attack.d20) && !isFumble && face >= critThreshold;
      const baseAc = Number(target.ac);
      const ac = Number.isFinite(baseAc) ? baseAc + (Number(target.acBonus) || 0) : target.ac;
      target.usedIndex = index;
      target.displayTotal = total;
      target.isCrit = isCrit;
      target.isFumble = isFumble;
      if (isFumble) {
        target.outcome = "miss";
        target.hit = false;
      } else if (isCrit || (Number.isFinite(ac) && total >= ac)) {
        target.outcome = isCrit ? "crit" : "hit";
        target.hit = true;
      } else {
        target.outcome = "miss";
        target.hit = false;
      }
      target.multiplier = target.hit ? 1 : 0;
      anyCrit ||= isCrit && target.hit;
      anyFumble ||= isFumble;
    } else if (payload.kind === "save" && target.saveD20) {
      const save = saveRollOf(target);
      const { index, face, total } = rollTotal(save.d20, save.mode, save.bonus, save.situational);
      target.usedIndex = index;
      target.saveFace = face;
      target.saveTotal = total;
      target.success = total >= (payload.dc ?? 0);
      target.outcome = target.success ? "success" : "failure";
      target.multiplier = saveMultiplier(payload, target);
    } else if (payload.dc != null && ["skill", "check", "ability", "tool"].includes(payload.kind)) {
      target.success = shared.total >= payload.dc;
      target.outcome = target.success ? "success" : "failure";
      target.multiplier = 1;
    } else {
      target.multiplier ??= 1;
    }

    const parts = payload.kind === "attack" ? selectDamage(payload, target).parts : sharedParts;
    if (["attack", "save", "damage"].includes(payload.kind) && parts?.length) {
      assignTargetDamage(payload, target, actor, parts);
    } else {
      const preview = previewDamage(actor, parts, target.multiplier ?? 1);
      target.applied = preview.amount;
      target.immune = preview.immune;
      target.resistant = preview.resistant;
      target.vulnerable = preview.vulnerable;
      target.damageLines = [];
    }
  }

  payload.displayTotal = shared.total;
  payload.usedIndex = shared.index;
  payload.isCrit = payload.kind === "attack" ? anyCrit : shared.face >= critThreshold && shared.face !== 1;
  payload.isFumble = payload.kind === "attack" ? anyFumble : shared.face === 1;
  if (payload.kind === "concentration" || payload.kind === "savingThrow") {
    if (payload.dc != null) {
      payload.success = shared.total >= (payload.dc ?? 10);
      payload.outcome = payload.success ? "success" : "failure";
    }
  }
  return payload;
}

function outcomeCopy(outcome, { isSave=false }={}) {
  if (outcome === "crit") return localize("Crit");
  if (outcome === "hit") return localize("Hit");
  if (outcome === "miss") return localize("Miss");
  if (outcome === "success") return isSave ? localize("Save") : localize("Success");
  if (outcome === "failure") return isSave ? localize("NoSave") : localize("Failure");
  return "";
}

function miniDice(values=[], mode="normal", { critThreshold=20, minFace=0, clickable=true }={}) {
  const used = usedDieIndex(values, mode);
  return values.map((value, i) => {
    const isUsed = i === used;
    const shown = isUsed && minFace > 0 ? Math.max(Number(value) || 0, minFace) : value;
    const floored = isUsed && shown !== value;
    return {
      value: shown,
      index: i,
      clickable: Boolean(clickable && isUsed),
      css: [
        isUsed ? "used" : "unused",
        isUsed && clickable ? "iris-die-edit" : "",
        floored ? "floored" : "",
        isUsed && shown >= critThreshold ? "crit" : "",
        isUsed && shown === 1 ? "fumble" : ""
      ].filter(Boolean).join(" "),
      label: floored ? localize("ReliableTalent") : isUsed ? localize("UsedDie") : localize("UnusedDie")
    };
  });
}

export function viewModel(payload) {
  computeOutcomes(payload);
  const damage = selectDamage(payload);
  const isHeal = payload.kind === "heal";
  const isSave = payload.kind === "save";
  const isConcentration = payload.kind === "concentration";
  const hasEffects = Boolean(payload.effects?.length) || payload.kind === "utility";
  const effectLabel = payload.effects?.[0]?.name || "";
  const onSaveKey = payload.onSave === "none" ? "None" : payload.onSave === "full" ? "Full" : payload.onSave ? "Half" : null;
  const perTargetRolls = payload.kind === "attack" || isSave;
  const hasD20 = Array.isArray(payload.d20) && payload.d20.length >= 2 && !perTargetRolls;
  const consumption = payload.consumption;
  const spRec = consumption?.spellPoints;
  const spLabel = spRec && !spRec.restored
    ? localize("SpellPointsUsed", { amount: spRec.cost, name: spRec.label })
    : "";
  const canRefund = remainingResources(consumption).length > 0;
  const consumeLabel = [spLabel, ...remainingResources(consumption).map(r => r.label).filter(Boolean)].filter(Boolean).join(", ");
  let slotOptions = [];
  const showSlots = Boolean(consumption?.canScale && (consumption?.spellSlot || consumption?.spellPoints)) && !isConcentration;
  if (showSlots) {
    try {
      const actor = fromUuidSync(payload.roller?.uuid);
      const item = payload.itemUuid ? fromUuidSync(payload.itemUuid) : null;
      if (actor && item && consumption?.spellPoints) {
        slotOptions = listSpellPointOptions(actor, item, consumption.spellPoints);
      } else if (actor && item) {
        slotOptions = listSlotOptions(actor, item, consumption?.spellSlot?.key);
      }
    } catch { /* actor or item may not be loaded */ }
  }
  let versus = "";
  if (payload.kind === "attack" && payload.targets?.length === 1 && payload.targets[0].ac != null) {
    const t0 = payload.targets[0];
    versus = localize("Versus", { value: localize("AC", { ac: (Number(t0.ac) || 0) + (Number(t0.acBonus) || 0) }) });
  } else if ((hasD20 || isConcentration) && payload.dc != null) {
    versus = localize("Versus", { value: localize("DC", { dc: payload.dc }) });
  }

  return {
    title: payload.title,
    subtitle: payload.subtitle,
    itemImg: payload.itemImg,
    roller: payload.roller,
    dc: payload.dc,
    isSave,
    isConcentration,
    hideTargets: isConcentration,
    hideRetarget: isConcentration,
    manyTargets: (payload.targets ?? []).length > 1,
    targets: (payload.targets ?? []).map(t => {
      const tags = [];
      if (t.evasionApplies) tags.push({ label: localize("Evasion"), css: "evasion" });
      const lines = t.damageLines ?? [];
      const allImmune = lines.length > 0 && lines.every(line => line.immune);
      const allResist = lines.length > 0 && lines.every(line => line.resistant);
      const anyVuln = lines.some(line => line.vulnerable);
      const anyImmune = lines.some(line => line.immune);
      const anyResist = lines.some(line => line.resistant);
      if (allImmune || (anyImmune && lines.length === 1)) tags.push({ label: localize("Immune"), css: "immune" });
      else if (allResist || (anyResist && lines.length === 1)) tags.push({ label: localize("Resistant"), css: "resist" });
      if (anyVuln && (lines.length === 1 || lines.every(line => line.vulnerable))) tags.push({ label: localize("Vulnerable"), css: "vuln" });
      let appliedLabel = "";
      if (isSave || payload.kind === "attack" || payload.kind === "damage") {
        const lines = t.damageLines ?? [];
        const allImmune = lines.length > 0 && lines.every(line => line.immune);
        const allHalf = lines.length > 0 && lines.every(line => line.multiplier === 0.5);
        const allZero = lines.length > 0 && lines.every(line => line.multiplier === 0);
        if (allImmune && (t.applied ?? 0) === 0) appliedLabel = localize("Takes", { amount: `0 (${localize("Immune")})` });
        else if (t.evasionApplies && t.success && (t.applied ?? 0) === 0) appliedLabel = localize("Takes", { amount: `0 (${localize("Evasion")})` });
        else if (allZero) appliedLabel = localize("Takes", { amount: `0 (${localize("NoDamage")})` });
        else if (allHalf) appliedLabel = localize("Takes", { amount: `${t.applied ?? 0} (${localize("Half")})` });
        else appliedLabel = localize("Takes", { amount: String(t.applied ?? 0) });
      }
      const attackMode = t.mode ?? payload.mode ?? "normal";
      const saveMode = t.saveMode ?? "normal";
      const showTargetModes = (payload.kind === "attack" && Array.isArray(t.d20))
        || (isSave && Array.isArray(t.saveD20));
      const targetDice = payload.kind === "attack" && t.d20
        ? miniDice(t.d20, attackMode, { critThreshold: payload.critThreshold ?? 20, clickable: true })
        : isSave && t.saveD20 ? miniDice(t.saveD20, saveMode, { clickable: true }) : null;
      const damageMods = (t.damageLines ?? []).map(line => ({
        type: line.type,
        typeKey: line.typeKey,
        typeLabel: damageTypeLabel(line.type),
        targetKey: t.tokenUuid || t.uuid,
        total: line.total,
        taken: line.taken,
        choices: [
          { value: 0, label: "0" },
          { value: 0.25, label: "1/4" },
          { value: 0.5, label: "1/2" },
          { value: 1, label: "1" },
          { value: 2, label: "2" }
        ].map(choice => ({
          ...choice,
          selected: choice.value === line.multiplier
        }))
      }));
      const actor = actorFromTargetSync(t);
      const reactions = ["attack", "save", "damage"].includes(payload.kind)
        ? listTargetReactions(payload, t, actor)
        : [];
      return {
        ...t,
        outcomeLabel: outcomeCopy(t.outcome, { isSave }),
        outcomeClass: t.outcome ?? "",
        targetDice,
        attackDetail: payload.kind === "attack" && t.displayTotal != null && t.ac != null
          ? localize("AttackVs", { total: t.displayTotal, ac: (Number(t.ac) || 0) + (Number(t.acBonus) || 0) })
          : "",
        saveDetail: isSave && t.saveTotal != null
          ? localize("SaveVs", { total: t.saveTotal, dc: payload.dc ?? 0 })
          : "",
        targetKey: t.tokenUuid || t.uuid,
        showTargetModes,
        modeNormal: isSave ? saveMode === "normal" : attackMode === "normal",
        modeAdvantage: isSave ? saveMode === "advantage" : attackMode === "advantage",
        modeDisadvantage: isSave ? saveMode === "disadvantage" : attackMode === "disadvantage",
        targetBonus: isSave ? (t.saveSituational ?? 0) : (t.situational ?? 0),
        tags,
        appliedLabel,
        damageMods,
        showReact: reactions.length > 0 && !(t.reactionsUsed?.length),
        diceTooltip: formatPartsTooltip(
          payload.kind === "attack" ? selectDamage(payload, t).parts : (damage.parts ?? []),
          (Number(payload.damageBonus) || 0) + (Number(t.damageBonus) || 0)
        )
      };
    }),
    hasD20,
    showModes: hasD20,
    reliableTalentApplied: Boolean(payload.reliableTalent && Number(payload.d20?.[payload.usedIndex]) < 10),
    dice: (payload.d20 ?? []).map((value, i) => {
      const used = i === payload.usedIndex;
      const shown = used && payload.reliableTalent ? Math.max(Number(value) || 0, 10) : value;
      const floored = used && shown !== value;
      const css = [
        used ? "used" : "unused",
        used ? "iris-die-edit" : "",
        floored ? "floored" : "",
        shown >= (payload.critThreshold ?? 20) ? "crit" : "",
        shown === 1 ? "fumble" : ""
      ].filter(Boolean).join(" ");
      return {
        value: shown,
        index: i,
        clickable: used,
        css,
        label: floored ? localize("ReliableTalent") : used ? localize("UsedDie") : localize("UnusedDie")
      };
    }),
    displayTotal: payload.displayTotal,
    versus,
    modeNormal: payload.mode === "normal",
    modeAdvantage: payload.mode === "advantage",
    modeDisadvantage: payload.mode === "disadvantage",
    situational: payload.situational ?? 0,
    hasDamage: Boolean(damage.parts?.length),
    hasApply: Boolean(damage.parts?.length) || hasEffects,
    isCrit: payload.kind === "attack"
      ? (payload.targets ?? []).some(t => t.outcome === "crit")
      : Boolean(damage.isCrit),
    damageLabel: payload.kind === "attack"
      ? localize("Damage")
      : damage.isCrit
        ? localize("CriticalDamage")
        : isHeal ? localize("Healing") : localize("Damage"),
    damageLines: (damage.parts ?? []).map(p => ({
      formula: p.formula,
      type: p.type,
      total: p.total,
      used: true,
      tooltip: formatDamageTooltip(p)
    })),
    otherDamageLines: [],
    damageBonus: Number(payload.damageBonus) || 0,
    damageBase: damageTotal(damage.parts),
    damageTotal: damageTotal(damage.parts) + (Number(payload.damageBonus) || 0),
    damageTooltip: formatPartsTooltip(damage.parts ?? [], payload.damageBonus),
    critDamageLines: payload.kind === "attack" && (payload.targets ?? []).some(t => t.outcome === "crit")
      ? ((payload.critDamage?.a ?? payload.critDamage?.b) ?? []).map(p => ({
        formula: p.formula,
        type: p.type,
        total: p.total,
        tooltip: formatDamageTooltip(p)
      }))
      : [],
    critDamageTooltip: payload.kind === "attack"
      ? formatPartsTooltip(payload.critDamage?.a ?? payload.critDamage?.b ?? [], payload.damageBonus)
      : "",
    critDamageTotal: (payload.kind === "attack"
      ? damageTotal(payload.critDamage?.a ?? payload.critDamage?.b ?? [])
      : 0) + (Number(payload.damageBonus) || 0),
    onSaveLabel: isSave && onSaveKey ? localize("OnSave", { mode: localize(onSaveKey) }) : "",
    applyLabel: isConcentration ? localize("Apply")
      : hasEffects && !damage.parts?.length
        ? (effectLabel ? localize("ApplyNamed", { name: effectLabel }) : localize("ApplyEffect"))
      : isHeal ? localize("ApplyHealing") : localize("ApplyDamage"),
    effectLabel,
    showDropConcentration: isConcentration && !payload.success && !payload.concentrationDropped,
    concentrationHeld: isConcentration && payload.success,
    concentrationDropped: Boolean(payload.concentrationDropped),
    spellName: payload.spellName || "",
    showSlots: showSlots && slotOptions.length > 0,
    slotLabel: consumption?.spellPoints ? localize("CastLevel") : localize("Slot"),
    slotOptions,
    consumeLabel,
    canRefund,
    damageApplied: Boolean(payload.damageApplied || payload.effectsApplied),
    showUndo: !isConcentration && !payload.undone && (
      Boolean(damage.parts?.length) || hasEffects || canRefund || remainingConsumption(consumption).length > 0
      || Boolean(payload.appliedLog?.length) || Boolean(payload.appliedEffects?.length)
    ),
    showLore: Boolean(payload.itemUuid),
    hasTemplate: liveTemplateUuids(payload.templateUuids).length > 0,
    showAgain: payload.kind !== "concentration"
  };
}

export async function renderCard(payload) {
  return renderHbs(TEMPLATE, viewModel(foundry.utils.deepClone(payload)));
}

export async function postConcentrationCard(rolls, actor) {
  if (!actor) return;
  if (!actor.concentration?.effects?.size) {
    ui.notifications.info(localize("NotConcentrating", { name: actor.name }));
    return;
  }
  const roll = Array.isArray(rolls) ? rolls[0] : rolls;
  if (!roll) return;
  const dual = await dualFromRoll(roll);
  const items = [...(actor.concentration.items ?? [])];
  const effects = [...(actor.concentration.effects ?? [])];
  const item = items[0];
  const effect = effects[0];
  const spellName = item?.name || String(effect?.name ?? "").replace(/^.*?:\s*/, "") || localize("Concentration");
  return postCard({
    kind: "concentration",
    mode: "normal",
    title: actor.name,
    subtitle: localize("ConcentratingOn", { name: spellName }),
    itemImg: item?.img || actor.img,
    itemUuid: item?.uuid ?? "",
    roller: describeActor(actor),
    targets: [],
    d20: dual.d20,
    bonus: dual.bonus,
    situational: 0,
    critThreshold: 20,
    dc: roll.options?.target ?? 10,
    spellName,
    effectId: effect?.id ?? "",
    actorUuid: actor.uuid
  }, { actor, rolls: [roll] });
}

export async function applyConcentrationBreak(message) {
  const payload = foundry.utils.deepClone(getPayload(message));
  computeOutcomes(payload);
  if (payload.success || payload.concentrationDropped) return;
  const actor = await fromUuid(payload.actorUuid);
  if (!actor) return;
  if (!(game.user.isGM || actor.isOwner || actor.canUserModify?.(game.user, "update"))) {
    game.socket.emit(`module.${MODULE_ID}`, {
      op: "endConcentration",
      actorUuid: actor.uuid,
      effectId: payload.effectId || null
    });
    payload.concentrationDropped = true;
    await refreshMessage(message, payload);
    return;
  }
  await actor.endConcentration(payload.effectId || undefined);
  payload.concentrationDropped = true;
  await refreshMessage(message, payload);
  ui.notifications.info(localize("ConcentrationDropped", { name: payload.spellName || actor.name }));
}

function actorFromChatMessage(message) {
  if (!message) return null;
  return ChatMessage.getSpeakerActor?.(message.speaker)
    ?? (message.speaker?.actor ? game.actors.get(message.speaker.actor) : null);
}

export async function handleConcentrationButton(button) {
  const message = messageFromElement(button);
  let actor = actorFromChatMessage(message);
  if (!actor && button.closest("[data-message-id]")) {
    const tokenId = message?.speaker?.token;
    const sceneId = message?.speaker?.scene;
    if (tokenId && sceneId) {
      try { actor = fromUuidSync(`Scene.${sceneId}.Token.${tokenId}`)?.actor; } catch {}
    }
  }
  if (!actor) {
    ui.notifications.warn(localize("FailedCard"));
    return;
  }
  if (!actor.concentration?.effects?.size) {
    ui.notifications.info(localize("NotConcentrating", { name: actor.name }));
    return;
  }
  const dc = Number(button.dataset.dc) || 10;
  const ability = button.dataset.ability || undefined;
  await actor.rollConcentration(
    { target: dc, ability, isConcentration: true },
    { configure: false },
    { create: false }
  );
}

export async function postCard(payload, { actor, rolls=[] }={}) {
  computeOutcomes(payload);
  const content = await renderCard(payload);
  const cls = getDocumentClass("ChatMessage");
  const created = await cls.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content,
    rolls,
    sound: CONFIG.sounds.dice,
    flags: { [MODULE_ID]: payload }
  });
  if (created && !getPayload(created).kind) {
    await created.update({ [`flags.${MODULE_ID}`]: payload });
  }
  return created;
}

export async function refreshMessage(message, payload) {
  computeOutcomes(payload);
  const content = await renderCard(payload);
  return message.update({
    content,
    [`flags.${MODULE_ID}`]: payload
  });
}

async function applyDamages(actor, parts, multiplier, { ignoreTraits=false }={}) {
  const damages = parts.map(p => ({
    value: Number(p.total) || 0,
    type: p.type || undefined,
    properties: new Set(p.properties ?? [])
  }));
  const options = { multiplier };
  if (ignoreTraits) {
    options.ignore = { immunity: true, resistance: true, vulnerability: true };
  }
  if (game.user.isGM || actor.isOwner || actor.canUserModify?.(game.user, "update")) {
    return actor.applyDamage(damages, options);
  }
  game.socket.emit(`module.${MODULE_ID}`, {
    op: "applyDamage",
    actorUuid: actor.uuid,
    damages: damages.map(d => ({ ...d, properties: [...d.properties] })),
    options
  });
}

function hpSnap(actor) {
  const hp = actor?.system?.attributes?.hp;
  if (!hp) return null;
  return { value: Number(hp.value) || 0, temp: Number(hp.temp) || 0 };
}

function applyTargetList(payload) {
  const list = payload.targets ?? [];
  const max = Number(payload.maxTargets);
  if (Number.isFinite(max) && max > 0 && list.length > max) return list.slice(0, max);
  return list;
}

function extraBonus(payload, target) {
  return (Number(payload.damageBonus) || 0) + (Number(target?.damageBonus) || 0);
}

function applyDamageBonusToParts(parts, bonus) {
  const n = Number(bonus) || 0;
  if (!n) return parts;
  if (n > 0) return [...parts, { total: n, type: "" }];
  let left = -n;
  const next = [];
  for (const part of parts) {
    const total = Number(part.total) || 0;
    if (left <= 0) {
      next.push(part);
      continue;
    }
    const take = Math.min(total, left);
    left -= take;
    if (total - take > 0) next.push({ ...part, total: total - take });
  }
  return next;
}

export async function applyCardDamage(message, actionEl=null) {
  const payload = foundry.utils.deepClone(getPayload(message));
  if (payload.damageApplied) return;
  if (actionEl) payload.situational = bonusFromCard(actionEl, payload);
  computeOutcomes(payload);
  const { parts: fallbackParts } = selectDamage(payload);
  if (!fallbackParts.length && payload.kind !== "attack") {
    ui.notifications.warn(localize("FailedDamage"));
    return;
  }

  const targets = applyTargetList(payload);
  if (!targets.length) {
    ui.notifications.warn(localize("NoTargets"));
    return;
  }

  payload.appliedLog ??= [];
  let applied = 0;
  for (const target of targets) {
    const actor = await actorFromTarget(target);
    if (!actor) continue;
    const { parts } = selectDamage(payload, payload.kind === "attack" ? target : null);
    if (!parts.length) continue;
    const perType = ["attack", "save", "damage"].includes(payload.kind);
    const lines = perType
      ? (target.damageLines?.length ? target.damageLines : assignTargetDamage(payload, target, actor, parts))
      : [];
    const applicable = lines.filter(line => line.multiplier > 0);
    if (payload.kind === "attack" && !target.hit && !applicable.length) continue;
    if (perType && !applicable.length) continue;
    try {
      const before = hpSnap(actor);
      if (perType) {
        const grouped = applicable.flatMap(line => parts
          .filter(p => typeKey(p.type) === line.typeKey)
          .map(p => ({ ...p, total: (Number(p.total) || 0) * line.multiplier })));
        if (!grouped.length && extraBonus(payload, target) === 0) continue;
        const adjusted = applyDamageBonusToParts(grouped, extraBonus(payload, target));
        if (!adjusted.length) continue;
        await applyDamages(actor, adjusted, 1, { ignoreTraits: true });
      } else {
        await applyDamages(actor, parts, target.multiplier ?? 1);
      }
      const fresh = fromUuidSync(actor.uuid) ?? actor;
      const after = hpSnap(fresh);
      const amount = target.applied ?? (perType
        ? applicable.reduce((sum, line) => sum + (line.taken || 0), 0)
        : Math.floor(Math.abs(damageTotal(parts) * (target.multiplier ?? 1))));
      let deltaValue = after && before ? after.value - before.value : 0;
      let deltaTemp = after && before ? after.temp - before.temp : 0;
      if (!deltaValue && !deltaTemp && amount) {
        deltaValue = payload.kind === "heal" ? amount : -amount;
      }
      payload.appliedLog.push({
        uuid: actor.uuid,
        name: actor.name,
        amount,
        deltaValue,
        deltaTemp
      });
      const key = payload.kind === "heal" ? "HealingApplied" : "DamageApplied";
      ui.notifications.info(localize(key, { amount, name: actor.name }));
      applied += 1;
    } catch (err) {
      console.error(`${MODULE_ID} | apply damage`, err);
      ui.notifications.error(localize("FailedDamage"));
    }
  }
  if (!applied) {
    ui.notifications.warn(localize("NothingApplied"));
    return;
  }
  payload.damageApplied = true;
  await refreshMessage(message, payload);
}

async function applyEffectToActor(effect, actor, origin, payload) {
  const originUuid = origin?.uuid ?? effect.uuid;
  const existing = actor.effects.find(e => e.origin === originUuid && e.name === effect.name);
  const duration = effect.constructor.getInitialDuration?.() ?? {};
  const effectFlags = {
    flags: {
      dnd5e: {
        scaling: payload.consumption?.scaling ?? 0
      }
    }
  };
  if (existing) {
    await existing.update(foundry.utils.mergeObject({ ...duration, disabled: false }, effectFlags));
    return existing;
  }
  const data = foundry.utils.mergeObject({
    ...effect.toObject(),
    disabled: false,
    transfer: false,
    origin: originUuid
  }, effectFlags);
  if (game.user.isGM || actor.isOwner || actor.canUserModify?.(game.user, "update")) {
    const created = await ActiveEffect.implementation.create(data, { parent: actor });
    if (origin?.addDependent && created) await origin.addDependent(created);
    return created;
  }
  game.socket.emit(`module.${MODULE_ID}`, {
    op: "createEffect",
    actorUuid: actor.uuid,
    data,
    originUuid
  });
  return { uuid: "", name: effect.name };
}

export async function applyCardEffects(message) {
  const payload = foundry.utils.deepClone(getPayload(message));
  if (payload.effectsApplied) return;
  const item = payload.itemUuid ? await fromUuid(payload.itemUuid) : null;
  const activity = item?.system?.activities?.get(payload.activityId) ?? null;
  const effects = collectApplyableEffects(item, activity);
  if (!effects.length) {
    ui.notifications.warn(localize("FailedEffect"));
    return;
  }
  const targets = applyTargetList(payload);
  if (!targets.length) {
    ui.notifications.warn(localize("NoTargets"));
    return;
  }
  let origin = payload.concentrationUuid ? await fromUuid(payload.concentrationUuid) : null;
  if (!origin) {
    const caster = payload.roller?.uuid ? await fromUuid(payload.roller.uuid) : null;
    const concentrating = [...(caster?.concentration?.effects ?? [])];
    origin = concentrating.find(e => {
      const data = e.flags?.dnd5e?.item;
      return data?.id === item?.id || data?.uuid === item?.uuid;
    }) ?? concentrating[0] ?? effects[0];
  }
  payload.effects = effects.map(e => ({ id: e.id, name: e.name, img: e.img }));
  payload.appliedEffects ??= [];
  let applied = 0;
  for (const target of targets) {
    const actor = await actorFromTarget(target);
    if (!actor) continue;
    try {
      for (const effect of effects) {
        const created = await applyEffectToActor(effect, actor, origin, payload);
        payload.appliedEffects.push({
          uuid: created?.uuid ?? "",
          actorUuid: actor.uuid,
          name: actor.name,
          effectName: effect.name
        });
      }
      ui.notifications.info(localize("EffectApplied", { name: actor.name }));
      applied += 1;
    } catch (err) {
      console.error(`${MODULE_ID} | apply effect`, err);
      ui.notifications.error(localize("FailedEffect"));
    }
  }
  if (!applied) {
    ui.notifications.warn(localize("NothingApplied"));
    return;
  }
  payload.effectsApplied = true;
  payload.effectOrigin = origin?.uuid ?? effects[0]?.uuid ?? "";
  await refreshMessage(message, payload);
}

export async function retarget(message, activity=null, { tokens=null, extra={} }={}) {
  const payload = foundry.utils.deepClone(getPayload(message));
  Object.assign(payload, extra);
  rememberTargets(payload);
  const rollerUuid = payload.roller?.uuid;
  const scaling = payload.consumption?.scaling ?? 0;
  let limited = activity;
  if (payload.itemUuid && payload.activityId) {
    const item = payload.itemUuid === activity?.item?.uuid ? activity.item : await fromUuid(payload.itemUuid);
    limited = scaledActivity(item, payload.activityId, scaling) ?? activity;
  }
  payload.targets = tokens
    ? targetsFromTokens(tokens, rollerUuid)
    : resolveTargets(rollerUuid, { activity: limited, scaling });
  payload.maxTargets = maxTargetCount(limited, { scaling });

  await hydrateTargetRolls(payload, limited);
  rememberTargets(payload);

  await refreshMessage(message, payload);
  ui.notifications.info(localize("TargetsUpdated"));
}

function messageFromElement(el) {
  const li = el?.closest?.("[data-message-id]");
  return li ? game.messages.get(li.dataset.messageId) : null;
}

function bonusFromCard(el, payload) {
  const input = el.closest(".iris-card")?.querySelector("input[name='situational']:not([data-target-uuid])");
  if (!input) return payload.situational ?? 0;
  return Number(input.value) || 0;
}

function targetKey(target) {
  return target?.tokenUuid || target?.uuid || "";
}

function targetFromAction(payload, actionEl) {
  const uuid = actionEl?.dataset?.targetUuid || actionEl?.closest?.("[data-target-uuid]")?.dataset?.targetUuid;
  if (!uuid) return null;
  return (payload.targets ?? []).find(t => targetKey(t) === uuid) ?? null;
}

function dieSlot(payload, target) {
  if (payload.kind === "attack" && target?.d20) {
    const mode = target.mode ?? payload.mode ?? "normal";
    return { array: target.d20, index: usedDieIndex(target.d20, mode), target };
  }
  if (payload.kind === "save" && target?.saveD20) {
    const mode = target.saveMode ?? "normal";
    return { array: target.saveD20, index: usedDieIndex(target.saveD20, mode), target };
  }
  if (!Array.isArray(payload.d20)) return null;
  return { array: payload.d20, index: usedDieIndex(payload.d20, payload.mode ?? "normal"), target: null };
}

function dialogRoot(button, dialog) {
  return dialog?.element
    || button?.closest?.(".application, .app, .window-app, dialog")
    || button?.form
    || null;
}

function readDieForm(root, button) {
  const form = button?.form || root?.querySelector?.("form") || (root instanceof HTMLFormElement ? root : null);
  const host = root?.querySelector?.(".iris-die-form") || form || root;
  if (!host?.querySelector && !form?.elements) return {};
  const option = form?.elements?.option?.value
    || host?.querySelector?.('input[name="option"]:checked')?.value
    || "";
  const dmSet = form?.elements?.dmSet?.value
    ?? host?.querySelector?.('[name="dmSet"]')?.value
    ?? "";
  const portentValue = form?.elements?.portentValue?.value
    ?? host?.querySelector?.('[name="portentValue"]')?.value
    ?? "";
  const portentCustom = form?.elements?.portentCustom?.value
    ?? host?.querySelector?.('[name="portentCustom"]')?.value
    ?? "";
  const data = { option, dmSet, portentValue, portentCustom };
  if (!data.option && data.dmSet !== "") data.option = "dm-set";
  if (!data.option && (data.portentValue || data.portentCustom)) data.option = "portent";
  return data;
}

async function promptDieForm(html) {
  const collect = (event, button, dialog) => readDieForm(dialogRoot(button, dialog), button);
  const DialogV2 = foundry.applications?.api?.DialogV2;
  if (DialogV2?.wait) {
    const wrap = document.createElement("div");
    wrap.innerHTML = html;
    try {
      return await DialogV2.wait({
        window: { title: localize("AdjustDie"), icon: "fa-solid fa-dice-d20" },
        content: wrap,
        position: { width: 420 },
        classes: ["iris-die-dialog"],
        rejectClose: false,
        buttons: [
          {
            action: "apply",
            label: localize("ApplyDieChange"),
            icon: "fa-solid fa-check",
            default: true,
            callback: collect
          },
          { action: "cancel", label: localize("Cancel"), icon: "fa-solid fa-xmark" }
        ]
      });
    } catch {
      return null;
    }
  }
  return new Promise(resolve => {
    new Dialog({
      title: localize("AdjustDie"),
      content: html,
      buttons: {
        apply: {
          label: localize("ApplyDieChange"),
          callback: dlg => resolve(readDieForm(dlg?.[0] ?? dlg))
        },
        cancel: { label: localize("Cancel"), callback: () => resolve(null) }
      },
      close: () => resolve(null)
    }, { classes: ["iris-die-dialog"], width: 420 }).render(true);
  });
}

async function onDieEdit(message, actionEl) {
  if (!canEdit(message)) return ui.notifications.warn(localize("NoPermission"));
  const payload = foundry.utils.deepClone(getPayload(message));
  computeOutcomes(payload);
  const target = targetFromAction(payload, actionEl);
  const slot = dieSlot(payload, target);
  if (!slot) return;
  const face = Number(slot.array[slot.index]) || 0;
  const options = listDieOptions(payload, target, { isGM: game.user.isGM });
  const html = await renderHbs(DIE_EDIT_TEMPLATE, { face, options });
  const form = await promptDieForm(html);
  if (!form || form === "cancel" || form === "apply") return;
  const optionId = form.option || (form.dmSet !== "" && form.dmSet != null ? "dm-set" : "");
  if (!optionId) return;

  const option = options.find(o => o.id === optionId);
  if (!option) return;
  if (option.disabled && !game.user.isGM) {
    ui.notifications.warn(localize("NoFeatureUses"));
    return;
  }

  const next = foundry.utils.deepClone(getPayload(message));
  const nextTarget = targetFromAction(next, actionEl);
  const nextSlot = dieSlot(next, nextTarget);
  if (!nextSlot) return;

  let setValue = option.setTo;
  if (option.id === "portent") {
    setValue = Number(form.portentValue || form.portentCustom);
  } else if (option.id === "dm-set") {
    setValue = Number(form.dmSet);
  }

  if (option.action === "reroll") {
    if (option.advantage) {
      nextSlot.array.splice(0, nextSlot.array.length, await rollD20Face(), await rollD20Face());
      if (nextTarget) {
        if (next.kind === "save") nextTarget.saveMode = "advantage";
        else nextTarget.mode = "advantage";
      } else next.mode = "advantage";
    } else {
      nextSlot.array[nextSlot.index] = await rollD20Face();
    }
  } else if (option.action === "set") {
    if (!Number.isFinite(setValue)) {
      ui.notifications.warn(localize("NeedDieValue"));
      return;
    }
    nextSlot.array[nextSlot.index] = Math.min(20, Math.max(1, Math.round(setValue)));
  }

  try {
    await consumeDieOption(option, { portentValue: setValue });
  } catch (err) {
    console.error(`${MODULE_ID} | consume die feature`, err);
    ui.notifications.warn(localize("FailedFeatureUse"));
  }

  if (nextTarget) rememberTarget(next, nextTarget);
  await refreshMessage(message, next);
}

async function onDamageMult(message, actionEl) {
  if (!canEdit(message)) return ui.notifications.warn(localize("NoPermission"));
  const next = foundry.utils.deepClone(getPayload(message));
  const target = targetFromAction(next, actionEl);
  if (!target) return;
  const key = actionEl.dataset.irisType || "none";
  const value = Number(actionEl.dataset.irisMult);
  if (!Number.isFinite(value)) return;
  target.damageOverrides ??= {};
  target.damageOverrides[key] = snapMultiplier(value);
  rememberTarget(next, target);
  await refreshMessage(message, next);
}

async function onMode(message, mode, actionEl) {
  if (!canEdit(message)) return ui.notifications.warn(localize("NoPermission"));
  const next = foundry.utils.deepClone(getPayload(message));
  const target = targetFromAction(next, actionEl);
  if (target) {
    if (next.kind === "save") target.saveMode = mode;
    else target.mode = mode;
    rememberTarget(next, target);
  } else {
    next.situational = bonusFromCard(actionEl, next);
    next.mode = mode;
  }
  await refreshMessage(message, next);
}

async function onDamageBonus(message, value) {
  if (!canEdit(message)) return ui.notifications.warn(localize("NoPermission"));
  const next = foundry.utils.deepClone(getPayload(message));
  next.damageBonus = Number(value) || 0;
  await refreshMessage(message, next);
}

function canUseReaction(message, actor) {
  if (game.user.isGM || message.isAuthor) return true;
  return Boolean(actor?.isOwner || actor?.canUserModify?.(game.user, "update"));
}

async function onReact(message, actionEl) {
  const payload = foundry.utils.deepClone(getPayload(message));
  computeOutcomes(payload);
  const target = targetFromAction(payload, actionEl);
  const actor = await actorFromTarget(target);
  if (!target || !actor) return;
  if (!canUseReaction(message, actor)) return ui.notifications.warn(localize("NoPermission"));
  const options = listTargetReactions(payload, target, actor).filter(o => !o.disabled);
  if (!options.length) {
    ui.notifications.warn(localize("NoReactions"));
    return;
  }
  const DialogV2 = foundry.applications?.api?.DialogV2;
  if (!DialogV2?.wait) {
    ui.notifications.warn(localize("FailedCard"));
    return;
  }
  const buttons = [
    ...options.map(o => ({
      action: o.id,
      label: o.usesLabel ? `${o.name} (${o.usesLabel})` : o.name,
      callback: () => o.id
    })),
    { action: "cancel", label: localize("Cancel") }
  ];
  let chosen;
  try {
    chosen = await DialogV2.wait({
      window: { title: localize("ReactTitle"), icon: "fa-solid fa-bolt" },
      content: `<p class="iris-die-current">${foundry.utils.escapeHTML(target.name)} — ${foundry.utils.escapeHTML(outcomeCopy(target.outcome, { isSave: payload.kind === "save" }) || localize("Damage"))}</p>`,
      position: { width: 380 },
      classes: ["iris-die-dialog"],
      rejectClose: false,
      buttons
    });
  } catch {
    return;
  }
  if (!chosen || chosen === "cancel") return;
  const follow = await applyTargetReaction(chosen, payload, target, actor);
  if (!follow) return;
  rememberTarget(payload, target);
  await refreshMessage(message, payload);
  setRollerFromActor(actor);
  if (follow.item) {
    const used = await useReactionItem(follow.item);
    if (!used && follow.usesPath) await consumeFeatureUse(follow.item, follow.usesPath);
  }
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<p><strong>${foundry.utils.escapeHTML(target.name)}</strong> uses <strong>${foundry.utils.escapeHTML(follow.title)}</strong>${follow.note ? ` — ${foundry.utils.escapeHTML(follow.note)}` : ""}.</p>`,
    rolls: follow.rolls ?? [],
    sound: follow.rolls?.length ? CONFIG.sounds.dice : undefined
  });
}

async function onBonus(message, value, actionEl=null) {
  if (!canEdit(message)) return ui.notifications.warn(localize("NoPermission"));
  const next = foundry.utils.deepClone(getPayload(message));
  const target = targetFromAction(next, actionEl);
  const amount = Number(value) || 0;
  if (target) {
    if (next.kind === "save") target.saveSituational = amount;
    else target.situational = amount;
    rememberTarget(next, target);
  } else {
    next.situational = amount;
  }
  await refreshMessage(message, next);
}

async function onRetarget(message, actionEl) {
  if (!canEdit(message)) return ui.notifications.warn(localize("NoPermission"));
  const payload = foundry.utils.deepClone(getPayload(message));
  payload.situational = bonusFromCard(actionEl, payload);
  const item = payload.itemUuid ? await fromUuid(payload.itemUuid) : null;
  const activity = item?.system?.activities?.get(payload.activityId) ?? null;
  await retarget(message, activity, { extra: { situational: payload.situational } });
}

async function onClearTemplate(message) {
  if (!canEdit(message)) return ui.notifications.warn(localize("NoPermission"));
  const payload = foundry.utils.deepClone(getPayload(message));
  const uuids = liveTemplateUuids(payload.templateUuids);
  await deleteTemplates(uuids);
  payload.templateUuids = [];
  await refreshMessage(message, payload);
}

async function onReplaceTemplate(message) {
  if (!canEdit(message)) return ui.notifications.warn(localize("NoPermission"));
  const payload = foundry.utils.deepClone(getPayload(message));
  const item = payload.itemUuid ? await fromUuid(payload.itemUuid) : null;
  const scaling = payload.consumption?.scaling ?? 0;
  const activity = scaledActivity(item, payload.activityId, scaling)
    ?? item?.system?.activities?.get(payload.activityId);
  if (!activity) return ui.notifications.error(localize("FailedCard"));

  const created = await placeActivityTemplates(activity);
  if (!created.length) return;

  await deleteTemplates(liveTemplateUuids(payload.templateUuids));
  const tokens = await tokensInTemplates(created.map(doc => doc.uuid));
  selectTokens(tokens);
  const rollerActor = payload.roller?.uuid ? await fromUuid(payload.roller.uuid) : activity.actor;
  setRollerFromActor(rollerActor);
  await retarget(message, activity, {
    tokens,
    extra: { templateUuids: created.map(doc => doc.uuid) }
  });
}

async function reverseAppliedHp(payload) {
  const lines = [];
  for (const entry of payload.appliedLog ?? []) {
    const actor = await fromUuid(entry.uuid);
    if (!actor) continue;
    const hp = actor.system?.attributes?.hp;
    if (!hp) continue;
    const nextValue = Math.clamp(
      (Number(hp.value) || 0) - (entry.deltaValue ?? 0),
      0,
      Number(hp.max) || 9999
    );
    const nextTemp = Math.max(0, (Number(hp.temp) || 0) - (entry.deltaTemp ?? 0));
    await ownedUpdate(actor, {
      "system.attributes.hp.value": nextValue,
      "system.attributes.hp.temp": nextTemp
    });
    const amount = Math.abs((entry.deltaValue ?? 0) + (entry.deltaTemp ?? 0)) || entry.amount || 0;
    lines.push(localize("UndoHp", { amount, name: entry.name || actor.name }));
  }
  payload.appliedLog = [];
  payload.damageApplied = false;
  return lines;
}

async function reverseAppliedEffects(payload) {
  const lines = [];
  const origin = payload.effectOrigin;
  const seen = new Set();
  const entries = [...(payload.appliedEffects ?? [])];
  if (!entries.length && origin) {
    for (const target of payload.targets ?? []) {
      entries.push({ actorUuid: target.uuid, name: target.name });
    }
  }
  for (const entry of entries) {
    const actor = await fromUuid(entry.actorUuid || entry.uuid);
    if (!actor) continue;
    const matches = actor.effects.filter(e => {
      if (entry.uuid && e.uuid === entry.uuid) return true;
      if (origin && e.origin === origin) return true;
      return false;
    });
    for (const effect of matches) {
      if (seen.has(effect.uuid)) continue;
      seen.add(effect.uuid);
      const label = effect.name || entry.effectName || localize("ApplyEffect");
      if (game.user.isGM || effect.isOwner) await effect.delete();
      else game.socket.emit(`module.${MODULE_ID}`, { op: "deleteDoc", uuid: effect.uuid });
      lines.push(localize("UndoEffect", { effect: label, name: entry.name || actor.name }));
    }
  }
  payload.appliedEffects = [];
  payload.effectsApplied = false;
  return lines;
}

async function onSlotChange(message, newKey) {
  if (!canEdit(message)) return ui.notifications.warn(localize("NoPermission"));
  const payload = foundry.utils.deepClone(getPayload(message));
  const consumption = payload.consumption ??= {};
  const usingPoints = Boolean(consumption.spellPoints) || Boolean(getSpellPointsItem(await fromUuid(payload.roller?.uuid)));
  const old = usingPoints ? consumption.spellPoints : consumption.spellSlot;
  if (old?.key === newKey) return;

  const actor = await fromUuid(payload.roller?.uuid);
  const item = payload.itemUuid ? await fromUuid(payload.itemUuid) : null;
  if (!actor || !item) return ui.notifications.error(localize("FailedCard"));

  if (payload.appliedLog?.length) await reverseAppliedHp(payload);
  if (payload.appliedEffects?.length || payload.effectsApplied) await reverseAppliedEffects(payload);

  if (usingPoints) {
    const spItem = getSpellPointsItem(actor);
    const newLevel = slotKeyLevel(actor, newKey, item);
    const cost = spellPointCostForLevel(actor, newLevel);
    if (old && !old.restored) await restoreRecord(actor, old);
    const remaining = spellPointsRemaining(getSpellPointsItem(actor) ?? spItem, actor);
    if (remaining < cost) {
      if (old?.cost) await consumeSpellPoints(actor, old.cost);
      if (old) old.restored = false;
      ui.notifications.warn(localize("NoSpellPoints", {
        name: spItem?.name || "Spell Points",
        cost,
        remaining
      }));
      await refreshMessage(message, payload);
      return;
    }
    const spentBefore = currentValueSafe(getSpellPointsItem(actor), "system.uses.spent");
    const consumed = await consumeSpellPoints(actor, cost);
    if (!consumed) {
      ui.notifications.warn(localize("NoSpellPoints", {
        name: spItem?.name || "Spell Points",
        cost,
        remaining
      }));
      return;
    }
    const fresh = getSpellPointsItem(actor);
    consumption.spellPoints = {
      kind: "spellPoints",
      type: "item",
      itemId: fresh.id,
      itemUuid: fresh.uuid,
      path: "system.uses.spent",
      before: spentBefore,
      after: currentValueSafe(fresh, "system.uses.spent"),
      cost,
      key: newKey,
      level: newLevel,
      label: fresh.name,
      restored: false
    };
    consumption.spellSlot = null;
    consumption.refunded = remainingConsumption(consumption).length === 0;
    consumption.scaling = Math.max(0, newLevel - (item.system.level ?? 0));
  } else {
    const newSlot = actor.system.spells?.[newKey];
    if (!newSlot) return;
    if (!(Number(newSlot.value) > 0)) {
      ui.notifications.warn(localize("NoSlots", { level: newSlot.label || slotLevelLabel(newSlot.level) }));
      await refreshMessage(message, payload);
      return;
    }

    if (old?.key && !old.restored) {
      await restoreRecord(actor, old);
    }

    const consumed = await consumeSpellSlot(actor, newKey, 1);
    if (!consumed) {
      ui.notifications.warn(localize("NoSlots", { level: newSlot.label || slotLevelLabel(newSlot.level) }));
      return;
    }
    const after = Number(foundry.utils.getProperty(actor, `system.spells.${newKey}.value`)) || 0;
    consumption.spellSlot = {
      kind: "spellSlot",
      type: "actor",
      key: newKey,
      path: `system.spells.${newKey}.value`,
      before: after + 1,
      after,
      restored: false,
      level: newSlot.level,
      label: newSlot.label || slotLevelLabel(newSlot.level)
    };
    consumption.refunded = remainingConsumption(consumption).length === 0;
    consumption.scaling = Math.max(0, (newSlot.level ?? 0) - (item.system.level ?? 0));
  }

  const activity = scaledActivity(item, payload.activityId, consumption.scaling);
  const limit = maxTargetCount(activity, { scaling: consumption.scaling });
  payload.maxTargets = limit;
  if (Number.isFinite(limit) && payload.targets?.length > limit) {
    payload.targets = payload.targets.slice(0, limit);
    ui.notifications.info(localize("TargetLimit", { name: payload.title || item.name, count: limit }));
  }
  if (activity && (payload.damage || payload.kind === "attack" || payload.kind === "save"
    || payload.kind === "damage" || payload.kind === "heal")) {
    payload.damage = await rollNormalAndCritDamage(activity, { isCritical: false });
    if (payload.kind === "attack" || payload.kind === "damage") {
      payload.critDamage = await rollNormalAndCritDamage(activity, { isCritical: true });
    }
  }
  const actName = item.system.activities?.get(payload.activityId)?.name;
  const levelLabel = consumption.spellPoints
    ? slotLevelLabel(consumption.spellPoints.level)
    : consumption.spellSlot?.label;
  payload.subtitle = [actName, levelLabel].filter(Boolean).join(" · ");
  await refreshMessage(message, payload);
}

function currentValueSafe(doc, path) {
  return Number(foundry.utils.getProperty(doc, path)) || 0;
}

function canRepeat(message, payload) {
  if (game.user.isGM || message.isAuthor) return true;
  try {
    const actor = fromUuidSync(payload?.roller?.uuid);
    return Boolean(actor?.isOwner);
  } catch {
    return false;
  }
}

function repeatTargetIdentities(payload) {
  return (payload.targets ?? []).map(t => ({
    uuid: t.uuid || "",
    tokenUuid: t.tokenUuid || "",
    name: t.name || "",
    img: t.img || "",
    ac: t.ac ?? null,
    evasion: Boolean(t.evasion),
    isRoller: Boolean(t.isRoller)
  }));
}

async function onAgain(message, { free=false }={}) {
  const payload = getPayload(message);
  if (payload.kind === "concentration") return;
  if (!canRepeat(message, payload)) return ui.notifications.warn(localize("NoPermission"));

  const identities = repeatTargetIdentities(payload);
  const actor = payload.roller?.uuid ? await fromUuid(payload.roller.uuid) : null;
  if (actor) setRollerFromActor(actor);

  const slotKey = payload.consumption?.spellSlot?.key || payload.consumption?.spellPoints?.key;
  const scaling = Number(payload.consumption?.scaling) || 0;
  const slotLabel = payload.consumption?.spellPoints
    ? slotLevelLabel(payload.consumption.spellPoints.level)
    : (payload.consumption?.spellSlot?.label || "");

  if (payload.itemUuid && payload.activityId) {
    const item = await fromUuid(payload.itemUuid);
    const activity = item?.system?.activities?.get?.(payload.activityId);
    if (!activity) return ui.notifications.error(localize("FailedCard"));
    const rolling = scaledActivity(item, payload.activityId, scaling) ?? activity;
    const isTemplate = Boolean(
      rolling?.target?.template?.type
      || activity.target?.template?.type
      || item?.system?.target?.template?.type
      || (payload.templateUuids ?? []).length
    );
    let newTemplateUuids = [];
    if (isTemplate) {
      const created = await placeActivityTemplates(rolling);
      if (!created.length) return;
      newTemplateUuids = created.map(doc => doc.uuid);
    }
    const usage = {
      consume: free ? false : {},
      subsequentActions: false,
      create: false,
      scaling,
      irisRolls: true,
      irisRepeat: true,
      irisRepeatPlaceTemplate: isTemplate,
      irisRepeatTargets: isTemplate ? [] : identities,
      irisRepeatTemplates: isTemplate ? newTemplateUuids : [],
      irisRepeatSlotLabel: slotLabel
    };
    if (slotKey) usage.spell = { slot: slotKey };
    state.repeat = {
      irisRepeat: true,
      placeTemplate: isTemplate,
      irisRepeatPlaceTemplate: isTemplate,
      targets: isTemplate ? [] : identities,
      irisRepeatTargets: isTemplate ? [] : identities,
      templates: isTemplate ? newTemplateUuids : [],
      irisRepeatTemplates: isTemplate ? newTemplateUuids : [],
      slotLabel,
      irisRepeatSlotLabel: slotLabel
    };
    try {
      if (free && typeof state.handleActivity === "function") {
        await state.handleActivity(activity, usage, { templates: [] });
        return;
      }
      const result = await activity.use(usage, { configure: false }, { create: false });
      if (!result) ui.notifications.warn(localize("FailedCard"));
    } catch (err) {
      console.error(`${MODULE_ID} | again`, err);
      ui.notifications.error(localize("FailedCard"));
    }
    return;
  }

  if (!actor) return ui.notifications.error(localize("FailedCard"));
  state.repeatTargets = identities;
  try {
    const dialog = { configure: false };
    const messageCfg = { create: false };
    if (payload.kind === "skill" && payload.skill) await actor.rollSkill({ skill: payload.skill }, dialog, messageCfg);
    else if (payload.kind === "tool" && payload.tool) await actor.rollToolCheck({ tool: payload.tool }, dialog, messageCfg);
    else if (payload.kind === "ability" && payload.ability) await actor.rollAbilityCheck({ ability: payload.ability }, dialog, messageCfg);
    else if (payload.kind === "savingThrow" && payload.ability) await actor.rollSavingThrow({ ability: payload.ability }, dialog, messageCfg);
    else ui.notifications.warn(localize("FailedCard"));
  } catch (err) {
    console.error(`${MODULE_ID} | again`, err);
    ui.notifications.error(localize("FailedCard"));
  } finally {
    state.repeatTargets = null;
  }
}

async function onRefund(message) {
  if (!canEdit(message)) return ui.notifications.warn(localize("NoPermission"));
  const payload = foundry.utils.deepClone(getPayload(message));
  const actor = await fromUuid(payload.roller?.uuid);
  if (!actor) return;
  const labels = await refundResources(actor, payload.consumption);
  if (!labels.length) return ui.notifications.info(localize("NothingToRefund"));
  await refreshMessage(message, payload);
  ui.notifications.info(localize("Refunded", { what: labels.join(", ") }));
}

async function onReenable(message) {
  if (!canEdit(message)) return ui.notifications.warn(localize("NoPermission"));
  const payload = foundry.utils.deepClone(getPayload(message));
  payload.damageApplied = false;
  payload.effectsApplied = false;
  await refreshMessage(message, payload);
}

async function loadItemDescription(payload) {
  const item = payload.itemUuid ? await fromUuid(payload.itemUuid) : null;
  if (!item) return "";
  const identified = item.system?.identified !== false;
  let raw = "";
  if (!identified) raw = item.system?.unidentified?.description || "";
  else {
    raw = item.system?.description?.value || item.system?.description?.chat || "";
    if (!raw && payload.activityId) {
      const activity = item.system?.activities?.get(payload.activityId);
      raw = activity?.description?.chatFlavor || "";
    }
  }
  if (!raw) return "";
  const enricher = foundry.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
  return enricher.enrichHTML(raw, {
    async: true,
    secrets: Boolean(item.isOwner),
    relativeTo: item,
    rollData: item.getRollData?.() ?? {}
  });
}

async function onLore(actionEl) {
  const card = actionEl.closest(".iris-card");
  const panel = card?.querySelector(".iris-lore");
  if (!panel) return;
  const opening = panel.hidden;
  if (opening && !panel.dataset.ready) {
    const message = messageFromElement(actionEl);
    const html = await loadItemDescription(getPayload(message));
    panel.innerHTML = html || `<p class="iris-muted">${localize("NoDescription")}</p>`;
    panel.dataset.ready = "1";
  }
  panel.hidden = !opening;
  actionEl.classList.toggle("is-open", opening);
}

async function onUndo(message) {
  if (!canEdit(message)) return ui.notifications.warn(localize("NoPermission"));
  const payload = foundry.utils.deepClone(getPayload(message));
  if (payload.undone) return;
  payload.undone = true;
  const hpLines = await reverseAppliedHp(payload);
  const effectLines = await reverseAppliedEffects(payload);
  const actor = payload.roller?.uuid ? await fromUuid(payload.roller.uuid) : null;
  const refunded = actor ? await refundRemaining(actor, payload.consumption) : [];
  await refreshMessage(message, payload);

  const parts = [];
  if (hpLines.length) parts.push(hpLines.join("; "));
  if (effectLines.length) parts.push(effectLines.join("; "));
  if (refunded.length) parts.push(localize("UndoRefund", { what: refunded.join(", ") }));
  const detail = parts.length ? parts.join(". ") : localize("UndoNothing");
  const title = foundry.utils.escapeHTML(payload.title || localize("Title"));
  await ChatMessage.create({
    speaker: message.speaker,
    content: `<p class="iris-undo-note"><strong>${localize("Undone")}</strong> — ${title}. ${foundry.utils.escapeHTML(detail)}</p>`
  });
}

export function onChatClick(event) {
  const concBtn = event.target.closest?.('[data-action="concentration"]');
  if (concBtn && !event.target.closest?.(".iris-card")) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    void handleConcentrationButton(concBtn).catch(err => {
      console.error(`${MODULE_ID} | concentration button`, err);
      ui.notifications.error(localize("FailedCard"));
    });
    return;
  }

  const actionEl = event.target.closest?.("[data-iris-action]");
  if (!actionEl) return;
  if (actionEl.dataset.irisAction === "bonus") return;
  const message = messageFromElement(actionEl);
  if (!message || !hasPayload(message)) return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation?.();

  const action = actionEl.dataset.irisAction;
  const run = (async () => {
    if (action === "mode") await onMode(message, actionEl.dataset.mode, actionEl);
    else if (action === "mult") await onDamageMult(message, actionEl);
    else if (action === "die") await onDieEdit(message, actionEl);
    else if (action === "react") await onReact(message, actionEl);
    else if (action === "apply") {
      const kind = getPayload(message).kind;
      if (kind === "concentration") await applyConcentrationBreak(message);
      else if (kind === "utility" || getPayload(message).effects?.length) await applyCardEffects(message);
      else await applyCardDamage(message, actionEl);
    }
    else if (action === "retarget") await onRetarget(message, actionEl);
    else if (action === "clear-template") await onClearTemplate(message);
    else if (action === "replace-template") await onReplaceTemplate(message);
    else if (action === "refund") await onRefund(message);
    else if (action === "reenable") await onReenable(message);
    else if (action === "undo") await onUndo(message);
    else if (action === "again") await onAgain(message, { free: false });
    else if (action === "again-free") await onAgain(message, { free: true });
    else if (action === "lore") await onLore(actionEl);
  })();
  run.catch(err => {
    console.error(`${MODULE_ID} | card action`, err);
    ui.notifications.error(localize("FailedCard"));
  });
}

export function onChatChange(event) {
  const slot = event.target.closest?.(".iris-card select[name='spellSlot']");
  if (slot) {
    const message = messageFromElement(slot);
    if (!message || !hasPayload(message)) return;
    event.stopPropagation();
    void onSlotChange(message, slot.value).catch(err => {
      console.error(`${MODULE_ID} | slot`, err);
      ui.notifications.error(localize("FailedCard"));
    });
    return;
  }
  const dmgBonus = event.target.closest?.(".iris-card input[name='damageBonus']");
  if (dmgBonus) {
    const message = messageFromElement(dmgBonus);
    if (!message || !hasPayload(message)) return;
    event.stopPropagation();
    void onDamageBonus(message, dmgBonus.value).catch(err => {
      console.error(`${MODULE_ID} | damage bonus`, err);
    });
    return;
  }
  const input = event.target.closest?.(".iris-card input[name='situational']");
  if (!input) return;
  const message = messageFromElement(input);
  if (!message || !hasPayload(message)) return;
  void onBonus(message, input.value, input).catch(err => {
    console.error(`${MODULE_ID} | bonus`, err);
  });
}

export function onChatBonusInput(event) {
  const dmgBonus = event.target.closest?.(".iris-card input[name='damageBonus']");
  if (dmgBonus) {
    const card = dmgBonus.closest(".iris-card");
    const totalEl = card?.querySelector(".iris-dmg-total");
    const base = Number(totalEl?.dataset?.baseTotal);
    if (totalEl && Number.isFinite(base)) {
      totalEl.textContent = String(base + (Number(dmgBonus.value) || 0));
    }
    return;
  }
  const input = event.target.closest?.(".iris-card input[name='situational']");
  if (!input) return;
  const message = messageFromElement(input);
  if (!message || !hasPayload(message)) return;
  const payload = foundry.utils.deepClone(getPayload(message));
  const amount = Number(input.value) || 0;
  const target = targetFromAction(payload, input);
  if (target) {
    if (payload.kind === "save") target.saveSituational = amount;
    else target.situational = amount;
    computeOutcomes(payload);
    const row = input.closest(".iris-target");
    if (!row) return;
    const detail = payload.kind === "save"
      ? (target.saveTotal != null ? localize("SaveVs", { total: target.saveTotal, dc: payload.dc ?? 0 }) : "")
      : (target.displayTotal != null && target.ac != null
        ? localize("AttackVs", { total: target.displayTotal, ac: target.ac }) : "");
    const detailEl = row.querySelector(".iris-save-detail, .iris-attack-detail");
    if (detailEl) detailEl.textContent = detail;
    const outcomeEl = row.querySelector(".iris-outcome");
    if (outcomeEl && target.outcome) {
      outcomeEl.textContent = outcomeCopy(target.outcome, { isSave: payload.kind === "save" });
      outcomeEl.className = `iris-outcome ${target.outcome}`;
    }
    const appliedEl = row.querySelector(".iris-applied");
    if (appliedEl && target.applied != null) appliedEl.textContent = String(target.applied);
    return;
  }
  payload.situational = amount;
  computeOutcomes(payload);
  const totalEl = input.closest(".iris-card")?.querySelector(".iris-total");
  if (!totalEl) return;
  const vs = totalEl.querySelector(".iris-vs");
  const vsHtml = vs ? ` ${vs.outerHTML}` : "";
  totalEl.innerHTML = `${localize("Total")} ${payload.displayTotal}${vsHtml}`;
}

export function bindCardListeners() {
  document.body.addEventListener("click", onChatClick, true);
  document.body.addEventListener("change", onChatChange, true);
  document.body.addEventListener("input", onChatBonusInput, true);
  document.body.addEventListener("keydown", event => {
    const input = event.target.closest?.(".iris-card input[name='situational']");
    if (!input || event.key !== "Enter") return;
    event.preventDefault();
    input.blur();
  }, true);
  Hooks.on("renderChatMessageHTML", tidyIrisChatMessage);
  Hooks.on("dnd5e.renderChatMessage", tidyIrisChatMessage);
}

export function tidyIrisChatMessage(message, html) {
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root?.querySelector?.(".iris-card")) return;
  const card = root.querySelector(".iris-card");
  const seen = new Set();
  for (const btn of card.querySelectorAll("[data-iris-action='clear-template'], [data-iris-action='replace-template']")) {
    const key = btn.dataset.irisAction;
    if (seen.has(key)) btn.remove();
    else seen.add(key);
  }
  const content = root.querySelector(".message-content") ?? root;
  for (const el of [...content.children]) {
    if (el.classList.contains("iris-card")) continue;
    if (el.classList.contains("dice-roll") || el.tagName === "DAMAGE-APPLICATION" || el.tagName === "EFFECT-APPLICATION") {
      el.remove();
    }
  }
  content.querySelectorAll('[data-action="placeTemplate"]').forEach(el => el.remove());
}

export async function bindCard(message, html) {
  /* Card actions are delegated from document.body so Foundry 13 chat cloning cannot drop them. */
}

export async function handleSocket(payload) {
  if (!game.user.isGM) return;
  if (payload?.op === "applyDamage") {
    const actor = await fromUuid(payload.actorUuid);
    if (!actor) return;
    const damages = (payload.damages ?? []).map(d => ({
      ...d,
      properties: new Set(d.properties ?? [])
    }));
    await actor.applyDamage(damages, payload.options ?? {});
    return;
  }
  if (payload?.op === "endConcentration") {
    const actor = await fromUuid(payload.actorUuid);
    if (!actor) return;
    await actor.endConcentration(payload.effectId || undefined);
    return;
  }
  if (payload?.op === "updateDoc") {
    const doc = await fromUuid(payload.uuid);
    if (doc) await doc.update(payload.update ?? {});
    return;
  }
  if (payload?.op === "deleteDoc") {
    const doc = await fromUuid(payload.uuid);
    if (doc) await doc.delete();
    return;
  }
  if (payload?.op === "createEffect") {
    const actor = await fromUuid(payload.actorUuid);
    if (!actor) return;
    const created = await ActiveEffect.implementation.create(payload.data ?? {}, { parent: actor });
    if (payload.originUuid && created) {
      const origin = await fromUuid(payload.originUuid);
      if (origin?.addDependent) await origin.addDependent(created);
    }
  }
}

export { abilityLabel, skillLabel };
