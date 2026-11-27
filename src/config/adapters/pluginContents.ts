import { join, isAbsolute, basename, extname } from "node:path";
import { stat, readdir } from "node:fs/promises";
import { claudeInstall, readJson, type ClaudeInstall } from "../../util/paths.ts";
import type { InstalledPlugin } from "./plugins.ts";

/**
 * Everything an installed plugin contributes to Claude Code, read the way
 * Claude Code reads it — not just what the router can import.
 *
 * Claude Code assembles a plugin from three places:
 *
 *   1. the default layout under the plugin root (`.mcp.json`, `.lsp.json`,
 *      `hooks/hooks.json`, `agents/`, `commands/`, ...),
 *   2. `.claude-plugin/plugin.json`, whose keys merge with or replace those
 *      defaults, and
 *   3. the plugin's entry in its marketplace's `marketplace.json`, which *is*
 *      the manifest when the plugin ships no plugin.json (the official LSP
 *      plugins are exactly that: a README, a LICENSE, and an entry declaring
 *      `lspServers`), and otherwise adds components to it.
 *
 * The router stands in for MCP servers and indexed skills. Anything else a
 * plugin contributes — LSP servers, hooks, agents, commands, output styles —
 * disappears outright when the plugin is disabled, so `adopt` has to see all
 * of it before deciding a plugin is safe to turn off.
 *
 * See https://code.claude.com/docs/en/plugins-reference.
 */
export type PluginContents = {
  /** MCP server names from `.mcp.json`, the manifest and the marketplace entry. */
  servers: string[];
  /** Contributions the router cannot stand in for, one per kind. */
  unroutable: { kind: string; names: string[] }[];
};

type Manifest = Record<string, unknown>;

export async function readPluginContents(
  plugin: InstalledPlugin,
  install: ClaudeInstall = claudeInstall(),
): Promise<PluginContents> {
  const root = plugin.root;
  const manifest = (await readJson<Manifest>(join(root, ".claude-plugin", "plugin.json"))) ?? {};
  const entry = (await marketplaceEntry(plugin, install)) ?? {};
  const declared = (key: string): unknown[] => [...shapes(field(manifest, key)), ...shapes(field(entry, key))];

  const unroutable: PluginContents["unroutable"] = [];
  const add = (kind: string, names: string[]) => {
    const unique = [...new Set(names)];
    if (unique.length) unroutable.push({ kind, names: unique });
  };

  // Merging components: the default file loads, then every declared shape.
  const servers = await mergedNames(root, ".mcp.json", declared("mcpServers"), "mcpServers");
  const bundles = declared("mcpServers").filter(
    (s): s is string => typeof s === "string" && /\.(mcpb|dxt)$/i.test(s),
  );
  // A bundle's server names live inside the archive. The router never imports
  // bundles, so whatever they hold is unroutable by construction.
  add("MCP bundles", bundles.map((b) => basename(b)));
  add("LSP servers", await mergedNames(root, ".lsp.json", declared("lspServers"), "lspServers"));
  add("hooks", await mergedNames(root, join("hooks", "hooks.json"), declared("hooks"), "hooks"));

  // Replacing components: a manifest key replaces the default directory.
  // An entry key is counted on top of the default, which can only err toward
  // keeping a plugin enabled.
  const replacing = async (key: string, dflt: string, ext: string) => {
    const fromManifest = shapes(field(manifest, key));
    const names: string[] = [];
    if (!fromManifest.length) names.push(...(await filesNamed(root, dflt, ext)));
    for (const shape of [...fromManifest, ...shapes(field(entry, key))]) {
      if (typeof shape === "string") names.push(...(await filesNamed(root, shape, ext)));
      else names.push(...Object.keys(shape)); // commands' object map
    }
    return names;
  };
  add("commands", await replacing("commands", "commands", ".md"));
  add("agents", await replacing("agents", "agents", ".md"));
  add("output styles", await replacing("outputStyles", "output-styles", ".md"));
  add("workflows", await replacing("workflows", "workflows", ".js"));
  add("themes", await replacing("experimental.themes", "themes", ".json"));
  add("monitors", await monitorNames(root, manifest, entry));
  add("executables", await filesNamed(root, "bin", ""));

  // The router indexes <root>/skills only. Skills the plugin loads from
  // anywhere else would vanish with it.
  const extraSkills = declared("skills")
    .filter((s): s is string => typeof s === "string")
    .map(rel)
    .filter((p): p is string => p !== null && p !== "skills" && !p.startsWith("skills/"));
  if (!(await isDir(join(root, "skills"))) && !declared("skills").length && (await isFile(join(root, "SKILL.md")))) {
    extraSkills.push("SKILL.md");
  }
  add("skills outside skills/", extraSkills);

  return { servers, unroutable };
}

/** Human-readable summary, e.g. "LSP servers rust-analyzer; hooks PreToolUse". */
export function describeUnroutable(unroutable: PluginContents["unroutable"]): string {
  return unroutable
    .map(({ kind, names }) => {
      const shown = names.slice(0, 4).join(", ");
      return `${kind} ${shown}${names.length > 4 ? `, +${names.length - 4} more` : ""}`;
    })
    .join("; ");
}

/**
 * The plugin's entry in the marketplace it was installed from. The key is
 * "<plugin>@<marketplace>"; known_marketplaces.json records where each
 * marketplace is checked out, with the conventional directory as fallback.
 */
async function marketplaceEntry(plugin: InstalledPlugin, install: ClaudeInstall): Promise<Manifest | null> {
  const at = plugin.key.indexOf("@");
  if (at < 0) return null;
  const marketplace = plugin.key.slice(at + 1);
  const pluginsDir = join(install.dir, "plugins");
  const known = await readJson<Record<string, { installLocation?: string }>>(
    join(pluginsDir, "known_marketplaces.json"),
  );
  const location = known?.[marketplace]?.installLocation ?? join(pluginsDir, "marketplaces", marketplace);
  const file = await readJson<{ plugins?: unknown[] }>(join(location, ".claude-plugin", "marketplace.json"));
  const found = file?.plugins?.find(
    (p): p is Manifest => !!p && typeof p === "object" && (p as Manifest).name === plugin.name,
  );
  return found ?? null;
}

/** Reads "experimental.themes" as well as the older top-level "themes". */
function field(obj: Manifest, key: string): unknown {
  if (!key.startsWith("experimental.")) return obj[key];
  const bare = key.slice("experimental.".length);
  const exp = obj.experimental as Manifest | undefined;
  return exp?.[bare] ?? obj[bare];
}

/** A component value is a path, an inline object, or an array of either. */
function shapes(value: unknown): Array<string | Record<string, unknown>> {
  const list = Array.isArray(value) ? value : value == null ? [] : [value];
  return list.filter(
    (v): v is string | Record<string, unknown> =>
      typeof v === "string" || (!!v && typeof v === "object" && !Array.isArray(v)),
  );
}

/**
 * Names in a merging component (MCP servers, LSP servers, hook events): the
 * default file first, then each declared path or inline map. Files may wrap
 * their map in a key named after the component (`{ "hooks": {...} }`).
 */
async function mergedNames(root: string, dflt: string, declared: unknown[], wrapper: string): Promise<string[]> {
  const names: string[] = [];
  const fromMap = (map: unknown) => {
    if (!map || typeof map !== "object" || Array.isArray(map)) return;
    const inner = (map as Record<string, unknown>)[wrapper];
    const target = inner && typeof inner === "object" && !Array.isArray(inner) ? inner : map;
    names.push(...Object.keys(target as object));
  };
  fromMap(await readJson(join(root, dflt)));
  for (const shape of declared) {
    if (typeof shape !== "string") {
      fromMap(shape);
      continue;
    }
    const p = rel(shape);
    if (p && p.endsWith(".json")) fromMap(await readJson(join(root, p)));
  }
  return [...new Set(names)];
}

async function monitorNames(root: string, manifest: Manifest, entry: Manifest): Promise<string[]> {
  const declared = [field(manifest, "experimental.monitors"), field(entry, "experimental.monitors")].filter(
    (v) => v != null,
  );
  const lists: unknown[] = [];
  if (!declared.length) lists.push(await readJson(join(root, "monitors", "monitors.json")));
  for (const v of declared) {
    if (typeof v === "string") {
      const p = rel(v);
      if (p) lists.push(await readJson(join(root, p)));
    } else lists.push(v);
  }
  return lists.flatMap((l) =>
    Array.isArray(l) ? l.map((m) => (m && typeof m === "object" ? String((m as Manifest).name ?? "monitor") : "monitor")) : [],
  );
}

/**
 * Files a path names: the file itself, or every file with `ext` below a
 * directory. Names drop the extension, as Claude Code's own listings do.
 */
async function filesNamed(root: string, path: string, ext: string): Promise<string[]> {
  const p = rel(path);
  if (p === null) return [];
  const abs = join(root, p);
  if (await isFile(abs)) return [basename(abs, extname(abs))];
  if (!(await isDir(abs))) return [];
  const out: string[] = [];
  // A hand-rolled walk: readdir's `recursive` and Dirent.parentPath postdate
  // the Node 18 this package still supports.
  const walk = async (dir: string, prefix: string) => {
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const relName = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(join(dir, e.name), relName);
      else if (e.isFile() && (!ext || e.name.endsWith(ext))) out.push(ext ? relName.slice(0, -ext.length) : relName);
    }
  };
  await walk(abs, "");
  return out.sort();
}

/** "./x/y" → "x/y"; paths Claude Code refuses to load (absolute, "..") → null. */
function rel(path: string): string | null {
  if (isAbsolute(path) || path.split(/[\\/]/).includes("..")) return null;
  return path.replace(/^\.\//, "").replace(/\/+$/, "") || ".";
}

async function isFile(p: string): Promise<boolean> {
  return stat(p).then((s) => s.isFile(), () => false);
}

async function isDir(p: string): Promise<boolean> {
  return stat(p).then((s) => s.isDirectory(), () => false);
}
