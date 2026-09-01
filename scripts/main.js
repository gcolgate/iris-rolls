import { MODULE_ID, TEMPLATE, DIE_EDIT_TEMPLATE, HANDLED_ACTIVITIES, state, localize } from "./constants.js";
import { describeActor, resolveTargets, maxTargetCount, templateUuidsFromResults, tokensInTemplates, selectTokens, targetsFromTokens, setRollerFromActor, wrapSpeakerForIrisRoller, bindSheetAsRoller, reviveRepeatTargets, tokensFromTargets, liveTemplateUuids } from "./targets.js";
import { dualFromRoll, rollQuiet, rollNormalAndCritDamage } from "./dice.js";
import { postCard, bindCardListeners, handleSocket, abilityLabel, skillLabel, postConcentrationCard, collectApplyableEffects, fillTargetAttack, fillTargetSave, rememberTargets } from "./card.js";
import { snapshotConsumption, finalizeConsumption, scaledActivity, shouldUseSpellPoints, getSpellPointsItem, spellPointCostForLevel, spellPointsRemaining, slotKeyLevel, slotLevelLabel } from "./resources.js";
import { shouldApplyReliableTalent } from "./features.js";

function skipDialog(config={}, dialog={}, message={}) {
  dialog.configure = false;
  if (config.hookNames?.includes("deathSave")) {
    for (const roll of config.rolls ?? []) {
      roll.options ??= {};
      roll.options.irisSkip = true;
    }
    return;
  }
  if (config.isConcentration || config.hookNames?.includes("concentration")) {
    for (const roll of config.rolls ?? []) {
      roll.options ??= {};
      roll.options.irisConcentration = true;
    }
  }
  message.create = false;
}

function actorFromSubject(subject) {
  if (!subject) return null;
  if (subject.documentName === "Actor") return subject;
  return subject.actor ?? subject.parent?.actor ?? null;
}

async function cardFromD20({ kind, rolls, actor, title, subtitle, extra={} }) {
  if (state.suppressCards || state.activityDepth) return;
  setRollerFromActor(actor);
  const roll = Array.isArray(rolls) ? rolls[0] : rolls;
  if (!roll) return;
  const dual = await dualFromRoll(roll);
  const roller = describeActor(actor);
  const { activity, ...restExtra } = extra;
  const targets = Array.isArray(state.repeatTargets)
    ? await reviveRepeatTargets(state.repeatTargets, roller.uuid)
    : resolveTargets(roller.uuid, { activity });
  const payload = {
    kind,
    mode: "normal",
    title,
    subtitle,
    roller,
    targets,
    d20: dual.d20,
    bonus: dual.bonus,
    situational: 0,
    critThreshold: 20,
    itemImg: restExtra.itemImg ?? actor?.img,
    reliableTalent: shouldApplyReliableTalent(actor, { ...restExtra, kind }),
    ...restExtra
  };
  if (kind === "attack") {
    const activityDoc = extra.activity;
    for (let i = 0; i < (payload.targets ?? []).length; i++) {
      const target = payload.targets[i];
      if (i === 0) {
        target.d20 = dual.d20;
        target.bonus = dual.bonus;
        target.mode = "normal";
        target.situational = 0;
      } else if (activityDoc) {
        await fillTargetAttack(target, activityDoc);
      } else {
        target.d20 = dual.d20;
        target.bonus = dual.bonus;
        target.mode = "normal";
        target.situational = 0;
      }
    }
    rememberTargets(payload);
  }
  return postCard(payload, { actor, rolls: [roll] });
}

async function rollTargetSaves(activity, targets) {
  const dc = activity.save?.dc?.value ?? 0;
  for (const target of targets) await fillTargetSave(target, activity, dc);
  return dc;
}

async function handleActivity(activity, usageConfig={}, results={}) {
  const actor = activity.actor;
  const item = activity.item;
  const roller = describeActor(actor);
  const title = item?.name ?? activity.name ?? localize("Title");
  const consumption = await finalizeConsumption(activity, usageConfig);
  const rolling = scaledActivity(item, activity.id, consumption.scaling) ?? activity;
  const repeat = usageConfig.irisRepeat || usageConfig.irisRepeatPlaceTemplate ? usageConfig : state.repeat;
  if (repeat && state.repeat) state.repeat = null;
  let templateUuids = templateUuidsFromResults(results);
  let targets;
  if (repeat?.irisRepeatPlaceTemplate || repeat?.placeTemplate) {
    templateUuids = liveTemplateUuids(repeat.irisRepeatTemplates ?? repeat.templates ?? templateUuids);
    const tokens = await tokensInTemplates(templateUuids);
    selectTokens(tokens);
    targets = targetsFromTokens(tokens, roller.uuid);
  } else if (repeat?.irisRepeat || repeat?.targets) {
    templateUuids = liveTemplateUuids(repeat.irisRepeatTemplates ?? repeat.templates ?? []);
    targets = await reviveRepeatTargets(repeat.irisRepeatTargets ?? repeat.targets ?? [], roller.uuid);
    const tokenObjs = tokensFromTargets(targets);
    if (tokenObjs.length) selectTokens(tokenObjs);
  } else if (templateUuids.length) {
    const tokens = await tokensInTemplates(templateUuids);
    selectTokens(tokens);
    targets = targetsFromTokens(tokens, roller.uuid);
  } else {
    targets = resolveTargets(roller.uuid, { activity: rolling, scaling: consumption.scaling });
  }
  setRollerFromActor(actor);
  const slotLabel = consumption.spellPoints
    ? slotLevelLabel(consumption.spellPoints.level)
    : consumption.spellSlot?.label || usageConfig.irisRepeatSlotLabel || repeat?.irisRepeatSlotLabel || repeat?.slotLabel || "";
  const subtitle = [activity.name, slotLabel].filter(Boolean).join(" · ");
  const base = {
    title,
    subtitle,
    itemImg: item?.img,
    itemUuid: item?.uuid,
    activityId: activity.id,
    roller,
    targets,
    maxTargets: maxTargetCount(rolling, { scaling: consumption.scaling }),
    mode: "normal",
    situational: 0,
    critThreshold: activity.criticalThreshold ?? 20,
    consumption,
    templateUuids
  };

  state.activityDepth += 1;
  try {
    if (activity.type === "attack") {
      const allRolls = [];
      for (const target of targets) {
        allRolls.push(...await fillTargetAttack(target, rolling));
      }
      if (!targets.length) {
        const attackRolls = await rollQuiet(rolling, "rollAttack");
        if (!attackRolls[0]) return;
        allRolls.push(...attackRolls);
        const dual = await dualFromRoll(attackRolls[0]);
        base.d20 = dual.d20;
        base.bonus = dual.bonus;
      }
      const damage = await rollNormalAndCritDamage(rolling, { isCritical: false });
      const critDamage = await rollNormalAndCritDamage(rolling, { isCritical: true });
      const payload = {
        ...base,
        kind: "attack",
        damage,
        critDamage
      };
      rememberTargets(payload);
      await postCard(payload, { actor, rolls: allRolls });
      return;
    }

    if (activity.type === "save") {
      const dc = await rollTargetSaves(activity, targets);
      const damage = await rollNormalAndCritDamage(rolling, { isCritical: false });
      const critDamage = await rollNormalAndCritDamage(rolling, { isCritical: false });
      const payload = {
        ...base,
        kind: "save",
        dc,
        onSave: activity.damage?.onSave ?? "half",
        saveAbilities: [...(activity.save?.ability ?? [])],
        damage,
        critDamage
      };
      rememberTargets(payload);
      await postCard(payload, { actor });
      return;
    }

    if (activity.type === "damage" || activity.type === "heal") {
      const damage = await rollNormalAndCritDamage(rolling, { isCritical: false });
      const critDamage = await rollNormalAndCritDamage(rolling, { isCritical: activity.type === "damage" });
      await postCard({
        ...base,
        kind: activity.type,
        damage,
        critDamage
      }, { actor });
      return;
    }

    if (activity.type === "utility") {
      const listed = collectApplyableEffects(item, activity);
      const effects = listed.map(e => ({
        id: e.id,
        name: e.name,
        img: e.img
      }));
      await postCard({
        ...base,
        kind: "utility",
        effects,
        concentrationUuid: results.effects?.[0]?.uuid ?? ""
      }, { actor });
      return;
    }

    if (activity.type === "check") {
      const associated = [...(activity.check?.associated ?? [])];
      const skill = associated.find(k => CONFIG.DND5E.skills?.[k]);
      const tool = associated.find(k => CONFIG.DND5E.tools?.[k]);
      const ability = activity.check?.ability;
      const dc = activity.check?.dc?.value ?? null;
      let rolls;
      if (skill) rolls = await rollQuiet(actor, "rollSkill", { skill, ability });
      else if (tool) rolls = await rollQuiet(actor, "rollToolCheck", { tool, ability });
      else rolls = await rollQuiet(actor, "rollAbilityCheck", { ability });
      if (!rolls?.[0]) return;
      const dual = await dualFromRoll(rolls[0]);
      await postCard({
        ...base,
        kind: "check",
        d20: dual.d20,
        bonus: dual.bonus,
        dc,
        skill,
        ability,
        reliableTalent: shouldApplyReliableTalent(actor, { skill, tool, kind: skill ? "skill" : tool ? "tool" : "check" })
      }, { actor, rolls });
    }
  } finally {
    state.activityDepth -= 1;
  }
}

Hooks.once("init", () => {
  const loader = foundry.applications?.handlebars?.loadTemplates ?? loadTemplates;
  loader([TEMPLATE, DIE_EDIT_TEMPLATE]);
});

Hooks.once("ready", () => {
  if (game.system.id !== "dnd5e") return;

  const conflicts = ["midi-qol", "ready-set-roll-5e"].filter(id => game.modules.get(id)?.active);
  if (conflicts.length) ui.notifications.warn(localize("Conflict"));

  game.socket.on(`module.${MODULE_ID}`, handleSocket);
  bindCardListeners();
  wrapSpeakerForIrisRoller();
  state.handleActivity = handleActivity;

  const bindSheet = app => bindSheetAsRoller(app);
  Hooks.on("renderActorSheet", bindSheet);
  Hooks.on("renderActorSheetV2", bindSheet);
  Hooks.on("renderApplicationV2", app => {
    if (app?.document?.documentName === "Actor") bindSheetAsRoller(app);
  });

  Hooks.on("dnd5e.preUseActivity", (activity, usageConfig, dialogConfig, messageConfig) => {
    dialogConfig.configure = false;
    if (usageConfig?.irisReaction) return;
    if (!HANDLED_ACTIVITIES.has(activity.type)) return;
    usageConfig.subsequentActions = false;
    messageConfig.create = false;
    usageConfig.irisRolls = true;
    if (shouldUseSpellPoints(activity, usageConfig)) {
      if (usageConfig.consume === true || usageConfig.consume == null) {
        usageConfig.consume = { spellSlot: false, spellPoints: true };
      } else if (usageConfig.consume !== false) {
        usageConfig.consume.spellSlot = false;
        usageConfig.consume.spellPoints = true;
      }
      usageConfig.irisUseSpellPoints = true;
      usageConfig.spellPointsItem ??= getSpellPointsItem(activity.actor);
      const spItem = usageConfig.spellPointsItem || getSpellPointsItem(activity.actor);
      const key = usageConfig.spell?.slot;
      const level = slotKeyLevel(activity.actor, key, activity.item);
      const cost = spellPointCostForLevel(activity.actor, level);
      const remaining = spellPointsRemaining(spItem, activity.actor);
      if (cost > remaining) {
        ui.notifications.warn(localize("NoSpellPoints", {
          name: spItem?.name || "Spell Points",
          cost,
          remaining
        }));
        return false;
      }
    }
    usageConfig.irisSnapshot = snapshotConsumption(activity, usageConfig);
    if (usageConfig.irisRepeat) usageConfig.create = false;
    else if (activity.target?.template?.type) {
      usageConfig.create ??= {};
      usageConfig.create.measuredTemplate = true;
    }
  });

  Hooks.on("dnd5e.preActivityConsumption", (activity, usageConfig) => {
    if (!usageConfig?.irisUseSpellPoints || !usageConfig.consume || usageConfig.consume === true) return;
    usageConfig.consume.spellSlot = false;
  });

  Hooks.on("dnd5e.postUseActivity", (activity, usageConfig, results) => {
    if (!usageConfig.irisRolls) return;
    void handleActivity(activity, usageConfig, results).catch(err => {
      console.error(`${MODULE_ID} | activity`, err);
      ui.notifications.error(localize("FailedCard"));
    });
  });

  for (const hook of [
    "dnd5e.preRollSkillV2",
    "dnd5e.preRollToolV2",
    "dnd5e.preRollAbilityCheckV2",
    "dnd5e.preRollSavingThrowV2",
    "dnd5e.preRollConcentrationV2",
    "dnd5e.preRollAttackV2",
    "dnd5e.preRollDamageV2"
  ]) {
    Hooks.on(hook, (config, dialog, message) => skipDialog(config, dialog, message));
  }

  Hooks.on("dnd5e.rollSkillV2", (rolls, data) => {
    const actor = data.subject;
    void cardFromD20({
      kind: "skill",
      rolls,
      actor,
      title: localize("Skill", { skill: skillLabel(data.skill) }),
      subtitle: actor?.name ?? "",
      extra: { skill: data.skill }
    });
  });

  Hooks.on("dnd5e.rollToolCheckV2", (rolls, data) => {
    const actor = data.subject;
    void cardFromD20({
      kind: "tool",
      rolls,
      actor,
      title: game.i18n.localize("DND5E.ToolCheck"),
      subtitle: actor?.name ?? "",
      extra: { tool: data.tool }
    });
  });

  Hooks.on("dnd5e.rollAbilityCheck", (rolls, data) => {
    const actor = data.subject;
    void cardFromD20({
      kind: "ability",
      rolls,
      actor,
      title: localize("Ability", { ability: abilityLabel(data.ability) }),
      subtitle: actor?.name ?? "",
      extra: { ability: data.ability }
    });
  });

  Hooks.on("dnd5e.rollSavingThrow", (rolls, data) => {
    const roll = Array.isArray(rolls) ? rolls[0] : rolls;
    if (roll?.options?.irisSkip || roll?.options?.irisConcentration || data?.hookNames?.includes?.("deathSave")) return;
    const actor = data.subject;
    void cardFromD20({
      kind: "savingThrow",
      rolls,
      actor,
      title: localize("SavingThrow", { ability: abilityLabel(data.ability) }),
      subtitle: actor?.name ?? "",
      extra: { ability: data.ability }
    });
  });

  Hooks.on("dnd5e.rollAttackV2", (rolls, data) => {
    const activity = data.subject;
    const actor = actorFromSubject(activity);
    if (!actor) return;
    void cardFromD20({
      kind: "attack",
      rolls,
      actor,
      title: `${activity.item?.name ?? actor?.name ?? ""} — ${localize("Attack")}`,
      subtitle: activity.name ?? "",
      extra: {
        itemImg: activity.item?.img,
        itemUuid: activity.item?.uuid,
        activityId: activity.id,
        critThreshold: activity.criticalThreshold ?? 20,
        activity
      }
    });
  });

  Hooks.on("dnd5e.rollConcentrationV2", (rolls, data) => {
    void postConcentrationCard(rolls, data.subject).catch(err => {
      console.error(`${MODULE_ID} | concentration`, err);
    });
  });
});

