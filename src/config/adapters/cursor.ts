import { join } from "node:path";
import type { ServerEntry } from "../types.ts";
import { normalizeServer, type RawServer } from "./shared.ts";
import { homeDir, readJson } from "../../util/paths.ts";

export async function loadCursor(cwd: string): Promise<ServerEntry[]> {
  const out: ServerEntry[] = [];
  for (const path of [join(homeDir(), ".cursor", "mcp.json"), join(cwd, ".cursor", "mcp.json")]) {
    const cfg = await readJson<{ mcpServers?: Record<string, RawServer> }>(path);
    for (const [name, raw] of Object.entries(cfg?.mcpServers ?? {})) {
      const e = normalizeServer(name, raw, "cursor");
      if (e) out.push(e);
    }
  }
  return out;
}

/** VS Code / Copilot use `servers` rather than `mcpServers`, same value shape. */
export async function loadVscode(cwd: string): Promise<ServerEntry[]> {
  const out: ServerEntry[] = [];
  for (const path of [join(homeDir(), ".vscode", "mcp.json"), join(cwd, ".vscode", "mcp.json")]) {
    const cfg = await readJson<{ servers?: Record<string, RawServer>; mcpServers?: Record<string, RawServer> }>(path);
    const merged = { ...(cfg?.servers ?? {}), ...(cfg?.mcpServers ?? {}) };
    for (const [name, raw] of Object.entries(merged)) {
      const e = normalizeServer(name, raw, "vscode");
      if (e) out.push(e);
    }
  }
  return out;
}
