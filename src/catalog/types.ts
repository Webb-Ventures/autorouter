export type CapabilityKind = "tool" | "skill" | "prompt" | "resource" | "command" | "agent";

export type Capability = {
  /** Globally unique, stable: "mcp:supabase/execute_sql", "skill:dataviz". */
  id: string;
  kind: CapabilityKind;
  /** Bare name within its namespace. */
  name: string;
  /** Owning MCP server or plugin, when there is one. */
  server?: string;
  title?: string;
  description: string;
  keywords: string[];
  inputSchema?: unknown;
  /** For skills/commands: file whose body is the instruction payload. */
  bodyPath?: string;
  /**
   * A command's `argument-hint` frontmatter, shown beside its slash command so
   * the user knows what to type after it.
   */
  argumentHint?: string;
  /** URI for resource capabilities. */
  uri?: string;
  /** Rough token cost if this were exposed natively; powers `doctor`. */
  approxTokens: number;
};

export type Catalog = {
  version: number;
  builtAt: number;
  cwd: string;
  /** mtime+size fingerprint of every source file, for invalidation. */
  sources: Record<string, string>;
  capabilities: Capability[];
  /** Servers that failed to enumerate, with the reason. */
  errors: Record<string, string>;
};

export const CATALOG_VERSION = 4;

/** ~4 chars/token is close enough for a budget estimate. */
export function estimateTokens(...parts: Array<string | unknown>): number {
  let chars = 0;
  for (const part of parts) {
    if (part == null) continue;
    chars += typeof part === "string" ? part.length : JSON.stringify(part).length;
  }
  return Math.ceil(chars / 4);
}

/** Matches "server.*", "mcp:server/*", or a bare tool name against an id. */
export function matchesPattern(id: string, pattern: string): boolean {
  const normalized = pattern.includes(":") ? pattern : `*:${pattern.replace(/\./g, "/")}`;
  const rx = new RegExp(
    "^" + normalized.split("*").map(escapeRegex).join(".*") + "$",
    "i",
  );
  return rx.test(id);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
