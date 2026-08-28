import type { ServerEntry, ServerSpec } from "../types.ts";
import { absPath } from "../../util/paths.ts";

/** The shape every harness uses for a stdio/http MCP server entry. */
export type RawServer = {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  type?: string;
  transport?: string;
  disabled?: boolean;
  startup_timeout_sec?: number;
  startupTimeoutSec?: number;
};

/**
 * Harness configs are written expecting shell-style expansion — the Datadog
 * plugin ships `https://${DD_MCP_DOMAIN:-mcp.datadoghq.com}/v1/mcp`. Passing
 * that through verbatim yields an unparseable URL, so expand `${VAR}` and
 * `${VAR:-default}` the way the harnesses themselves do. An unset variable with
 * no default is left intact rather than blanked, so the failure is legible.
 */
export function expandEnv(text: string): string {
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (whole, name, fallback) => {
    const value = process.env[name];
    if (value !== undefined && value !== "") return value;
    return fallback ?? whole;
  });
}

function expandMap(m: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!m) return undefined;
  return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, expandEnv(String(v))]));
}

/**
 * Same, but drops keys that expanded to nothing.
 *
 * Harness configs habitually declare credential headers with an empty default —
 * Datadog ships `"DD_API_KEY": "${DD_API_KEY:-}"`. Sending `DD_API_KEY: ""` is
 * not the same as not sending it: a server that branches on the header's
 * presence will take the API-key path with an empty key and reject the request,
 * instead of falling through to the OAuth bearer token we do have. Header
 * absence is the accurate encoding of "no such credential".
 */
function expandHeaders(m: Record<string, string> | undefined): Record<string, string> | undefined {
  const expanded = expandMap(m);
  if (!expanded) return undefined;
  const kept = Object.entries(expanded).filter(([, v]) => v !== "");
  return kept.length ? Object.fromEntries(kept) : undefined;
}

/**
 * Normalizes the several near-identical server shapes (Claude's mcpServers,
 * Cursor's mcpServers, VS Code's servers, Codex's [mcp_servers.*]) into one.
 * Returns null when the entry is too malformed to launch.
 */
export function normalizeServer(
  name: string,
  raw: RawServer,
  origin: string,
): ServerEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const disabled = raw.disabled === true;

  if (raw.url) {
    return {
      name,
      origin,
      disabled,
      transport: "http",
      url: expandEnv(raw.url),
      headers: expandHeaders(raw.headers),
    };
  }

  if (!raw.command) return null;
  return {
    name,
    origin,
    disabled,
    transport: "stdio",
    command: expandEnv(raw.command),
    args: Array.isArray(raw.args) ? raw.args.map((a) => expandEnv(String(a))) : [],
    env: expandMap(raw.env),
    cwd: raw.cwd ? absPath(raw.cwd) : undefined,
    startupTimeoutSec: raw.startup_timeout_sec ?? raw.startupTimeoutSec,
  };
}

/**
 * True when a server entry would launch this router again. Importing the
 * router's own registration from a harness config is the common case and
 * causes infinite recursion, so every adapter's output is filtered by this.
 */
export function isSelfReference(entry: ServerEntry): boolean {
  if (entry.transport !== "stdio") return false;
  // Match the entrypoint the command would actually launch, not any path that
  // happens to contain the project name — a fixture or test file living inside
  // this repo is a legitimate downstream server.
  const candidates = [entry.command, ...entry.args.filter((a) => !a.startsWith("-"))];
  for (const raw of candidates) {
    const base = (raw.split("/").pop() ?? raw).toLowerCase();
    const stem = base.replace(/\.(ts|js|mjs|cjs)$/, "");
    if (stem === "autorouter" || stem === "autorouter-mcp" || stem === "mcp-router") return true;
    // "npx autorouter serve" / "bun run .../autorouter/src/cli.ts"
    if (stem === "cli" || stem === "index") {
      const dirs = raw.toLowerCase().split("/");
      if (dirs.some((d) => d === "autorouter" || d === "autorouter-mcp" || d === "auto-select-plugin")) {
        return true;
      }
    }
  }
  return false;
}

export function specKey(s: ServerSpec): string {
  return s.transport === "http"
    ? `http:${s.url}`
    : `stdio:${s.command} ${s.args.join(" ")}`;
}
