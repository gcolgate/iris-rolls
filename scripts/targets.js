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
    if (isRoller && area) continue;
    let sheetActor = actor;
    if (isRoller) {
      try { sheetActor = fromUuidSync(rollerUuid) ?? actor; } catch { sheetActor = actor; }
    }
    targets.push({
      uuid: actor.uuid,
      tokenUuid: token.document?.uuid ?? tokenId(token),
      name: token.name,
      img: token.document?.texture?.src || sheetActor.img || actor.img || "icons/svg/mystery-man.svg",
      ac: sheetActor.system?.attributes?.ac?.value ?? actor.system?.attributes?.ac?.value ?? null,
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

function waitForTemplateObject(doc) {
  const ready = () => doc?.object ?? canvas.templates?.get(doc?.id) ?? null;
  const existing = ready();
  if (existing?.shape) return existing;
  return new Promise(resolve => {
    const hook = Hooks.on("refreshMeasuredTemplate", placeable => {
      if (placeable?.id !== doc?.id && placeable?.document?.id !== doc?.id) return;
      if (!placeable?.shape) return;
      Hooks.off("refreshMeasuredTemplate", hook);
      resolve(placeable);
    });
    window.setTimeout(() => {
      Hooks.off("refreshMeasuredTemplate", hook);
      resolve(ready());
    }, 400);
  });
}

function pointInTemplate(point, object, doc) {
  if (!point) return false;
  if (object && typeof object.testPoint === "function") {
    try { return Boolean(object.testPoint(point)); } catch { /* fall through */ }
  }
  const shape = object?.shape;
  if (shape && typeof shape.contains === "function") {
    const ox = object.x ?? doc?.x ?? 0;
    const oy = object.y ?? doc?.y ?? 0;
    if (shape.contains(point.x - ox, point.y - oy)) return true;
    const cx = object.center?.x ?? ox;
    const cy = object.center?.y ?? oy;
    if (shape.contains(point.x - cx, point.y - cy)) return true;
  }
  return false;
}

export async function tokensInTemplates(uuids=[]) {
  const objects = [];
  for (const uuid of uuids) {
    let doc = null;
    try { doc = await fromUuid(uuid); } catch {}
    if (!doc) continue;
    const object = await waitForTemplateObject(doc);
    if (object || doc) objects.push({ doc, object });
  }
  const seen = new Set();
  const tokens = [];
  for (const token of canvas.tokens?.placeables ?? []) {
    if (!token.actor) continue;
    if (!game.user.isGM && (token.document?.hidden || token.document?.isSecret)) continue;
    const id = tokenId(token);
    if (!id || seen.has(id)) continue;
    if (!objects.some(({ object, doc }) => pointInTemplate(token.center, object, doc))) continue;
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
      ac: sheetActor.system?.attributes?.ac?.value ?? actor.system?.attributes?.ac?.value ?? null,
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
        ac: actor.system?.attributes?.ac?.value ?? t.ac ?? null,
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
  const list = [...tokens].filter(token => token?.actor);
  canvas.tokens?.releaseAll?.();
  for (const token of list) {
    try { token.control?.({ releaseOthers: false }); } catch { /* unowned tokens may not be selectable */ }
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
  state.rollerUuid = actor.uuid;
  const token = tokenForActor(actor);
  if (!token) return;
  token.setTarget(true, { releaseOthers: true, groupSelection: true });
  game.user.broadcastActivity?.({ targets: [...(game.user.targets ?? [])].map(t => t.id) });
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
  if (!activity || !game.user.can("TEMPLATE_CREATE") || !canvas?.scene) return [];
  const previews = dnd5e.canvas?.AbilityTemplate?.fromActivity?.(activity);
  if (!previews?.length) return [];
  const created = [];
  for (const preview of previews) {
    try {
      const result = await preview.drawPreview();
      if (result) created.push(...(Array.isArray(result) ? result : [result]));
    } catch {
      break;
    }
  }
  return created.filter(doc => doc?.uuid);
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
