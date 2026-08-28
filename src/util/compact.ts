/**
 * Schema and text compaction.
 *
 * A router only earns its keep if what it puts in context is smaller than what
 * it replaced. Measured on this machine, MCP tool schemas run p50=151 tokens but
 * max out at 1,475 — and the tail is almost entirely English prose in property
 * descriptions, not structure. Datadog's `get_datadog_metric` spends over a
 * thousand tokens explaining query syntax inside `properties.queries.items`.
 *
 * So compaction is asymmetric on purpose: every structural field survives
 * untouched (names, types, enums, required, nesting), because dropping one of
 * those turns a valid call into a guessed one. Prose is what gets trimmed, and
 * more aggressively the deeper it sits, since a nested property's essay matters
 * far less than the top-level argument list.
 */

/** Fields carrying no information the model needs in order to call a tool. */
const DROP = new Set(["$schema", "$id", "title", "examples", "example"]);

export type CompactOptions = {
  /** Prose budget for a top-level property description. */
  descChars?: number;
  /** Below this depth, descriptions are dropped rather than truncated. */
  maxDepth?: number;
};

export function compactSchema(schema: unknown, opts: CompactOptions = {}): unknown {
  return walk(schema, 0, opts.descChars ?? 160, opts.maxDepth ?? 3);
}

function walk(node: unknown, depth: number, descChars: number, maxDepth: number): unknown {
  if (Array.isArray(node)) return node.map((v) => walk(v, depth, descChars, maxDepth));
  if (!node || typeof node !== "object") return node;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (DROP.has(key)) continue;
    // `additionalProperties: true` is the JSON Schema default and says nothing;
    // `false` is a real constraint the downstream server will enforce, and
    // dropping it would let the model pass an extra argument that the router
    // accepts and the server then rejects.
    if (key === "additionalProperties" && value !== false) continue;

    if (key === "description" && typeof value === "string") {
      // Past the depth cut a description is describing a field the model will
      // rarely set at all; the type and name still reach it either way.
      if (depth > maxDepth) continue;
      // Descriptions get terser with depth: a top-level argument earns its
      // sentence, a grandchild of an array item does not.
      const budget = Math.max(60, descChars >> depth);
      const text = clamp(value, budget);
      if (text) out[key] = text;
      continue;
    }

    // "properties" and "$defs" are maps of names to schemas, so their keys are
    // data, not structure — the children advance a level, the container does not.
    const nextDepth = key === "properties" || key === "$defs" || key === "definitions" ? depth : depth + 1;
    out[key] = walk(value, nextDepth, descChars, maxDepth);
  }
  return out;
}

/** Truncates on a word boundary so the trailing fragment still reads. */
export function clamp(text: string, max: number): string {
  const s = (text ?? "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[,;:.\s]+$/, "")}…`;
}

/** Rough token count. Good enough to spend a budget against, not to bill on. */
export function tokensOf(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return Math.ceil(text.length / 4);
}
