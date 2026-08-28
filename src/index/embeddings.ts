import { join } from "node:path";
import { createHash } from "node:crypto";
import type { EmbeddingsConfig } from "../config/types.ts";
import type { Capability } from "../catalog/types.ts";
import { cacheDir } from "../util/paths.ts";
import { ensureDir, readText, writeText } from "../util/fs.ts";

export type Vector = Float32Array;

export interface EmbeddingProvider {
  readonly id: string;
  embed(texts: string[]): Promise<Vector[]>;
}

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
    async embed(texts) {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ model, input: texts }),
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
    async embed(texts) {
      const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, input: texts }),
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
  for (const cap of capabilities) {
    const text = embeddingText(cap);
    const key = `${cap.id}#${hash(text)}`;
    const hit = cached.entries[key];
    if (hit) vectors.set(cap.id, Float32Array.from(hit));
    else pending.push({ cap, key, text });
  }

  if (pending.length) {
    try {
      const BATCH = 64;
      for (let i = 0; i < pending.length; i += BATCH) {
        const batch = pending.slice(i, i + BATCH);
        const embedded = await provider.embed(batch.map((p) => p.text));
        batch.forEach((p, j) => {
          const vec = embedded[j];
          if (!vec) return;
          vectors.set(p.cap.id, vec);
          cached.entries[p.key] = Array.from(vec);
        });
      }
    } catch {
      // Partial results are still useful, but an empty map is not.
      if (!vectors.size) return null;
    }
    try {
      await ensureDir(cacheDir());
      await writeText(cachePath, JSON.stringify({ provider: provider.id, entries: cached.entries }));
    } catch {}
  }

  return vectors.size ? vectors : null;
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
