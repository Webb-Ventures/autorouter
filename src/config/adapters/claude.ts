import { join } from "node:path";
import type { ServerEntry } from "../types.ts";
import { normalizeServer, type RawServer } from "./shared.ts";
import { homeDir, readJson } from "../../util/paths.ts";

type ClaudeConfig = {
  mcpServers?: Record<string, RawServer>;
  projects?: Record<string, { mcpServers?: Record<string, RawServer> }>;
};

/**
 * Claude Code keeps global servers at ~/.claude.json:mcpServers and per-project
 * servers under projects[<cwd>].mcpServers. Project-local .mcp.json is checked
 * into repos and takes precedence over both.
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

  const local = await readJson<ClaudeConfig>(join(cwd, ".mcp.json"));
  for (const [name, raw] of Object.entries(local?.mcpServers ?? {})) push(name, raw);

  return out;
}
