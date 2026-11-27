import { join, dirname, isAbsolute } from "node:path";
import type { ServerEntry } from "../types.ts";
import { normalizeServer, type RawServer } from "./shared.ts";
import { homeDir, readJson } from "../../util/paths.ts";

export type InstalledPlugin = {
  /** "datadog@claude-plugins-official" */
  key: string;
  name: string;
  root: string;
};

type InstalledPluginsFile = {
  plugins?: Record<string, Array<{ installPath?: string }>>;
};

/** Resolves every installed Claude Code plugin to its on-disk root. */
export async function listInstalledPlugins(): Promise<InstalledPlugin[]> {
  const cfg = await readJson<InstalledPluginsFile>(
    join(homeDir(), ".claude", "plugins", "installed_plugins.json"),
  );
  const out: InstalledPlugin[] = [];
  for (const [key, entries] of Object.entries(cfg?.plugins ?? {})) {
    const installPath = entries?.[0]?.installPath;
    if (!installPath) continue;
    out.push({ key, name: key.split("@")[0] ?? key, root: installPath });
  }
  return out;
}

/**
 * A plugin's MCP server specs, keyed by the name the plugin gave them.
 *
 * Three layouts are in use: `mcpServers` inline in .claude-plugin/plugin.json,
 * `mcpServers` there as a path to a JSON file, and no manifest entry at all
 * with a `.mcp.json` at the plugin root. The last was not read, so those
 * plugins looked like they had no servers: the router never routed them, and
 * `adopt` then disabled the plugin as "skills only", which removed them.
 */
export async function readPluginServers(root: string): Promise<Record<string, RawServer>> {
  const manifest = await readJson<{ mcpServers?: string | Record<string, RawServer> }>(
    join(root, ".claude-plugin", "plugin.json"),
  );
  const declared = manifest?.mcpServers;
  if (declared && typeof declared !== "string") return declared;

  const rel = typeof declared === "string" ? declared.replace(/^\.\//, "") : ".mcp.json";
  const loaded = await readJson<Record<string, unknown>>(isAbsolute(rel) ? rel : join(root, rel));
  if (!loaded || typeof loaded !== "object" || Array.isArray(loaded)) return {};
  return ((loaded.mcpServers as Record<string, RawServer> | undefined) ?? loaded) as Record<string, RawServer>;
}

export async function loadPluginServers(): Promise<ServerEntry[]> {
  const out: ServerEntry[] = [];
  for (const plugin of await listInstalledPlugins()) {
    for (const [name, raw] of Object.entries(await readPluginServers(plugin.root))) {
      const e = normalizeServer(`${plugin.name}:${name}`, withPluginRoot(raw, plugin.root), "plugins");
      if (!e) continue;
      if (e.transport === "stdio") e.cwd ??= plugin.root;
      out.push(e);
    }
  }
  return out;
}

/**
 * Resolves ${CLAUDE_PLUGIN_ROOT} throughout a spec, before anything else
 * expands it.
 *
 * Before, because normalizeServer() expands environment variables, and when
 * the router itself runs as a plugin its own CLAUDE_PLUGIN_ROOT is set: every
 * other plugin was then pointed at the router's directory. Throughout, because
 * plugins reference the root in `env` and `cwd` as well as the command line.
 */
function withPluginRoot(raw: RawServer, root: string): RawServer {
  if (!raw || typeof raw !== "object") return raw;
  const sub = (v: unknown) => (typeof v === "string" ? substitutePluginRoot(v, root) : v);
  const subMap = (m: Record<string, string> | undefined) =>
    m && typeof m === "object"
      ? (Object.fromEntries(Object.entries(m).map(([k, v]) => [k, sub(v)])) as Record<string, string>)
      : m;
  return {
    ...raw,
    command: sub(raw.command) as string | undefined,
    args: Array.isArray(raw.args) ? raw.args.map((a) => sub(a) as string) : raw.args,
    env: subMap(raw.env),
    cwd: sub(raw.cwd) as string | undefined,
    url: sub(raw.url) as string | undefined,
    headers: subMap(raw.headers),
  };
}

export function substitutePluginRoot(value: string, root: string): string {
  return value
    .replaceAll("${CLAUDE_PLUGIN_ROOT}", root)
    .replaceAll("$CLAUDE_PLUGIN_ROOT", root);
}
