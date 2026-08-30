import { state } from "./constants.js";

export function usedDieIndex(d20, mode) {
  const [a, b] = d20;
  if (mode === "advantage") return a >= b ? 0 : 1;
  if (mode === "disadvantage") return a <= b ? 0 : 1;
  return 0;
}

export async function dualFromRoll(roll) {
  const die = roll.terms.find(t => t.faces === 20) ?? roll.dice?.[0];
  const results = (die?.results ?? []).map(r => r.result).filter(n => Number.isFinite(n));
  const active = die?.results?.find(r => r.active)?.result ?? results[0] ?? 0;
  while (results.length < 2) {
    const extra = await new Roll("1d20").evaluate();
    results.push(extra.terms[0].results[0].result);
  }
  const d20 = results.slice(0, 2);
  const bonus = roll.total - active;
  return {
    d20,
    bonus,
    formula: roll.formula,
    rollJSON: [roll.toJSON()]
  };
}

async function withQuiet(fn) {
  state.suppressCards += 1;
  try {
    return await fn();
  } finally {
    state.suppressCards -= 1;
  }
}

export async function rollQuiet(subject, method, config={}) {
  return withQuiet(async () => {
    const rolls = await subject[method](
      { advantage: false, disadvantage: false, ...config },
      { configure: false },
      { create: false }
    );
    return Array.isArray(rolls) ? rolls : (rolls ? [rolls] : []);
  });
}

export function serializeDamage(rolls=[]) {
  return rolls.map(roll => ({
    formula: roll.formula,
    total: roll.total,
    type: roll.options?.type ?? "",
    properties: [...(roll.options?.properties ?? [])]
  }));
}

export async function rollNormalAndCritDamage(activity, { isCritical=false }={}) {
  const a = await rollQuiet(activity, "rollDamage", { isCritical });
  return {
    a: serializeDamage(a),
    b: serializeDamage(a)
  };
}

export function damageTotal(parts=[]) {
  return parts.reduce((sum, p) => sum + (Number(p.total) || 0), 0);
}

export function selectDamage(payload) {
  const hasD20 = Array.isArray(payload.d20) && payload.d20.length >= 2;
  const index = hasD20 ? usedDieIndex(payload.d20, payload.mode) : 0;
  const isCrit = hasD20 && Number(payload.d20[index]) >= (payload.critThreshold ?? 20);
  const pack = (isCrit ? payload.critDamage : payload.damage) ?? payload.damage;
  const parts = pack?.a ?? pack?.b ?? [];
  return { parts, isCrit, index, pack };
}
