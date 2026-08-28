import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { ServerEntry } from "../types.ts";
import { normalizeServer, type RawServer } from "./shared.ts";
import { readText } from "../../util/fs.ts";
import { homeDir } from "../../util/paths.ts";

/**
 * Codex stores servers as [mcp_servers.<id>] blocks in config.toml, with
 * `env` as a nested table and `startup_timeout_sec` in snake_case.
 * Project-local .codex/config.toml is only honoured for trusted projects;
 * we read it regardless and let the exclude list handle anything unwanted.
 */
export async function loadCodex(cwd: string): Promise<ServerEntry[]> {
  const out: ServerEntry[] = [];
  for (const path of [join(homeDir(), ".codex", "config.toml"), join(cwd, ".codex", "config.toml")]) {
    const text = await readText(path);
    if (!text) continue;
    let parsed: any;
    try {
      parsed = parseToml(text);
    } catch {
      continue;
    }
    const servers = parsed?.mcp_servers ?? parsed?.mcpServers;
    if (!servers || typeof servers !== "object") continue;
    for (const [name, raw] of Object.entries(servers as Record<string, RawServer>)) {
      const e = normalizeServer(name, raw, "codex");
      if (e) out.push(e);
    }
  }
  return out;
}

/** Reads Codex's configured model so the selector can reuse the same tier. */
export async function readCodexModel(): Promise<string | null> {
  const text = await readText(join(homeDir(), ".codex", "config.toml"));
  if (!text) return null;
  try {
    const parsed: any = parseToml(text);
    return typeof parsed?.model === "string" ? parsed.model : null;
  } catch {
    return null;
  }
}
