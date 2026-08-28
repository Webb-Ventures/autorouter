import type { Capability } from "../catalog/types.ts";
import type { RouteHit, RouteResult } from "../router.ts";
import { compactSchema, tokensOf } from "../util/compact.ts";

export type RenderOptions = {
  /**
   * Inline the full description and input schema for top tool hits.
   *
   * Off when the host is about to receive the same tools natively via
   * activation — the schema would then be paid for twice, once here and once
   * in the host's own tool list.
   */
  inlineSchemas?: boolean;
  /** How many hits get the full treatment before falling back to one-liners. */
  inlineLimit?: number;
  /**
   * Ceiling on the tokens spent inlining schemas in one result.
   *
   * Counting hits instead would be cheaper to reason about and would not
   * actually bound anything: three Datadog schemas cost seven times three
   * Supabase ones. The budget is what makes a search's cost predictable
   * regardless of which corner of the catalog it lands in.
   */
  inlineBudget?: number;
};

/**
 * Search results are the router's whole value proposition, so they stay terse
 * by default — roughly 40-60 tokens per hit.
 *
 * The exception is tools, which get their full description and input schema
 * inlined. A one-line summary is enough to *choose* a tool but not enough to
 * *call* one: a truncated sentence leaves the model guessing at argument names,
 * and a guessed argument is the difference between the router being roughly
 * reliable and being as reliable as a native tool list. Parity is the rule —
 * each kind gets exactly what the harness would natively show for it, which for
 * a tool is name + description + schema, and for a skill is name + description
 * with the body loaded only on invocation (bodies run 300-7000 tokens, so
 * inlining those would recreate the bloat the router exists to remove).
 */
export function renderRouteResult(
  query: string,
  result: RouteResult,
  opts: RenderOptions = {},
): string {
  if (!result.hits.length) {
    return [
      `No capability matched "${query}".`,
      result.note ? `(${result.note})` : "",
      "Try different wording, or handle the request with your built-in tools.",
    ]
      .filter(Boolean)
      .join("\n");
  }

  const inlineLimit = opts.inlineSchemas ? (opts.inlineLimit ?? 3) : 0;
  let budget = opts.inlineSchemas ? (opts.inlineBudget ?? INLINE_BUDGET) : 0;
  let inlined = 0;
  const lines = result.hits.map((hit, i) => {
    const schema = hit.capability.kind === "tool" ? compactSchema(hit.capability.inputSchema) : null;
    const cost = schema ? tokensOf(schema) : 0;
    // Hits are ranked, so spending the budget top-down means the schema that
    // does get inlined is the one most likely to be called.
    const full = Boolean(schema) && inlined < inlineLimit && cost <= budget;
    if (full) {
      inlined++;
      budget -= cost;
    }
    return full ? renderFullHit(hit, i + 1, schema) : renderHit(hit, i + 1);
  });

  const footer = [
    `Selected ${result.hits.length} of ${result.considered} candidates via ${result.backend}${result.model ? ` (${result.model})` : ""}.`,
    result.note ?? "",
    inlined
      ? "Schemas above are callable as shown. Use describe_capability for the others, or for a field a schema abbreviates."
      : "Call describe_capability for the full schema, then call_capability to run it.",
  ]
    .filter(Boolean)
    .join(" ");

  return `${lines.join("\n")}\n\n${footer}`;
}

function renderHit(hit: RouteHit, n: number): string {
  const cap = hit.capability;
  const where = cap.server ? ` · ${cap.server}` : "";
  const reason = hit.reason ? ` — ${hit.reason}` : "";
  return `${n}. ${cap.id}  (${cap.kind}${where})\n   ${oneLine(cap.description, 180)}${reason}`;
}

/**
 * Total tokens one search may spend on inlined schemas.
 *
 * Sized so the worst case — a query landing squarely on Datadog, whose schemas
 * are the largest in the catalog — costs about what a typical query does,
 * rather than three times as much.
 */
const INLINE_BUDGET = 700;

/** A tool hit carrying everything needed to call it without a second round trip. */
function renderFullHit(hit: RouteHit, n: number, schema: unknown): string {
  const cap = hit.capability;
  const where = cap.server ? ` · ${cap.server}` : "";
  const reason = hit.reason ? `\n   why: ${hit.reason}` : "";
  return [
    `${n}. ${cap.id}  (${cap.kind}${where})`,
    `   ${oneLine(cap.description, 400)}${reason}`,
    `   arguments: ${JSON.stringify(schema)}`,
  ].join("\n");
}

/** Full detail for a single capability, including how to actually invoke it. */
export function renderCapability(capability: Capability, body?: string): string {
  const parts: string[] = [];
  parts.push(`${capability.id}  (${capability.kind}${capability.server ? ` from ${capability.server}` : ""})`);
  if (capability.title) parts.push(capability.title);
  parts.push("", capability.description);

  if (capability.inputSchema) {
    // Uncompacted, unlike a search result: describe_capability is the explicit
    // "give me everything about this one" request, and its whole purpose is to
    // recover any detail a budgeted search result had to leave out.
    parts.push("", "Input schema:", "```json", JSON.stringify(capability.inputSchema), "```");
  }
  if (capability.uri) parts.push("", `Resource URI: ${capability.uri}`);

  if (body) {
    // For a skill the body IS the instruction payload — following it is how
    // the skill "runs", so it is returned in full rather than summarized.
    parts.push("", "--- instructions ---", body.trim());
  }

  parts.push("", invocationHint(capability));
  return parts.join("\n");
}

function invocationHint(cap: Capability): string {
  switch (cap.kind) {
    case "tool":
      return `Run with: call_capability({ id: "${cap.id}", arguments: { … } })`;
    case "prompt":
      return `Fetch with: call_capability({ id: "${cap.id}", arguments: { …prompt args } })`;
    case "resource":
      return `Read with: call_capability({ id: "${cap.id}" })`;
    case "skill":
    case "command":
    case "agent":
      return "Follow the instructions above directly — there is nothing further to call.";
    default:
      return "";
  }
}

export function oneLine(text: string, max: number): string {
  const s = (text ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
