import type { RouteHit } from "../router.ts";

/**
 * find_capabilities({ query, arguments, auto: true }) runs the top hit in the
 * same request — but only when "top" means something.
 *
 * Index scores are min-max normalised over the candidate set, so the best
 * lexical hit is always ~1.0 and the absolute value says nothing; the gap to the
 * runner-up is what carries the signal. A quarter of the range is a clear
 * lead: in practice a near-tie between `list_issues` and `search_issues` sits
 * well inside it, and a query that names the tool sits well outside it.
 *
 * When the selector model ranked the hits and gave confidences, those are used
 * instead, since its order may differ from the index's. It must be confident in
 * the top hit outright, and lead the next one by the same margin.
 */
export const AUTO_MARGIN = 0.25;
export const AUTO_MIN_CONFIDENCE = 0.7;

export type AutoVerdict = { ok: true; why: string } | { ok: false; reason: string };

export function autoCallVerdict(hits: RouteHit[]): AutoVerdict {
  const top = hits[0];
  if (!top) return { ok: false, reason: "nothing matched" };
  if (top.capability.kind !== "tool") return { ok: false, reason: `top hit ${top.capability.id} is a ${top.capability.kind}, not a tool` };
  const second = hits[1];

  if (typeof top.confidence === "number") {
    if (top.confidence < AUTO_MIN_CONFIDENCE) {
      return { ok: false, reason: `selector confidence ${top.confidence.toFixed(2)} is below ${AUTO_MIN_CONFIDENCE}` };
    }
    if (second && typeof second.confidence === "number" && top.confidence - second.confidence < AUTO_MARGIN) {
      return { ok: false, reason: `${top.capability.id} and ${second.capability.id} are too close to call` };
    }
    return { ok: true, why: `selector confidence ${top.confidence.toFixed(2)}` };
  }

  if (!second) return { ok: true, why: "only match" };
  // A reranked list without confidences: if the selector put something other
  // than the best-scoring hit first, the two signals disagree — not a clear win.
  const bestOther = Math.max(...hits.slice(1).map((h) => h.score));
  const margin = top.score - bestOther;
  if (margin < AUTO_MARGIN) {
    return { ok: false, reason: `${top.capability.id} and ${second.capability.id} are too close to call` };
  }
  return { ok: true, why: `clear top match, margin ${margin.toFixed(2)}` };
}

/**
 * The checks a host would make before calling a native tool: required
 * properties present, provided ones of the declared basic type, enums honoured,
 * no unknown keys where the schema forbids them. Not a full JSON Schema
 * validator — the downstream server still validates — but enough that auto
 * never fires a call the model obviously had not shaped for this tool.
 */
export function validateArgs(schema: unknown, args: unknown): string[] {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return ["arguments must be an object"];
  if (!schema || typeof schema !== "object") return [];
  const s = schema as {
    properties?: Record<string, any>;
    required?: string[];
    additionalProperties?: unknown;
  };
  const a = args as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of s.required ?? []) {
    if (!(key in a) || a[key] === undefined) problems.push(`missing required "${key}"`);
  }
  for (const [key, value] of Object.entries(a)) {
    const prop = s.properties?.[key];
    if (!prop) {
      if (s.additionalProperties === false) problems.push(`unknown argument "${key}"`);
      continue;
    }
    const types = prop.type === undefined ? null : Array.isArray(prop.type) ? prop.type : [prop.type];
    if (types && !types.some((t: string) => matchesType(t, value))) {
      problems.push(`"${key}" should be ${types.join(" or ")}`);
    }
    if (Array.isArray(prop.enum) && !prop.enum.some((e: unknown) => JSON.stringify(e) === JSON.stringify(value))) {
      problems.push(`"${key}" must be one of ${prop.enum.map((e: unknown) => JSON.stringify(e)).join(", ")}`);
    }
  }
  return problems;
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "null":
      return value === null;
    default:
      return true;
  }
}
