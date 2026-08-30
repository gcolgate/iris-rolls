import { MODULE_ID, TEMPLATE, localize, renderHbs, getPayload, hasPayload } from "./constants.js";
import { describeActor, resolveTargets, pickSaveAbility, hasEvasion, isDexSave, maxTargetCount, liveTemplateUuids, tokensInTemplates, targetsFromTokens, selectTokens, setRollerFromActor, placeActivityTemplates, deleteTemplates } from "./targets.js";
import { dualFromRoll, usedDieIndex, damageTotal, selectDamage, rollQuiet, rollNormalAndCritDamage } from "./dice.js";
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

export function computeOutcomes(payload) {
  const index = usedDieIndex(payload.d20 ?? [0, 0], payload.mode);
  const d20 = payload.d20?.[index] ?? 0;
  const total = d20 + (payload.bonus ?? 0) + (Number(payload.situational) || 0);
  const critThreshold = payload.critThreshold ?? 20;
  const isCrit = d20 >= critThreshold;
  const isFumble = d20 === 1;
  const { parts } = selectDamage(payload);

  for (const target of payload.targets ?? []) {
    let actor = null;
    try { actor = fromUuidSync(target.uuid); } catch {}
    if (actor && target.evasion == null) target.evasion = hasEvasion(actor);

    if (payload.kind === "attack") {
      const ac = target.ac;
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
    } else if (payload.kind === "save" && target.saveD20) {
      const saveFace = target.saveD20[0];
      const saveTotal = saveFace + (target.saveBonus ?? 0);
      target.saveFace = saveFace;
      target.saveTotal = saveTotal;
      target.success = saveTotal >= (payload.dc ?? 0);
      target.outcome = target.success ? "success" : "failure";
      target.multiplier = saveMultiplier(payload, target);
    } else if (payload.dc != null && ["skill", "check", "ability"].includes(payload.kind)) {
      target.success = total >= payload.dc;
      target.outcome = target.success ? "success" : "failure";
      target.multiplier = 1;
    } else {
      target.multiplier ??= 1;
    }

    const preview = previewDamage(actor, parts, target.multiplier ?? 1);
    target.applied = preview.amount;
    target.immune = preview.immune;
    target.resistant = preview.resistant;
    target.vulnerable = preview.vulnerable;
  }

  payload.displayTotal = total;
  payload.usedIndex = index;
  payload.isCrit = isCrit;
  payload.isFumble = isFumble;
  if (payload.kind === "concentration") {
    payload.success = total >= (payload.dc ?? 10);
    payload.outcome = payload.success ? "success" : "failure";
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

function miniDice(values=[], mode="normal") {
  const used = usedDieIndex(values, mode);
  return values.map((value, i) => ({
    value,
    css: i === used ? "used" : "unused"
  }));
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
  const hasD20 = Array.isArray(payload.d20) && payload.d20.length >= 2 && !isSave;
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
    versus = localize("Versus", { value: localize("AC", { ac: payload.targets[0].ac }) });
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
      if (t.immune) tags.push({ label: localize("Immune"), css: "immune" });
      else if (t.resistant) tags.push({ label: localize("Resistant"), css: "resist" });
      if (t.vulnerable) tags.push({ label: localize("Vulnerable"), css: "vuln" });
      let appliedLabel = "";
      if (isSave || payload.kind === "attack" || payload.kind === "damage") {
        if (t.immune) appliedLabel = localize("Takes", { amount: `0 (${localize("Immune")})` });
        else if (t.evasionApplies && t.success) appliedLabel = localize("Takes", { amount: `0 (${localize("Evasion")})` });
        else if (t.multiplier === 0) appliedLabel = localize("Takes", { amount: `0 (${localize("NoDamage")})` });
        else if (t.multiplier === 0.5) appliedLabel = localize("Takes", { amount: `${t.applied ?? 0} (${localize("Half")})` });
        else appliedLabel = localize("Takes", { amount: String(t.applied ?? 0) });
      }
      return {
        ...t,
        outcomeLabel: outcomeCopy(t.outcome, { isSave }),
        outcomeClass: t.outcome ?? "",
        saveDice: !isSave && t.saveD20 ? miniDice(t.saveD20, payload.mode) : null,
        saveDetail: isSave && t.saveTotal != null
          ? localize("SaveVs", { total: t.saveTotal, dc: payload.dc ?? 0 })
          : "",
        tags,
        appliedLabel
      };
    }),
    hasD20,
    showModes: hasD20,
    dice: (payload.d20 ?? []).map((value, i) => {
      const used = i === payload.usedIndex;
      const css = [
        used ? "used" : "unused",
        value >= (payload.critThreshold ?? 20) ? "crit" : "",
        value === 1 ? "fumble" : ""
      ].filter(Boolean).join(" ");
      return {
        value,
        css,
        label: used ? localize("UsedDie") : localize("UnusedDie")
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
    isCrit: Boolean(damage.isCrit),
    damageLabel: damage.isCrit
      ? localize("CriticalDamage")
      : isHeal ? localize("Healing") : localize("Damage"),
    damageLines: (damage.parts ?? []).map(p => ({
      formula: p.formula,
      type: p.type,
      total: p.total,
      used: true
    })),
    otherDamageLines: [],
    damageTotal: damageTotal(damage.parts),
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
    hasTemplate: liveTemplateUuids(payload.templateUuids).length > 0
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

async function applyDamages(actor, parts, multiplier) {
  const damages = parts.map(p => ({
    value: Number(p.total) || 0,
    type: p.type || undefined,
    properties: new Set(p.properties ?? [])
  }));
  const options = { multiplier };
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

export async function applyCardDamage(message, actionEl=null) {
  const payload = foundry.utils.deepClone(getPayload(message));
  if (payload.damageApplied) return;
  if (actionEl) payload.situational = bonusFromCard(actionEl, payload);
  computeOutcomes(payload);
  const { parts } = selectDamage(payload);
  if (!parts.length) {
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
    const actor = await fromUuid(target.uuid);
    if (!actor) continue;
    let multiplier = target.multiplier ?? 1;
    if (payload.kind === "attack" && !target.hit) continue;
    try {
      const before = hpSnap(actor);
      await applyDamages(actor, parts, multiplier);
      const fresh = fromUuidSync(actor.uuid) ?? actor;
      const after = hpSnap(fresh);
      const amount = target.applied ?? Math.floor(Math.abs(damageTotal(parts) * multiplier));
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
    const actor = await fromUuid(target.uuid);
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

  if (payload.kind === "save") {
    for (const target of payload.targets) {
      const actor = await fromUuid(target.uuid);
      if (!actor) continue;
      const ability = limited
        ? pickSaveAbility(limited, actor)
        : (payload.saveAbilities?.[0] ?? target.saveAbility ?? "dex");
      const rolls = await rollQuiet(actor, "rollSavingThrow", { ability, target: payload.dc });
      if (!rolls[0]) continue;
      const dual = await dualFromRoll(rolls[0]);
      target.saveD20 = dual.d20;
      target.saveBonus = dual.bonus;
      target.saveAbility = ability;
      target.evasion = hasEvasion(actor);
      target.img = describeActor(actor).img;
      target.ac = actor.system?.attributes?.ac?.value ?? target.ac;
    }
  }

  await refreshMessage(message, payload);
  ui.notifications.info(localize("TargetsUpdated"));
}

function messageFromElement(el) {
  const li = el?.closest?.("[data-message-id]");
  return li ? game.messages.get(li.dataset.messageId) : null;
}

function bonusFromCard(el, payload) {
  const input = el.closest(".iris-card")?.querySelector("input[name='situational']");
  if (!input) return payload.situational ?? 0;
  return Number(input.value) || 0;
}

async function onMode(message, mode, actionEl) {
  if (!canEdit(message)) return ui.notifications.warn(localize("NoPermission"));
  const next = foundry.utils.deepClone(getPayload(message));
  next.situational = bonusFromCard(actionEl, next);
  next.mode = mode;
  await refreshMessage(message, next);
}

async function onBonus(message, value) {
  if (!canEdit(message)) return ui.notifications.warn(localize("NoPermission"));
  const next = foundry.utils.deepClone(getPayload(message));
  next.situational = Number(value) || 0;
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
  const input = event.target.closest?.(".iris-card input[name='situational']");
  if (!input) return;
  const message = messageFromElement(input);
  if (!message || !hasPayload(message)) return;
  void onBonus(message, input.value).catch(err => {
    console.error(`${MODULE_ID} | bonus`, err);
  });
}

export function onChatBonusInput(event) {
  const input = event.target.closest?.(".iris-card input[name='situational']");
  if (!input) return;
  const message = messageFromElement(input);
  if (!message || !hasPayload(message)) return;
  const payload = foundry.utils.deepClone(getPayload(message));
  payload.situational = Number(input.value) || 0;
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
