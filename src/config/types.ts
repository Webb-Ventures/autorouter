/** How a downstream MCP server is launched or reached. */
export type ServerSpec =
  | {
      transport: "stdio";
      command: string;
      args: string[];
      env?: Record<string, string>;
      cwd?: string;
      startupTimeoutSec?: number;
    }
  | {
      transport: "http";
      url: string;
      headers?: Record<string, string>;
    };

export type ServerEntry = ServerSpec & {
  /** Stable id used in capability ids, e.g. "supabase". */
  name: string;
  /** Which adapter contributed it: "claude" | "codex" | "cursor" | ... */
  origin: string;
  disabled?: boolean;
};

export type SelectorConfig = {
  /**
   * "auto"    - MCP sampling if the host supports it, else the harness's own
   *             CLI in headless mode, else a directly configured provider,
   *             else no rerank.
   * "sampling"- only ask the host via sampling/createMessage.
   * "cli"     - only shell out to the harness CLI (`claude -p`, `codex exec`).
   * "api"     - only call the configured provider directly.
   * "off"     - never rerank; return raw index results.
   */
  mode?: "auto" | "sampling" | "cli" | "api" | "off";
  provider?: "anthropic" | "openai" | "openai-compatible" | "ollama" | "cli";
  model?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  /**
   * Executable for the "cli" provider. Defaults to whichever harness the router
   * detected — the point is to reuse the login the user already has, so an
   * explicit value is only needed when the binary is not on PATH under its
   * usual name.
   */
  cliCommand?: string;
  /** How many index hits are handed to the selector. */
  candidates?: number;
  /** How many the selector may return. */
  maxResults?: number;
  timeoutMs?: number;
};

export type EmbeddingsConfig = {
  provider?: "voyage" | "openai" | "openai-compatible" | "ollama" | "none";
  model?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
};

export type RouterConfig = {
  /** Harness configs to import servers from. */
  import: string[];
  /** Extra servers declared directly. */
  servers: Record<string, Partial<ServerSpec> & { command?: string; args?: string[]; url?: string; disabled?: boolean; env?: Record<string, string> }>;
  skillPaths: string[];
  /** Capability id globs that are never surfaced. */
  exclude: string[];
  /** Capability id globs that stay first-class in the host (never routed). */
  alwaysExpose: string[];
  /** Capability id globs requiring an explicit confirm:true on call. */
  confirm: string[];
  selector: SelectorConfig;
  embeddings: EmbeddingsConfig;
  /** Fusion weight for the lexical score; embedding weight is 1 - this. */
  lexicalWeight: number;
  /** Seconds before the on-disk catalog is considered stale. */
  cacheTtlSec: number;
};

export const DEFAULT_CONFIG: RouterConfig = {
  import: ["claude", "codex", "cursor", "vscode", "plugins"],
  servers: {},
  skillPaths: ["~/.claude/skills", ".claude/skills", "~/.config/skills"],
  exclude: [],
  alwaysExpose: [],
  confirm: [],
  selector: {
    mode: "auto",
    candidates: 30,
    maxResults: 8,
    timeoutMs: 20000,
  },
  embeddings: { provider: "none" },
  lexicalWeight: 0.5,
  cacheTtlSec: 60 * 60 * 6,
};
