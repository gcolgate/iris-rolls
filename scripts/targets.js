import { MODULE_ID, localize, state } from "./constants.js";

export function describeActor(actor, token=null) {
  const active = token ?? actor?.getActiveTokens?.({ linked: true })?.[0] ?? actor?.getActiveTokens?.()?.[0];
  return {
    uuid: actor?.uuid ?? "",
    name: active?.name ?? actor?.name ?? "",
    img: active?.document?.texture?.src || actor?.img || "icons/svg/mystery-man.svg"
  };
}

export function hasEvasion(actor) {
  if (!actor?.items) return false;
  for (const item of actor.items) {
    const ident = String(item.system?.identifier || item.identifier || "").toLowerCase();
    const name = String(item.name ?? "").toLowerCase().trim();
    if (ident === "evasion" || ident === "improved-evasion") return true;
    if (name === "evasion" || name === "improved evasion") return true;
  }
  return Boolean(actor.getFlag?.("dnd5e", "evasion"));
}

function tokenId(token) {
  return token.document?.uuid || token.id;
}

export function liveArmorClass(actor, fallback=null) {
  const ac = actor?.system?.attributes?.ac;
  if (!ac) return fallback ?? null;
  const value = Number(ac.value);
  if (!Number.isFinite(value)) return fallback ?? null;
  // dnd5e leaves AE bonuses as a formula string until derived AC folds them in.
  // Flat AC never folds them; we still need Shield and similar to count.
  const extra = typeof ac.bonus === "string" ? Number(ac.bonus) : 0;
  return value + (Number.isFinite(extra) ? extra : 0);
}

export function actorFromTargetSync(target) {
  if (!target) return null;
  if (target.tokenUuid) {
    try {
      const token = fromUuidSync(target.tokenUuid);
      if (token?.actor) return token.actor;
    } catch {}
  }
  if (target.uuid) {
    try {
      const doc = fromUuidSync(target.uuid);
      return doc?.actor ?? doc ?? null;
    } catch {}
  }
  return null;
}

export async function actorFromTarget(target) {
  if (!target) return null;
  if (target.tokenUuid) {
    try {
      const token = await fromUuid(target.tokenUuid);
      if (token?.actor) return token.actor;
    } catch {}
  }
  if (target.uuid) {
    try {
      const doc = await fromUuid(target.uuid);
      return doc?.actor ?? doc ?? null;
    } catch {}
  }
  return null;
}

function readCountValue(...values) {
  for (const raw of values) {
    if (raw == null || raw === "") continue;
    if (typeof raw === "object") {
      const inner = raw.value ?? raw.formula ?? raw.total;
      if (inner == null || inner === "") continue;
      return inner;
    }
    return raw;
  }
  return null;
}

function isSameActor(actor, rollerUuid) {
  if (!actor || !rollerUuid) return false;
  if (actor.uuid === rollerUuid) return true;
  let roller = null;
  try { roller = fromUuidSync(rollerUuid); } catch {}
  if (!roller) return false;
  if (actor.id && roller.id && actor.id === roller.id) return true;
  if (actor.baseActor?.uuid === rollerUuid || actor.baseActor?.id === roller.id) return true;
  if (roller.actor && actor.uuid === roller.actor.uuid) return true;
  return false;
}

function evaluateCount(raw, activity, scaling=0) {
  if (raw == null || raw === "") return null;
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0 && !String(raw).includes("@")) return Math.floor(numeric);
  if (typeof raw !== "string") {
    return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : null;
  }
  try {
    const item = activity?.item;
    const rollData = foundry.utils.deepClone(
      item?.getRollData?.({ deterministic: true })
      ?? activity?.getRollData?.({ deterministic: true })
      ?? {}
    );
    const baseLevel = Number(item?.system?.level ?? rollData?.item?.level) || 0;
    const flagged = Number(item?.getFlag?.("dnd5e", "scaling")) || 0;
    const level = baseLevel + (flagged || Number(scaling) || 0);
    rollData.item = { ...(rollData.item ?? {}), level };
    const total = new Roll(raw, rollData).evaluateSync({ strict: false }).total;
    if (Number.isFinite(total) && total > 0) return Math.floor(total);
  } catch {}
  return null;
}

export function maxTargetCount(activity, { scaling=0 }={}) {
  if (!activity) return null;
  const item = activity.item;
  const target = activity.target ?? item?.system?.target;
  const template = target?.template?.type || item?.system?.target?.template?.type;
  const type = target?.affects?.type || item?.system?.target?.affects?.type;
  const typeConfig = CONFIG.DND5E?.individualTargetTypes?.[type];
  const isIndividual = Boolean(type) && typeConfig?.scalar !== false && !template;

  const sourceFormula = readCountValue(
    foundry.utils.getProperty(activity, "_source.target.affects.count"),
    foundry.utils.getProperty(item, "_source.system.target.affects.count"),
    foundry.utils.getProperty(item?.toObject?.(true) ?? {}, "system.target.affects.count"),
    foundry.utils.getProperty(activity?.toObject?.(true) ?? {}, "target.affects.count")
  );
  const prepared = readCountValue(
    activity.target?.affects?.count,
    item?.system?.target?.affects?.count
  );
  const fromSource = evaluateCount(sourceFormula, activity, scaling);
  const fromPrepared = evaluateCount(prepared, activity, scaling);
  const n = Math.max(fromSource || 0, fromPrepared || 0);
  if (n > 0) return n;

  // Heroism, Polymorph, and similar: one creature, plus one per extra slot level.
  if (isIndividual && type !== "any" && type !== "space") return 1 + (Number(scaling) || 0);
  return null;
}

export function pauseLiveRetarget() {
  state.liveRetargetPause = (state.liveRetargetPause || 0) + 1;
}

export function resumeLiveRetarget() {
  state.liveRetargetPause = Math.max(0, (state.liveRetargetPause || 0) - 1);
}

export function hasNonRollerSelection(rollerUuid) {
  return [...(canvas.tokens?.controlled ?? [])].some(token => token?.actor && !isSameActor(token.actor, rollerUuid));
}

function keepNonRollerSelection(rollerUuid) {
  const others = [...(canvas.tokens?.controlled ?? [])].filter(token => token?.actor && !isSameActor(token.actor, rollerUuid));
  if (others.length) selectTokens(others);
}

export function attackNeedsTarget(activity) {
  if (activity?.type !== "attack") return false;
  if (activity?.target?.template?.type || activity?.item?.system?.target?.template?.type) return false;
  return !hasNonRollerSelection(activity.actor?.uuid);
}

export async function waitForAttackTargets(activity) {
  pauseLiveRetarget();
  try {
    return await waitForAttackTargetsInner(activity);
  } finally {
    resumeLiveRetarget();
  }
}

async function waitForAttackTargetsInner(activity) {
  const rollerUuid = activity.actor?.uuid;
  if (hasNonRollerSelection(rollerUuid)) {
    keepNonRollerSelection(rollerUuid);
    return true;
  }

  const content = `<p class="iris-die-current">${foundry.utils.escapeHTML(localize("PleaseSelectTarget"))}</p>`;
  const DialogV2 = foundry.applications.api.DialogV2;
  const app = new DialogV2({
    window: { title: localize("PleaseSelectTarget"), icon: "fa-solid fa-crosshairs", minimizable: false },
    content,
    position: { width: 360 },
    classes: ["iris-die-dialog", "iris-target-dialog"],
    modal: false,
    rejectClose: true,
    buttons: [{
      action: "wait",
      label: localize("PleaseSelectTarget"),
      disabled: true
    }]
  });

  await app.render({ force: true });

  return new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      Hooks.off("controlToken", onControl);
      keepNonRollerSelection(rollerUuid);
      void app.close?.({ force: true });
      resolve(true);
    };
    const onControl = () => {
      if (hasNonRollerSelection(rollerUuid)) finish();
    };
    Hooks.on("controlToken", onControl);
    onControl();
  });
}

export function resolveTargets(rollerUuid, { activity, max, scaling=0 }={}) {
  const selected = [...(canvas.tokens?.controlled ?? [])].filter(t => t.actor);
  const limit = max ?? maxTargetCount(activity, { scaling });
  const area = activity?.target?.template?.type || activity?.item?.system?.target?.template?.type;

  const pool = [];
  const seenToken = new Set();
  for (const token of selected) {
    const id = tokenId(token);
    if (!id || seenToken.has(id)) continue;
    seenToken.add(id);
    pool.push(token);
  }

  const targets = [];
  for (const token of pool) {
    const actor = token.actor;
    if (!actor) continue;
    const isRoller = isSameActor(actor, rollerUuid);
    if (isRoller && (area || activity?.type === "attack")) continue;
    let sheetActor = actor;
    if (isRoller) {
      try { sheetActor = fromUuidSync(rollerUuid) ?? actor; } catch { sheetActor = actor; }
    }
    targets.push({
      uuid: actor.uuid,
      tokenUuid: token.document?.uuid ?? tokenId(token),
      name: token.name,
      img: token.document?.texture?.src || sheetActor.img || actor.img || "icons/svg/mystery-man.svg",
      ac: liveArmorClass(sheetActor) ?? liveArmorClass(actor),
      evasion: hasEvasion(sheetActor) || hasEvasion(actor),
      isRoller
    });
  }

  if (Number.isFinite(limit) && targets.length > limit) {
    targets.length = limit;
    ui.notifications.info(localize("TargetLimit", {
      name: activity?.item?.name || activity?.name || localize("Title"),
      count: limit
    }));
  }
  return targets;
}

export function getSaveBonus(actor, ability) {
  const abl = actor?.system?.abilities?.[ability];
  if (!abl) return 0;
  if (typeof abl.save === "number") return abl.save;
  if (Number.isFinite(abl.save?.value)) return abl.save.value;
  return abl.mod ?? 0;
}

function abilityList(value) {
  if (!value) return [];
  if (typeof value === "string") return [value];
  return [...value];
}

export function pickSaveAbility(activity, actor) {
  const abilities = abilityList(activity.save?.ability);
  if (!abilities.length) return "dex";
  if (abilities.length === 1) return abilities[0];
  let best = abilities[0];
  let bestBonus = -Infinity;
  for (const ability of abilities) {
    const bonus = getSaveBonus(actor, ability);
    if (bonus > bestBonus) {
      best = ability;
      bestBonus = bonus;
    }
  }
  return best;
}

export function isDexSave(payload, target={}) {
  const abilities = payload.saveAbilities ?? [];
  if (abilities.includes("dex")) return true;
  return target.saveAbility === "dex";
}

export function templateUuidsFromResults(results) {
  return (results?.templates ?? []).flat(Infinity).map(doc => doc?.uuid).filter(Boolean);
}

export function liveTemplateUuids(uuids=[]) {
  return uuids.filter(uuid => {
    try { return Boolean(fromUuidSync(uuid)); } catch { return false; }
  });
}

function regionFromDoc(doc) {
  if (!doc) return null;
  if (doc.documentName === "Region") return doc;
  if (doc.document?.documentName === "Region") return doc.document;
  return null;
}

function tokenIsHidden(token, tokenDoc) {
  return Boolean(
    token?.document?.hidden
    || token?.document?.isSecret
    || tokenDoc?.hidden
    || tokenDoc?.isSecret
  );
}

function tokenCenter(token) {
  return token?.center ?? token?.getCenterPoint?.() ?? (token ? { x: token.x, y: token.y } : null);
}

function regionMembers(region) {
  try { return [...(region?.tokens ?? [])]; } catch { return []; }
}

function tokenInMemberList(token, members) {
  const tokenDoc = token?.document;
  return members.some(member => (
    member === token
    || member === tokenDoc
    || member?.id === token?.id
    || member?.id === tokenDoc?.id
    || member?.uuid === tokenDoc?.uuid
  ));
}

function pointInRegion(point, region, token) {
  if (!point || !region) return false;
  const elevation = Number(token?.document?.elevation ?? token?.elevation ?? 0);
  const object = region.object ?? canvas.regions?.get(region.id);
  const testers = [
    () => region.testPoint?.(point, elevation),
    () => region.testPoint?.({ ...point, elevation }),
    () => region.testPoint?.(point),
    () => object?.testPoint?.(point, elevation),
    () => object?.testPoint?.(point),
    () => region.polygonTree?.testPoint(point),
    () => object?.document?.polygonTree?.testPoint(point)
  ];
  for (const test of testers) {
    try {
      if (test()) return true;
    } catch { /* try the next API */ }
  }
  return false;
}

function waitForRegionReady(region) {
  const ready = () => Boolean(
    region.polygonTree
    || region.object
    || canvas.regions?.get(region.id)
    || (region.tokens?.size ?? region.tokens?.length)
  );
  if (ready()) return region;
  return new Promise(resolve => {
    const finish = () => {
      Hooks.off("refreshRegion", onRefresh);
      resolve(region);
    };
    const onRefresh = placeable => {
      const id = placeable?.id ?? placeable?.document?.id;
      if (id === region.id) finish();
    };
    Hooks.on("refreshRegion", onRefresh);
    window.setTimeout(finish, 400);
  });
}

export async function tokensInTemplates(uuids=[]) {
  const regions = [];
  for (const uuid of uuids) {
    let doc = null;
    try { doc = await fromUuid(uuid); } catch {}
    const region = regionFromDoc(doc);
    if (!region) continue;
    await waitForRegionReady(region);
    regions.push(region);
  }
  const seen = new Set();
  const tokens = [];
  for (const token of canvas.tokens?.placeables ?? []) {
    if (!token.actor) continue;
    if (!game.user.isGM && tokenIsHidden(token, token.document)) continue;
    const id = tokenId(token);
    if (!id || seen.has(id)) continue;
    const point = tokenCenter(token);
    const inside = regions.some(region => {
      const members = regionMembers(region);
      return tokenInMemberList(token, members) || pointInRegion(point, region, token);
    });
    if (!inside) continue;
    seen.add(id);
    tokens.push(token);
  }
  return tokens;
}

export function targetsFromTokens(tokens=[], rollerUuid="") {
  const seenToken = new Set();
  const targets = [];
  for (const token of tokens) {
    const actor = token.actor;
    if (!actor) continue;
    const isRoller = isSameActor(actor, rollerUuid);
    const id = tokenId(token);
    if (!id || seenToken.has(id)) continue;
    seenToken.add(id);
    let sheetActor = actor;
    if (isRoller) {
      try { sheetActor = fromUuidSync(rollerUuid) ?? actor; } catch { sheetActor = actor; }
    }
    targets.push({
      uuid: actor.uuid,
      tokenUuid: token.document?.uuid ?? id,
      name: token.name,
      img: token.document?.texture?.src || sheetActor.img || actor.img || "icons/svg/mystery-man.svg",
      ac: liveArmorClass(sheetActor) ?? liveArmorClass(actor),
      evasion: hasEvasion(sheetActor) || hasEvasion(actor),
      isRoller
    });
  }
  return targets;
}

export async function reviveRepeatTargets(stored=[], rollerUuid="") {
  const out = [];
  for (const t of stored ?? []) {
    const actor = await actorFromTarget(t);
    let tokenDoc = null;
    if (t.tokenUuid) {
      try { tokenDoc = await fromUuid(t.tokenUuid); } catch { tokenDoc = null; }
    }
    const token = tokenDoc?.object ?? null;
    if (actor) {
      const desc = describeActor(actor, token);
      out.push({
        uuid: actor.uuid,
        tokenUuid: tokenDoc?.uuid ?? t.tokenUuid ?? "",
        name: desc.name || t.name || actor.name,
        img: desc.img || t.img || actor.img,
        ac: liveArmorClass(actor, t.ac),
        evasion: hasEvasion(actor),
        isRoller: isSameActor(actor, rollerUuid)
      });
    } else if (t.uuid || t.tokenUuid) {
      out.push({
        uuid: t.uuid || "",
        tokenUuid: t.tokenUuid || "",
        name: t.name || "",
        img: t.img || "icons/svg/mystery-man.svg",
        ac: t.ac ?? null,
        evasion: Boolean(t.evasion),
        isRoller: Boolean(t.isRoller)
      });
    }
  }
  return out;
}

export function tokensFromTargets(targets=[]) {
  const tokens = [];
  const seen = new Set();
  for (const t of targets ?? []) {
    if (!t?.tokenUuid) continue;
    try {
      const doc = fromUuidSync(t.tokenUuid);
      const token = doc?.object ?? canvas.tokens?.get(doc?.id);
      const id = tokenId(token);
      if (!token?.actor || !id || seen.has(id)) continue;
      seen.add(id);
      tokens.push(token);
    } catch { /* token may be gone */ }
  }
  return tokens;
}

export function selectTokens(tokens=[]) {
  pauseLiveRetarget();
  try {
    const list = [...tokens].filter(token => token?.actor);
    canvas.tokens?.releaseAll?.();
    for (const token of list) {
      try { token.control?.({ releaseOthers: false }); } catch { /* unowned tokens may not be selectable */ }
    }
  } finally {
    resumeLiveRetarget();
  }
}

export function tokenForActor(actor) {
  if (!actor) return null;
  if (actor.token?.object) return actor.token.object;
  const id = actor.token?.id;
  if (id && canvas.tokens?.get(id)) return canvas.tokens.get(id);
  const tokens = actor.getActiveTokens?.() ?? [];
  return tokens.find(token => token.scene === canvas.scene || token.document?.parent === canvas.scene) ?? tokens[0] ?? null;
}

export function setRollerFromActor(actor) {
  if (!actor) return;
  pauseLiveRetarget();
  try {
    state.rollerUuid = actor.uuid;
    const token = tokenForActor(actor);
    if (!token) return;
    token.setTarget(true, { releaseOthers: true, groupSelection: true });
    game.user.broadcastActivity?.({ targets: [...(game.user.targets ?? [])].map(t => t.id) });
  } finally {
    resumeLiveRetarget();
  }
}

export function getIrisRoller() {
  const targets = [...(game.user.targets ?? [])].filter(token => token.actor);
  if (targets.length === 1) return { actor: targets[0].actor, token: targets[0] };
  if (state.rollerUuid) {
    let actor = null;
    try { actor = fromUuidSync(state.rollerUuid); } catch {}
    if (actor) return { actor, token: tokenForActor(actor) };
  }
  if (targets.length) return { actor: targets[0].actor, token: targets[0] };
  return null;
}

export function wrapSpeakerForIrisRoller() {
  const Cls = CONFIG.ChatMessage.documentClass;
  if (!Cls?.getSpeaker || Cls.getSpeaker._iris) return;
  const original = Cls.getSpeaker;
  function irisGetSpeaker(options={}) {
    if (options.actor || options.token || options.alias) return original.call(this, options);
    const picked = getIrisRoller();
    if (picked?.actor) {
      return original.call(this, {
        actor: picked.actor,
        token: picked.token?.document ?? picked.token
      });
    }
    return original.call(this, options);
  }
  irisGetSpeaker._iris = true;
  Cls.getSpeaker = irisGetSpeaker;
  if (globalThis.ChatMessage && ChatMessage.getSpeaker !== irisGetSpeaker) {
    ChatMessage.getSpeaker = irisGetSpeaker;
  }
}

export function actorFromSheet(app) {
  if (!app) return null;
  if (app.actor) return app.actor;
  if (app.document?.documentName === "Actor") return app.document;
  return null;
}

export function bindSheetAsRoller(app) {
  const actor = actorFromSheet(app);
  if (!actor) return;
  const el = app.element instanceof HTMLElement
    ? app.element
    : (app.element?.[0] ?? app._element?.[0] ?? null);
  if (!el) {
    setRollerFromActor(actor);
    return;
  }
  if (el.dataset.irisRollerBound) return;
  el.dataset.irisRollerBound = "1";
  setRollerFromActor(actor);
  el.addEventListener("pointerdown", () => {
    const current = actorFromSheet(app);
    if (current) setRollerFromActor(current);
  }, { capture: true });
}

export async function placeActivityTemplates(activity) {
  if (!activity || !game.user.can("REGION_CREATE") || !canvas?.scene) return [];
  try {
    const created = await dnd5e.canvas?.TemplatePlacement?.fromActivity?.(activity);
    if (!created) return [];
    return [...created].filter(doc => doc?.uuid);
  } catch {
    return [];
  }
}

export async function deleteTemplates(uuids=[]) {
  for (const uuid of uuids) {
    let doc = null;
    try { doc = await fromUuid(uuid); } catch {}
    if (!doc) continue;
    if (game.user.isGM || doc.canUserModify?.(game.user, "delete")) await doc.delete();
    else game.socket.emit(`module.${MODULE_ID}`, { op: "deleteDoc", uuid });
  }
}
