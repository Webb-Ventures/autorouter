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
 * Plugins declare MCP servers in .claude-plugin/plugin.json under `mcpServers`,
 * which is either an inline object or a path to a separate JSON file relative
 * to the plugin root. Both forms appear in the official marketplace.
 */
export async function loadPluginServers(): Promise<ServerEntry[]> {
  const out: ServerEntry[] = [];
  for (const plugin of await listInstalledPlugins()) {
    const manifestPath = join(plugin.root, ".claude-plugin", "plugin.json");
    const manifest = await readJson<{ mcpServers?: string | Record<string, RawServer> }>(manifestPath);
    if (!manifest?.mcpServers) continue;

    let servers: Record<string, RawServer> | null = null;
    if (typeof manifest.mcpServers === "string") {
      const rel = manifest.mcpServers.replace(/^\.\//, "");
      const target = isAbsolute(rel) ? rel : join(plugin.root, rel);
      const loaded = await readJson<{ mcpServers?: Record<string, RawServer> } | Record<string, RawServer>>(target);
      if (!loaded) continue;
      servers = (loaded as any).mcpServers ?? (loaded as Record<string, RawServer>);
    } else {
      servers = manifest.mcpServers;
    }

    for (const [name, raw] of Object.entries(servers ?? {})) {
      const e = normalizeServer(`${plugin.name}:${name}`, raw, "plugins");
      if (!e) continue;
      // Plugin commands frequently reference ${CLAUDE_PLUGIN_ROOT}.
      if (e.transport === "stdio") {
        e.command = substitutePluginRoot(e.command, plugin.root);
        e.args = e.args.map((a) => substitutePluginRoot(a, plugin.root));
        e.cwd ??= plugin.root;
      }
      out.push(e);
    }
  }
  return out;
}

export function substitutePluginRoot(value: string, root: string): string {
  return value
    .replaceAll("${CLAUDE_PLUGIN_ROOT}", root)
    .replaceAll("$CLAUDE_PLUGIN_ROOT", root);
}
