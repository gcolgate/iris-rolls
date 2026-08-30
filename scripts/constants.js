export const MODULE_ID = "iris-rolls";
export const TEMPLATE = `modules/${MODULE_ID}/templates/roll-card.hbs`;

export const state = {
  suppressCards: 0,
  activityDepth: 0,
  rollerUuid: ""
};

export const HANDLED_ACTIVITIES = new Set(["attack", "save", "damage", "heal", "check", "utility"]);

export function localize(key, data) {
  const s = game.i18n.localize(`IRISROLLS.${key}`);
  return data ? game.i18n.format(`IRISROLLS.${key}`, data) : s;
}

export function getPayload(message) {
  return foundry.utils.getProperty(message, `flags.${MODULE_ID}`) ?? {};
}

export function hasPayload(message) {
  const payload = getPayload(message);
  return Boolean(payload && (payload.kind || payload.d20 || payload.damage));
}

export async function renderHbs(path, data) {
  const renderer = foundry.applications?.handlebars?.renderTemplate ?? renderTemplate;
  return renderer(path, data);
}
