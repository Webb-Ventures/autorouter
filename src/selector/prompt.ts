import type { SelectorInput, Selection } from "./types.ts";

export const SELECTOR_SYSTEM = `You are a capability router for an AI coding agent.

You are given the agent's current request and a list of candidate capabilities
(MCP tools, skills, prompts, slash commands, subagents) retrieved by a keyword
and embedding search. The search is recall-oriented, so most candidates are
irrelevant.

Pick ONLY the capabilities that are actually needed to serve the request.
Rules:
- Precision over recall. Returning 2 correct capabilities beats returning 8 with
  6 wrong ones — every extra capability costs the calling agent context budget.
- If nothing fits, return an empty list. Do not pad.
- Prefer a specific tool over a general one when both would work.
- A skill and a tool can both be relevant (e.g. a "charting" skill plus a
  "query database" tool); include both when the request needs both steps.
- Judge by what the capability DOES, not by surface word overlap with the query.
- Order by usefulness, most useful first.

Respond with JSON only, no prose, no code fence:
{"selections":[{"id":"<exact id from the list>","reason":"<max 12 words>","confidence":0.0-1.0}]}`;

export function buildSelectorUser(input: SelectorInput): string {
  const lines = input.candidates.map((c, i) => {
    const cap = c.capability;
    const where = cap.server ? ` [${cap.server}]` : "";
    const desc = collapse(cap.description, 240);
    const args = argHint(cap.inputSchema);
    return `${i + 1}. id=${cap.id} (${cap.kind})${where}\n   ${desc}${args ? `\n   args: ${args}` : ""}`;
  });

  return `REQUEST:\n${input.query}\n\nCANDIDATES:\n${lines.join("\n")}\n\nReturn at most ${input.maxResults} selections as JSON.`;
}

/** Compact parameter list — enough to judge fit without the whole schema. */
function argHint(schema: any): string {
  const props = schema?.properties;
  if (!props || typeof props !== "object") return "";
  const required = new Set<string>(Array.isArray(schema.required) ? schema.required : []);
  return Object.keys(props)
    .slice(0, 10)
    .map((k) => (required.has(k) ? k : `${k}?`))
    .join(", ");
}

function collapse(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/**
 * Models wrap JSON in fences, prose, or emit a bare array despite instructions.
 * Accept all of it; a malformed selector response should degrade to index order,
 * never throw.
 */
export function parseSelections(raw: string, validIds: Set<string>): Selection[] {
  const json = extractJson(raw);
  if (!json) return [];
  const list = Array.isArray(json) ? json : (json as any).selections;
  if (!Array.isArray(list)) return [];

  const out: Selection[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const id = typeof item === "string" ? item : item?.id;
    if (typeof id !== "string") continue;
    const resolved = resolveId(id, validIds);
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);
    out.push({
      id: resolved,
      reason: typeof item?.reason === "string" ? item.reason : "",
      confidence: typeof item?.confidence === "number" ? item.confidence : undefined,
    });
  }
  return out;
}

/** Tolerates the model dropping a prefix, e.g. "supabase/execute_sql". */
function resolveId(id: string, validIds: Set<string>): string | null {
  if (validIds.has(id)) return id;
  const lower = id.toLowerCase();
  for (const valid of validIds) {
    const v = valid.toLowerCase();
    if (v === lower || v.endsWith(`:${lower}`) || v.endsWith(`/${lower}`)) return valid;
  }
  return null;
}

function extractJson(raw: string): unknown | null {
  const text = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(text);
  } catch {}
  // Fall back to the first balanced { } or [ ] span.
  for (const [open, close] of [["{", "}"], ["[", "]"]] as const) {
    const start = text.indexOf(open);
    const end = text.lastIndexOf(close);
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {}
    }
  }
  return null;
}
