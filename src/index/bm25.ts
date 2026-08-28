import { tokenize } from "./tokenize.ts";
import type { Capability } from "../catalog/types.ts";

const K1 = 1.2;
const B = 0.75;

/** Field boosts: a name match is far stronger evidence than a description match. */
const FIELD_WEIGHTS = { name: 3, keywords: 2, description: 1, schema: 0.5 } as const;

type Doc = { id: string; termFreq: Map<string, number>; length: number };

export class Bm25Index {
  private docs: Doc[] = [];
  private df = new Map<string, number>();
  private avgLen = 0;

  constructor(capabilities: Capability[]) {
    for (const cap of capabilities) this.docs.push(buildDoc(cap));
    for (const doc of this.docs) {
      for (const term of doc.termFreq.keys()) {
        this.df.set(term, (this.df.get(term) ?? 0) + 1);
      }
    }
    const total = this.docs.reduce((sum, d) => sum + d.length, 0);
    this.avgLen = this.docs.length ? total / this.docs.length : 1;
  }

  /** Raw BM25 scores keyed by capability id; only non-zero entries. */
  score(query: string): Map<string, number> {
    const terms = tokenize(query);
    const scores = new Map<string, number>();
    const n = this.docs.length;
    if (!n || !terms.length) return scores;

    for (const doc of this.docs) {
      let score = 0;
      for (const term of terms) {
        const tf = doc.termFreq.get(term);
        if (!tf) continue;
        const df = this.df.get(term) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        const norm = tf * (K1 + 1);
        const denom = tf + K1 * (1 - B + (B * doc.length) / this.avgLen);
        score += idf * (norm / denom);
      }
      if (score > 0) scores.set(doc.id, score);
    }
    return scores;
  }
}

function buildDoc(cap: Capability): Doc {
  const termFreq = new Map<string, number>();
  let length = 0;
  const add = (text: string, weight: number) => {
    for (const term of tokenize(text)) {
      termFreq.set(term, (termFreq.get(term) ?? 0) + weight);
      length += weight;
    }
  };
  add(`${cap.name} ${cap.title ?? ""} ${cap.server ?? ""}`, FIELD_WEIGHTS.name);
  add(cap.keywords.join(" "), FIELD_WEIGHTS.keywords);
  add(cap.description, FIELD_WEIGHTS.description);
  add(schemaText(cap.inputSchema), FIELD_WEIGHTS.schema);
  return { id: cap.id, termFreq, length };
}

function schemaText(schema: any): string {
  const props = schema?.properties;
  if (!props || typeof props !== "object") return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries<any>(props)) {
    parts.push(key);
    if (typeof value?.description === "string") parts.push(value.description.slice(0, 120));
  }
  return parts.join(" ");
}
