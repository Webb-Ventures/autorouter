import { join } from "node:path";
import { createHash } from "node:crypto";
import type { EmbeddingsConfig } from "../config/types.ts";
import type { Capability } from "../catalog/types.ts";
import { cacheDir } from "../util/paths.ts";
import { ensureDir, mapLimit, readText, writeText } from "../util/fs.ts";

export type Vector = Float32Array;

export interface EmbeddingProvider {
  readonly id: string;
  /** `timeoutMs` bounds the whole request; past it the call rejects. */
  embed(texts: string[], opts?: { timeoutMs?: number }): Promise<Vector[]>;
}

/**
 * Request timeouts. A fetch has none by default, so an endpoint that accepted
 * the connection and then stalled held a search (the per-query embed) or a
 * rebuild (the catalog batches) open indefinitely. A query embed that times
 * out rejects, and the search falls back to lexical scoring.
 */
export const QUERY_EMBED_TIMEOUT_MS = 8_000;
const BATCH_EMBED_TIMEOUT_MS = 60_000;

export function createProvider(cfg: EmbeddingsConfig): EmbeddingProvider | null {
  if (!cfg.provider || cfg.provider === "none") return null;
  const key = cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : defaultKey(cfg.provider);
  switch (cfg.provider) {
    case "voyage":
      if (!key) return null;
      return httpProvider("voyage", "https://api.voyageai.com/v1/embeddings", cfg.model ?? "voyage-3-lite", key);
    case "openai":
      if (!key) return null;
      return httpProvider("openai", "https://api.openai.com/v1/embeddings", cfg.model ?? "text-embedding-3-small", key);
    case "openai-compatible":
      if (!cfg.baseUrl) return null;
      return httpProvider("compat", `${cfg.baseUrl.replace(/\/$/, "")}/embeddings`, cfg.model ?? "", key ?? "");
    case "ollama":
      return ollamaProvider(cfg.baseUrl ?? "http://127.0.0.1:11434", cfg.model ?? "nomic-embed-text");
    default:
      return null;
  }
}

function defaultKey(provider: string): string | undefined {
  return provider === "voyage" ? process.env.VOYAGE_API_KEY : process.env.OPENAI_API_KEY;
}

function httpProvider(id: string, url: string, model: string, apiKey: string): EmbeddingProvider {
  return {
    id: `${id}:${model}`,
    async embed(texts, opts) {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ model, input: texts }),
        signal: AbortSignal.timeout(opts?.timeoutMs ?? BATCH_EMBED_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`embedding request failed: ${res.status} ${await res.text()}`);
      const json: any = await res.json();
      return (json.data ?? []).map((d: any) => Float32Array.from(d.embedding));
    },
  };
}

function ollamaProvider(baseUrl: string, model: string): EmbeddingProvider {
  return {
    id: `ollama:${model}`,
    async embed(texts, opts) {
      const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, input: texts }),
        signal: AbortSignal.timeout(opts?.timeoutMs ?? BATCH_EMBED_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`ollama embed failed: ${res.status}`);
      const json: any = await res.json();
      return (json.embeddings ?? []).map((e: number[]) => Float32Array.from(e));
    },
  };
}

/** The text an embedding is computed over — kept stable so the cache holds. */
export function embeddingText(cap: Capability): string {
  return [
    cap.kind,
    cap.server ? `from ${cap.server}` : "",
    cap.name,
    cap.title ?? "",
    cap.description,
    cap.keywords.slice(0, 20).join(" "),
  ]
    .filter(Boolean)
    .join(" — ")
    .slice(0, 2000);
}

type VectorCache = { provider: string; entries: Record<string, number[]> };

/** Embedding requests in flight at once while filling the cache. */
const BATCH_CONCURRENCY = 3;
/**
 * Vectors kept for capabilities outside the catalog being embedded. The cache
 * is shared by every directory the router runs in, so another project's
 * servers and skills are not stale just because this catalog lacks them; but
 * nothing ever removed an entry, so every edited description and every server
 * since uninstalled stayed in a file that is parsed whole on each rebuild.
 */
const VECTOR_CACHE_MAX_OTHERS = 1000;

/**
 * Embeds every capability, reusing on-disk vectors for unchanged text. Any
 * failure returns null so callers fall back to pure lexical scoring rather
 * than erroring — the router must work with no API key at all.
 */
export async function embedCatalog(
  provider: EmbeddingProvider,
  capabilities: Capability[],
): Promise<Map<string, Vector> | null> {
  const cachePath = join(cacheDir(), `vectors-${hash(provider.id)}.json`);
  const cached = ((await readJsonSafe(cachePath)) as VectorCache | null) ?? {
    provider: provider.id,
    entries: {},
  };

  const vectors = new Map<string, Vector>();
  const pending: Array<{ cap: Capability; key: string; text: string }> = [];
  /** This catalog's cache keys, in catalog order. */
  const current: string[] = [];
  for (const cap of capabilities) {
    const text = embeddingText(cap);
    const key = `${cap.id}#${hash(text)}`;
    current.push(key);
    const hit = cached.entries[key];
    if (hit) vectors.set(cap.id, Float32Array.from(hit));
    else pending.push({ cap, key, text });
  }

  const ids = new Set(capabilities.map((c) => c.id));
  const currentKeys = new Set(current);
  // An entry for a capability in this catalog under a different text hash is
  // a superseded version of it: its description changed, and nothing can
  // look that vector up again.
  const superseded = Object.keys(cached.entries).some(
    (k) => !currentKeys.has(k) && ids.has(k.slice(0, k.lastIndexOf("#"))),
  );

  if (pending.length) {
    const BATCH = 64;
    const batches: (typeof pending)[] = [];
    for (let i = 0; i < pending.length; i += BATCH) batches.push(pending.slice(i, i + BATCH));
    // A few batches at a time rather than one after another. The first
    // failure stops new batches from starting, as the sequential loop did.
    let failed = false;
    await mapLimit(batches, BATCH_CONCURRENCY, async (batch) => {
      if (failed) return;
      try {
        const embedded = await provider.embed(batch.map((p) => p.text));
        batch.forEach((p, j) => {
          const vec = embedded[j];
          if (!vec) return;
          vectors.set(p.cap.id, vec);
          cached.entries[p.key] = Array.from(vec);
        });
      } catch {
        failed = true;
      }
    });
    // Partial results are still useful, but an empty map is not.
    if (failed && !vectors.size) return null;
  }

  if (pending.length || superseded) {
    try {
      await ensureDir(cacheDir());
      await writeText(cachePath, JSON.stringify({ provider: provider.id, entries: pruned(cached.entries, current, ids) }));
    } catch {}
  }

  return vectors.size ? vectors : null;
}

/**
 * The entries worth writing back: this catalog's, plus the most recently
 * written of everyone else's, minus superseded versions of this catalog's.
 *
 * Object key order is the recency record — this catalog's keys are written
 * last, so the others that have gone longest without being part of a write
 * sit at the front and are the ones dropped. The file format is unchanged.
 */
function pruned(
  entries: Record<string, number[]>,
  current: string[],
  ids: Set<string>,
): Record<string, number[]> {
  const currentKeys = new Set(current);
  const others = Object.keys(entries).filter(
    (k) => !currentKeys.has(k) && !ids.has(k.slice(0, k.lastIndexOf("#"))),
  );
  const out: Record<string, number[]> = {};
  for (const k of others.slice(-VECTOR_CACHE_MAX_OTHERS)) out[k] = entries[k]!;
  for (const k of current) if (entries[k]) out[k] = entries[k]!;
  return out;
}

export function cosine(a: Vector, b: Vector): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

async function readJsonSafe(path: string): Promise<unknown | null> {
  const text = await readText(path);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
