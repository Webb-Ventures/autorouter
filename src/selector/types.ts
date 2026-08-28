import type { Scored } from "../index/search.ts";

export type Selection = {
  id: string;
  reason: string;
  /** Selector's own 0-1 confidence, when it gives one. */
  confidence?: number;
};

export type SelectorResult = {
  selections: Selection[];
  /** Which backend actually ran: "sampling", "anthropic", "ollama", "none", ... */
  backend: string;
  model?: string;
  /** Present when the selector was skipped or failed; results are index-only. */
  note?: string;
};

export interface SelectorBackend {
  readonly id: string;
  readonly model?: string;
  /**
   * Floor on the timeout this backend needs, overriding a lower configured one.
   *
   * The default timeout is sized for an HTTP request. A backend that starts a
   * whole agent CLI spends most of its budget before the model sees a token, so
   * without a floor the configured default kills every call just short of the
   * answer — which looks exactly like "no selector available" and is far more
   * confusing.
   */
  readonly minTimeoutMs?: number;
  /** Returns raw model text. Throws on failure; callers degrade gracefully. */
  complete(system: string, user: string, timeoutMs: number): Promise<string>;
}

export type SelectorInput = {
  query: string;
  candidates: Scored[];
  maxResults: number;
};
