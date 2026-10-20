import { join } from "node:path";
import type { ServerEntry } from "../types.ts";
import { normalizeServer, type RawServer } from "./shared.ts";
import { homeDir, readJson } from "../../util/paths.ts";
import { mcpjsonApproval } from "../../workspace/trust.ts";

type ClaudeConfig = {
  mcpServers?: Record<string, RawServer>;
  projects?: Record<string, { mcpServers?: Record<string, RawServer> }>;
};

/**
 * Claude Code keeps global servers at ~/.claude.json:mcpServers and per-project
 * servers under projects[<cwd>].mcpServers. Project-local .mcp.json is checked
 * into repos, so its servers are only read when Claude Code itself would run
 * them (see workspace/trust.ts) — the router must not launch a cloned repo's
 * commands just because it was started there. Those come back tagged
 * "claude:mcp.json" so adoption can tell them apart from private entries.
 */
export async function loadClaude(cwd: string): Promise<ServerEntry[]> {
  const out: ServerEntry[] = [];
  const push = (name: string, raw: RawServer) => {
    const e = normalizeServer(name, raw, "claude");
    if (e) out.push(e);
  };

  const global = await readJson<ClaudeConfig>(join(homeDir(), ".claude.json"));
  for (const [name, raw] of Object.entries(global?.mcpServers ?? {})) push(name, raw);
  for (const [name, raw] of Object.entries(global?.projects?.[cwd]?.mcpServers ?? {})) push(name, raw);

  out.push(...(await loadMcpjson(cwd)).filter((e) => e.approved).map((e) => e.entry));
  return out;
}

/** Every server in `<cwd>/.mcp.json`, with whether the router may launch it. */
export async function loadMcpjson(
  cwd: string,
): Promise<{ entry: ServerEntry; approved: boolean }[]> {
  const local = await readJson<ClaudeConfig>(join(cwd, ".mcp.json"));
  const entries = Object.entries(local?.mcpServers ?? {})
    .map(([name, raw]) => normalizeServer(name, raw, "claude:mcp.json"))
    .filter((e): e is ServerEntry => Boolean(e));
  if (!entries.length) return [];
  const approval = await mcpjsonApproval(cwd);
  return entries.map((entry) => ({ entry, approved: approval.approved(entry) }));
}
