import type { Capability, CapabilityKind } from "../catalog/types.ts";
import type { RouterConfig } from "../config/types.ts";
import { Bm25Index } from "./bm25.ts";
import { createProvider, embedCatalog, cosine, type Vector } from "./embeddings.ts";

export type Scored = { capability: Capability; score: number; lexical: number; semantic: number };

export type SearchOptions = {
  kind?: CapabilityKind | CapabilityKind[];
  server?: string;
  limit?: number;
};

/**
 * Stage one of the router: cheap, local, always available. Narrows the full
 * catalog to a candidate set small enough to hand to the selector model.
 */
export class HybridIndex {
  private bm25: Bm25Index;
  private byId = new Map<string, Capability>();
  private vectors: Map<string, Vector> | null = null;
  private embedQuery: ((q: string) => Promise<Vector | null>) | null = null;

  constructor(
    private capabilities: Capability[],
    private config: RouterConfig,
  ) {
    this.bm25 = new Bm25Index(capabilities);
    for (const cap of capabilities) this.byId.set(cap.id, cap);
  }

  get size(): number {
    return this.capabilities.length;
  }

  get semanticEnabled(): boolean {
    return this.vectors !== null;
  }

  /** Optional; safe to skip entirely. Never throws. */
  async warmEmbeddings(): Promise<void> {
    const provider = createProvider(this.config.embeddings);
    if (!provider) return;
    try {
      this.vectors = await embedCatalog(provider, this.capabilities);
      if (this.vectors) {
        this.embedQuery = async (q) => {
          try {
            return (await provider.embed([q]))[0] ?? null;
          } catch {
            return null;
          }
        };
      }
    } catch {
      this.vectors = null;
    }
  }

  async search(query: string, opts: SearchOptions = {}): Promise<Scored[]> {
    const limit = opts.limit ?? 30;
    const kinds = opts.kind
      ? new Set(Array.isArray(opts.kind) ? opts.kind : [opts.kind])
      : null;

    const lexical = this.bm25.score(query);
    let semantic = new Map<string, number>();
    if (this.vectors && this.embedQuery) {
      const qv = await this.embedQuery(query);
      if (qv) {
        for (const [id, vec] of this.vectors) semantic.set(id, cosine(qv, vec));
      }
    }

    const normLex = normalize(lexical);
    const normSem = normalize(semantic);
    const w = semantic.size ? this.config.lexicalWeight : 1;

    const scored: Scored[] = [];
    for (const cap of this.capabilities) {
      if (kinds && !kinds.has(cap.kind)) continue;
      if (opts.server && cap.server !== opts.server) continue;
      const lex = normLex.get(cap.id) ?? 0;
      const sem = normSem.get(cap.id) ?? 0;
      const score = w * lex + (1 - w) * sem;
      if (score <= 0) continue;
      scored.push({ capability: cap, score, lexical: lex, semantic: sem });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  get(id: string): Capability | undefined {
    return this.byId.get(id);
  }

  all(): Capability[] {
    return this.capabilities;
  }
}

/** Min-max to [0,1] so lexical and cosine scores are comparable before fusing. */
function normalize(scores: Map<string, number>): Map<string, number> {
  if (scores.size === 0) return scores;
  let min = Infinity;
  let max = -Infinity;
  for (const v of scores.values()) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min;
  const out = new Map<string, number>();
  for (const [k, v] of scores) out.set(k, range === 0 ? 1 : (v - min) / range);
  return out;
}
