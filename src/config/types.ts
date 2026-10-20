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

export type RawServerConfig = Partial<ServerSpec> & {
  command?: string;
  args?: string[];
  url?: string;
  disabled?: boolean;
  enabled?: boolean;
  env?: Record<string, string>;
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
  servers: Record<string, RawServerConfig>;
  /**
   * Servers that belong to one project, keyed by its absolute path.
   *
   * Adoption moves a project's private servers (Claude Code's
   * projects[<path>].mcpServers) here rather than into `servers`, so a server
   * registered for one repo is not suddenly reachable from every other.
   */
  projects?: Record<string, { servers?: Record<string, RawServerConfig> }>;
  skillPaths: string[];
  /** Capability id globs that are never surfaced. */
  exclude: string[];
  /** Capability id globs that stay first-class in the host (never routed). */
  alwaysExpose: string[];
  /** Capability id globs requiring an explicit confirm:true on call. */
  confirm: string[];
  /**
   * Which instruction capabilities are republished as slash commands.
   *
   * "all"      - every skill, command and agent.
   * "commands" - plugin commands and agents only.
   * "none"     - just the search entry point.
   *
   * The prompt list is permanent context: the host fetches it once and carries
   * it for the session. Publishing every skill is what makes that expensive —
   * a single plugin shipping 141 skills costs ~11.5k tokens on every turn, for
   * slash commands the harness mostly still offers natively. Skills stay
   * searchable at any setting; only the /mcp__autorouter__<name> alias goes.
   */
  promptMode: "all" | "commands" | "none";
  /**
   * When a matched tool is promoted into the host's own tool list.
   *
   * "eager" - on every search hit, up to the budget.
   * "lazy"  - only after the tool has actually been called once.
   * "off"   - never; everything runs through call_capability.
   *
   * A promoted tool is permanent context for the rest of the session, so
   * promoting on search spends it on tools the model merely looked at. Lazy
   * spends it only on proven use, and the search result carries an inline
   * schema either way.
   */
  activation: "eager" | "lazy" | "off";
  /**
   * Move servers out of a harness config and behind the router automatically.
   *
   * Without this, installing a server is two steps — `claude mcp add foo` then
   * `autorouter adopt` — and forgetting the second leaves every one of that
   * server's schemas in your context, which is the cost the router exists to
   * remove. With it, the harness stays a working front door. Servers only:
   * skills and plugins are never touched unprompted.
   */
  autoAdopt: boolean;
  /**
   * Pick up the skills and `.mcp.json` servers of whichever repo the session is
   * in, and hide them from Claude Code through that repo's private
   * `.claude/settings.local.json`. Never edits a committed file, and only takes
   * `.mcp.json` servers Claude Code would itself run (see workspace/trust.ts).
   */
  autoAdoptProject: boolean;
  /** Expose the add_server tool, letting the model register a server mid-session. */
  allowAddServer: boolean;
  selector: SelectorConfig;
  embeddings: EmbeddingsConfig;
  /** Fusion weight for the lexical score; embedding weight is 1 - this. */
  lexicalWeight: number;
  /** Seconds before the on-disk catalog is considered stale. */
  cacheTtlSec: number;
  /**
   * Tool and resource results over this many tokens are not inlined.
   *
   * An inlined result is context for the rest of the session — re-read on
   * every later turn until compaction. Past this size the router saves it and
   * returns a short card (path, shape, sample rows) the model queries instead.
   */
  spillOverTokens: number;
  /** Per-capability thresholds keyed by id glob, e.g. {"mcp:linear/*": 8000}. 0 never spills. */
  spillOverrides: Record<string, number>;
  /** Where saved results go. Empty means <cache>/results. Never inside the working tree. */
  resultsDir: string;
  /**
   * How an oversized result is handed back.
   *
   * "file" - saved to resultsDir; the model greps/reads the file.
   * "page" - held in memory; fetched with call_capability({ id: "result:<handle>" }).
   * "auto" - file when the client is known to have file tools, else page.
   * "off"  - always inline, whatever the size.
   */
  resultsMode: "auto" | "file" | "page" | "off";
};

export const DEFAULT_CONFIG: RouterConfig = {
  import: ["claude", "codex", "cursor", "vscode", "plugins", "cmux"],
  servers: {},
  skillPaths: ["~/.claude/skills", ".claude/skills", "~/.config/skills"],
  exclude: [],
  alwaysExpose: [],
  confirm: [],
  promptMode: "commands",
  activation: "lazy",
  autoAdopt: true,
  autoAdoptProject: true,
  allowAddServer: false,
  selector: {
    mode: "auto",
    candidates: 30,
    maxResults: 8,
    timeoutMs: 20000,
  },
  embeddings: { provider: "none" },
  lexicalWeight: 0.5,
  cacheTtlSec: 60 * 60 * 6,
  spillOverTokens: 3000,
  spillOverrides: {},
  resultsDir: "",
  resultsMode: "auto",
};
