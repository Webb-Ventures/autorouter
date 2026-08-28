import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { SelectorConfig } from "../config/types.ts";
import type { Scored } from "../index/search.ts";
import type { SelectorBackend, SelectorResult } from "./types.ts";
import { SELECTOR_SYSTEM, buildSelectorUser, parseSelections } from "./prompt.ts";
import { apiBackend, cliBackend, samplingBackend } from "./backends.ts";

/**
 * Memoized selections, keyed by query and candidate set.
 *
 * The CLI backend costs ~18s, essentially all of it agent startup, which is
 * tolerable once and not at all on a repeat. Models re-issue near-identical
 * searches constantly — rephrasing after a failure, or asking again later in a
 * long session — and the answer cannot have changed unless the catalog did,
 * which the candidate list already reflects.
 *
 * Small and unbounded-in-time on purpose: the process is a session, and a
 * session's worth of distinct queries is dozens, not thousands.
 */
const CACHE_LIMIT = 64;
const cache = new Map<string, SelectorResult>();

/** Stores a real selector answer, evicting the least recently used. */
function remember(key: string, result: SelectorResult): SelectorResult {
  // Only genuine selections are cached. A fallback records a transient failure
  // — a timeout, a missing binary — and caching it would make one bad moment
  // permanent for the rest of the session.
  cache.set(key, result);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
  return result;
}

function cacheKey(query: string, candidates: Scored[]): string {
  // The candidate ids are part of the key, so a refreshed catalog invalidates
  // exactly the entries whose answer could actually differ.
  return `${query.trim().toLowerCase()}\u0000${candidates.map((c) => c.capability.id).join(",")}`;
}

export type SelectorContext = {
  config: SelectorConfig;
  /** Client name from the MCP initialize handshake, or "cli". */
  harness: string;
  /** Present only when running as an MCP server. */
  server?: Server;
};

/**
 * Stage two of the router: a separate, cheap model reads the candidate list and
 * decides which capabilities the request actually needs. It runs in its own
 * context, so the calling agent never sees the candidates it rejected.
 *
 * Every failure path degrades to index order rather than erroring — a router
 * that returns slightly worse results is far better than one that returns none.
 */
export async function selectCapabilities(
  query: string,
  candidates: Scored[],
  ctx: SelectorContext,
): Promise<SelectorResult> {
  const maxResults = ctx.config.maxResults ?? 8;
  const fallback = (note: string): SelectorResult => ({
    selections: candidates.slice(0, maxResults).map((c) => ({
      id: c.capability.id,
      reason: "",
    })),
    backend: "index",
    note,
  });

  if (ctx.config.mode === "off") return fallback("selector disabled (mode: off)");
  if (candidates.length === 0) return { selections: [], backend: "index" };
  // Nothing to narrow: hand back everything rather than paying for a call.
  if (candidates.length <= 2) return fallback("too few candidates to rerank");

  const key = cacheKey(query, candidates);
  const hit = cache.get(key);
  if (hit) {
    // Refresh LRU position: a query the model keeps returning to is the one
    // worth keeping.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }

  const backend = pickBackend(ctx);
  if (!backend) {
    return fallback(
      "no selector model available — install the harness CLI (claude/codex) on PATH, or set selector.model/apiKeyEnv",
    );
  }

  const user = buildSelectorUser({ query, candidates, maxResults });
  const validIds = new Set(candidates.map((c) => c.capability.id));

  try {
    const timeoutMs = Math.max(ctx.config.timeoutMs ?? 20000, backend.minTimeoutMs ?? 0);
    const raw = await backend.complete(SELECTOR_SYSTEM, user, timeoutMs);
    const selections = parseSelections(raw, validIds).slice(0, maxResults);
    // An empty list is a legitimate answer ("nothing here fits"), but an
    // unparseable one is not. parseSelections cannot distinguish, so treat a
    // non-empty response body as an intentional empty selection.
    if (!selections.length && !raw.trim()) return fallback("selector returned nothing");
    return remember(key, { selections, backend: backend.id, model: backend.model });
  } catch (err) {
    return fallback(`selector failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Preference order in "auto": sampling, then a configured API key, then the
 * harness CLI.
 *
 * Sampling first because it is the protocol's own answer and costs one
 * round trip. The API backend outranks the CLI because when a key *is* present
 * it is the same model for a fraction of the latency — shelling out spends ~7s
 * on process startup against ~1s for a request. The CLI is last and is also the
 * one that usually fires, since a Claude Code or Codex user authenticated with a
 * subscription login and has no API key at all; without it the router would tell
 * them to go buy one to use a model they are already paying for.
 */
function pickBackend(ctx: SelectorContext): SelectorBackend | null {
  const mode = ctx.config.mode ?? "auto";
  if (mode === "sampling") return ctx.server ? samplingBackend(ctx.server) : null;
  if (mode === "cli") return cliBackend(ctx.config, ctx.harness);
  if (mode === "api") return apiBackend(ctx.config, ctx.harness);
  return (
    (ctx.server ? samplingBackend(ctx.server) : null) ??
    apiBackend(ctx.config, ctx.harness) ??
    cliBackend(ctx.config, ctx.harness)
  );
}
