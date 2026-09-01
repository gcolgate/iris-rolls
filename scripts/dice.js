import { state } from "./constants.js";

export function usedDieIndex(d20, mode) {
  const [a, b] = d20;
  if (mode === "advantage") return a >= b ? 0 : 1;
  if (mode === "disadvantage") return a <= b ? 0 : 1;
  return 0;
}

export function rollTotal(d20, mode="normal", bonus=0, situational=0, { minFace=0 }={}) {
  const index = usedDieIndex(d20 ?? [0, 0], mode);
  const raw = Number(d20?.[index]) || 0;
  const floor = Number(minFace) || 0;
  const face = floor > 0 ? Math.max(raw, floor) : raw;
  const total = face + (Number(bonus) || 0) + (Number(situational) || 0);
  return { index, face, raw, total };
}

export async function rollD20Face() {
  const roll = await new Roll("1d20").evaluate();
  return Number(roll.total) || 1;
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

export async function rollQuiet(subject, method, config = {}) {
  return withQuiet(async () => {
    const rolls = await subject[method](
      { advantage: false, disadvantage: false, ...config },
      { configure: false },
      { create: false }
    );
    return Array.isArray(rolls) ? rolls : (rolls ? [rolls] : []);
  });
}

export function serializeDamage(rolls = []) {
  return rolls.map(roll => {
    const dice = (roll.dice ?? []).map(die => ({
      formula: die.expression || `${die.number}d${die.faces}`,
      faces: die.faces,
      results: (die.results ?? []).map(r => ({
        result: r.result,
        active: r.active !== false && !r.discarded,
        discarded: Boolean(r.discarded)
      }))
    }));
    return {
      formula: roll.formula,
      total: roll.total,
      type: roll.options?.type ?? "",
      properties: [...(roll.options?.properties ?? [])],
      dice,
      tooltip: formatDamageTooltip({ formula: roll.formula, total: roll.total, type: roll.options?.type ?? "", dice })
    };
  });
}

export function formatDamageTooltip(part={}) {
  if (part.tooltip) return part.tooltip;
  const chunks = [];
  for (const die of part.dice ?? []) {
    const active = (die.results ?? []).filter(r => r.active !== false && !r.discarded).map(r => r.result);
    const discarded = (die.results ?? []).filter(r => r.discarded || r.active === false).map(r => r.result);
    if (!active.length && !discarded.length) continue;
    let bit = `${die.formula || `d${die.faces}`}: ${active.join(", ")}`;
    if (discarded.length) bit += ` (dropped ${discarded.join(", ")})`;
    chunks.push(bit);
  }
  if (!chunks.length && part.formula) chunks.push(part.formula);
  const type = part.type ? ` ${part.type}` : "";
  chunks.push(`= ${part.total ?? 0}${type}`);
  return chunks.join(" · ");
}

export function formatPartsTooltip(parts=[], bonus=0) {
  const lines = parts.map(formatDamageTooltip).filter(Boolean);
  const n = Number(bonus) || 0;
  if (n) lines.push(`bonus: ${n > 0 ? "+" : ""}${n}`);
  return lines.join("\n");
}
// we need to roll then both so we can switch them if needed without asking for more rolls
export async function rollNormalAndCritDamage(activity, { isCritical = false } = {}) {
  const a = await rollQuiet(activity, "rollDamage", { isCritical });
  return {
    a: serializeDamage(a),
    b: serializeDamage(a)
  };
}

export function damageTotal(parts = []) {
  return parts.reduce((sum, p) => sum + (Number(p.total) || 0), 0);
}

export function selectDamage(payload, target=null) {
  const d20 = target?.d20 ?? payload.d20;
  const mode = target?.mode ?? payload.mode ?? "normal";
  const hasD20 = Array.isArray(d20) && d20.length >= 2;
  const { index, face } = rollTotal(d20, mode);
  const isFumble = hasD20 && face === 1;
  const isCrit = hasD20 && !isFumble && face >= (payload.critThreshold ?? 20);
  const pack = (isCrit ? payload.critDamage : payload.damage) ?? payload.damage;
  const parts = pack?.a ?? pack?.b ?? [];
  return { parts, isCrit, index, pack };
}
