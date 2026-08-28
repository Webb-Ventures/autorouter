import { join } from "node:path";
import { exists, readText, writeText } from "../util/fs.ts";
import { homeDir, stripJsonComments } from "../util/paths.ts";
import { listInstalledPlugins } from "../config/adapters/plugins.ts";
import { collectSkills } from "../catalog/providers/skills.ts";

/**
 * Moving MCP servers behind the router only recovers part of the context.
 * Skills and plugins load through entirely separate mechanisms — a skill's
 * name and description are injected from ~/.claude/skills/<n>/SKILL.md, and a
 * plugin contributes its own skills, commands and MCP servers just by being
 * enabled — so `adopt` leaving them alone means they stay in every prompt even
 * after every server has moved.
 *
 * Claude Code exposes exactly two levers for this, both in settings.json:
 *
 *   skillOverrides[name] = "off" | "user-invocable-only" | "name-only" | "on"
 *   enabledPlugins["plugin@marketplace"] = false
 *
 * "user-invocable-only" is the one that matters: the skill disappears from the
 * model's context but `/name` still works for the user. That is precisely the
 * router's bargain — the capability stays available, it just stops being
 * pre-loaded — so it is the default. "off" would take the slash command away
 * too, which is a loss the user did not ask for.
 *
 * No other harness has an equivalent. Codex, Cursor and VS Code have no skill
 * or plugin concept to disable, so this is deliberately Claude-Code-only rather
 * than a lowest-common-denominator abstraction.
 */
export type SkillMode = "user-invocable-only" | "off";

export type ExtrasPlan = {
  file: string;
  /** Skill names that will be hidden from the model, with the mode used. */
  skills: { name: string; mode: SkillMode; from: string | null }[];
  /** Plugin ids ("datadog@claude-plugins-official") that will be disabled. */
  plugins: { id: string; name: string; reason: string }[];
  /** Skills already hidden, or plugins already disabled — reported, not re-applied. */
  skipped: string[];
};

type Settings = {
  skillOverrides?: Record<string, string>;
  enabledPlugins?: Record<string, unknown>;
};

export function settingsPath(): string {
  return join(homeDir(), ".claude", "settings.json");
}

/**
 * A plugin is only safe to disable once the router can reach everything it
 * contributed. That means its MCP servers must already be adopted; otherwise
 * disabling the plugin deletes capabilities outright instead of routing them.
 */
export async function planExtras(opts: {
  cwd: string;
  skillPaths: string[];
  keepSkills: string[];
  keepPlugins: string[];
  mode: SkillMode;
  /** Server names now present in the router's own config. */
  routedServers: Set<string>;
  /** Servers the router could not connect to; their plugins must stay enabled. */
  unreachable?: Set<string>;
}): Promise<ExtrasPlan> {
  const file = settingsPath();
  const settings = (await readSettings(file)) ?? {};
  const plan: ExtrasPlan = { file, skills: [], plugins: [], skipped: [] };

  const keepSkills = new Set(opts.keepSkills);
  const keepPlugins = new Set(opts.keepPlugins);

  const plugins = await listInstalledPlugins();
  const pluginByName = new Map(plugins.map((p) => [p.name, p]));

  // Disable whole plugins first: a disabled plugin takes its own skills with
  // it, so listing those skills separately would be noise.
  const disabledPluginNames = new Set<string>();
  /** Plugins to leave entirely alone — their skills stay loaded too. */
  const untouched = new Set<string>();
  for (const plugin of plugins) {
    if (keepPlugins.has(plugin.name) || keepPlugins.has(plugin.key)) {
      // --keep-plugin means "leave this alone", not "keep it but strip its
      // skills" — half-disabling it is the surprising reading.
      untouched.add(plugin.name);
      continue;
    }
    if (settings.enabledPlugins?.[plugin.key] === false) {
      plan.skipped.push(`plugin ${plugin.name} (already disabled)`);
      disabledPluginNames.add(plugin.name);
      continue;
    }
    const servers = await pluginServerNames(plugin.root);
    // An unreachable server is one the router cannot stand in for. Disabling
    // its plugin would take away a server that currently works — the same
    // hazard the server-move path already refuses, applied one level up.
    // Report the name the router knows the server by, not the plugin's local
    // name for it: a plugin server is namespaced "<plugin>:<server>", so a bare
    // `autorouter login mcp` would not resolve to anything.
    const broken = servers
      .map((s) =>
        opts.unreachable?.has(`${plugin.name}:${s}`)
          ? `${plugin.name}:${s}`
          : opts.unreachable?.has(s)
            ? s
            : null,
      )
      .filter((s): s is string => s !== null);
    if (broken.length) {
      plan.skipped.push(
        `plugin ${plugin.name} (the router cannot reach ${broken.join(", ")} — run: ${broken.map((s) => `autorouter login ${s}`).join("; ")})`,
      );
      untouched.add(plugin.name);
      continue;
    }
    const unrouted = servers.filter((s) => !opts.routedServers.has(s) && !opts.routedServers.has(`${plugin.name}:${s}`));
    if (unrouted.length) {
      // Disabling now would remove the server from the harness without the
      // router having a way to reach it — a strict capability loss.
      plan.skipped.push(
        `plugin ${plugin.name} (${unrouted.length > 1 ? `its servers ${unrouted.join(", ")} are` : `its server ${unrouted[0]} is`} not routed yet — adopt ${unrouted.length > 1 ? "them" : "it"} first)`,
      );
      continue;
    }
    plan.plugins.push({
      id: plugin.key,
      name: plugin.name,
      reason: servers.length ? `${servers.length} server(s) already routed` : "skills only",
    });
    disabledPluginNames.add(plugin.name);
  }

  // Skills the router can see. Plugin skills are covered by the plugin toggle,
  // and skillOverrides is keyed by bare name anyway, so only user skills here.
  const { capabilities } = await collectSkills(opts.skillPaths, opts.cwd, { includePlugins: true });
  for (const cap of capabilities) {
    if (cap.server && (disabledPluginNames.has(cap.server) || untouched.has(cap.server))) continue;
    if (keepSkills.has(cap.name)) continue;
    const current = settings.skillOverrides?.[cap.name];
    if (current === "off" || current === "user-invocable-only") {
      plan.skipped.push(`skill ${cap.name} (already ${current})`);
      continue;
    }
    plan.skills.push({ name: cap.name, mode: opts.mode, from: cap.server ?? null });
  }

  return plan;
}

export async function applyExtras(plan: ExtrasPlan): Promise<void> {
  const settings = (await readSettings(plan.file)) ?? {};
  settings.skillOverrides = { ...settings.skillOverrides };
  settings.enabledPlugins = { ...settings.enabledPlugins };
  for (const s of plan.skills) settings.skillOverrides[s.name] = s.mode;
  for (const p of plan.plugins) settings.enabledPlugins[p.id] = false;
  await writeText(plan.file, `${JSON.stringify(settings, null, 2)}\n`);
}

/** Everything applyExtras would change, captured verbatim for `restore`. */
export async function snapshotExtras(file: string): Promise<Record<string, string>> {
  const text = await readText(file);
  return text === null ? {} : { [file]: text };
}

async function readSettings(file: string): Promise<Settings | null> {
  if (!(await exists(file))) return null;
  const text = await readText(file);
  if (!text?.trim()) return null;
  try {
    return JSON.parse(stripJsonComments(text)) as Settings;
  } catch {
    return null;
  }
}

/** Every installed plugin with the MCP servers it contributes. */
export async function pluginsWithServers(): Promise<
  { key: string; name: string; servers: string[] }[]
> {
  const out: { key: string; name: string; servers: string[] }[] = [];
  for (const plugin of await listInstalledPlugins()) {
    out.push({ key: plugin.key, name: plugin.name, servers: await pluginServerNames(plugin.root) });
  }
  return out;
}

/** Server names a plugin contributes, read the same way loadPluginServers does. */
async function pluginServerNames(root: string): Promise<string[]> {
  const manifestText = await readText(join(root, ".claude-plugin", "plugin.json"));
  if (!manifestText) return [];
  let manifest: { mcpServers?: string | Record<string, unknown> };
  try {
    manifest = JSON.parse(stripJsonComments(manifestText));
  } catch {
    return [];
  }
  if (!manifest.mcpServers) return [];
  if (typeof manifest.mcpServers !== "string") return Object.keys(manifest.mcpServers);

  const rel = manifest.mcpServers.replace(/^\.\//, "");
  const text = await readText(join(root, rel));
  if (!text) return [];
  try {
    const loaded = JSON.parse(stripJsonComments(text));
    return Object.keys(loaded.mcpServers ?? loaded ?? {});
  } catch {
    return [];
  }
}
