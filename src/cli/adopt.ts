import { join } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { ensureDir, exists, readText, writeText } from "../util/fs.ts";
import { homeDir, stripJsonComments } from "../util/paths.ts";
import { resolveConfig } from "../config/resolve.ts";
import type { Harness } from "./init.ts";
import {
  applyExtras,
  planExtras,
  settingsPath,
  type ExtrasPlan,
  type SkillMode,
} from "./adoptExtras.ts";

/**
 * Registering the router next to the servers it routes to is the worst of both
 * worlds: every downstream tool schema is still injected into the system prompt
 * *and* the router adds four more. Adoption is what makes the saving real — the
 * downstream entries move out of the harness config and into the router's own,
 * so the harness loads one server and the router still reaches all of them.
 *
 * Every removal is backed up verbatim first; `restore` puts them back.
 */
export type AdoptPlan = {
  harness: Harness;
  file: string;
  section: string;
  moved: string[];
  kept: string[];
};

export type AdoptResult = {
  plans: AdoptPlan[];
  /** Skills/plugins to hide. Only Claude Code has anything to hide. */
  extras: ExtrasPlan | null;
  backup: string | null;
  notes: string[];
};

type JsonSite = { file: string; section: string; path: string[] };

export async function runAdopt(opts: {
  harness: Harness;
  cwd: string;
  keep: string[];
  dryRun: boolean;
  /** Also hide skills and disable plugins (Claude Code only). */
  extras?: boolean;
  /** Servers the router could not connect to; their plugins stay enabled. */
  unreachable?: Set<string>;
  skillMode?: SkillMode;
  keepSkills?: string[];
  keepPlugins?: string[];
}): Promise<AdoptResult> {
  const resolved = await resolveConfig(opts.cwd);
  // alwaysExpose capabilities must stay first-class, so their servers stay put.
  const keep = new Set([
    "autorouter",
    ...opts.keep,
    ...serversBehind(resolved.config.alwaysExpose),
  ]);

  const plans: AdoptPlan[] = [];
  const adopted: Record<string, any> = {};
  /** Original file text, captured before anything is mutated. */
  const backup: Record<string, string> = {};
  /** Parsed, mutated document per file — one entry even when a file has two sections. */
  const docs = new Map<string, any>();

  const apply = (site: AdoptPlan, entries: Record<string, any>) => {
    for (const [name, spec] of Object.entries(entries)) {
      if (keep.has(name)) {
        site.kept.push(name);
        continue;
      }
      site.moved.push(name);
      // First writer wins: the same server registered twice is one server.
      adopted[name] ??= spec;
      delete entries[name];
    }
  };

  if (opts.harness === "codex") {
    const file = join(homeDir(), ".codex", "config.toml");
    const text = await readText(file);
    if (text) {
      let config: any;
      try {
        config = parseToml(text);
      } catch {
        config = null;
      }
      if (config) {
        const plan: AdoptPlan = { harness: "codex", file, section: "mcp_servers", moved: [], kept: [] };
        backup[file] = text;
        docs.set(file, config);
        apply(plan, config.mcp_servers ?? {});
        plans.push(plan);
      }
    }
  } else {
    for (const site of jsonSites(opts.harness, opts.cwd)) {
      // A file may host two sections (~/.claude.json). Parse it once and mutate
      // that one document, so the second section never reads a stale copy.
      if (!docs.has(site.file)) {
        const text = await readText(site.file);
        if (!text) continue;
        try {
          docs.set(site.file, JSON.parse(stripJsonComments(text)));
        } catch {
          continue;
        }
        backup[site.file] = text;
      }
      const config = docs.get(site.file);
      const container = site.path.reduce((acc: any, k: string) => acc?.[k], config);
      if (!container || typeof container !== "object") continue;
      const plan: AdoptPlan = {
        harness: opts.harness,
        file: site.file,
        section: site.section,
        moved: [],
        kept: [],
      };
      apply(plan, container);
      plans.push(plan);
    }
  }

  // Servers the router will be able to reach once this adoption lands — the
  // ones moving now plus the ones it already holds. A plugin may only be
  // disabled when everything it contributed is in that set.
  // resolved.servers is the router's actual reach — it already includes the
  // servers the plugins importer discovers from installed_plugins.json. That
  // file records *installation*, not Claude Code's enabledPlugins, so disabling
  // a plugin in the harness does not hide its server from the router. That is
  // precisely what makes disabling a plugin a move rather than a deletion.
  const routedServers = new Set([
    ...resolved.servers.map((s) => s.name),
    ...resolved.servers.flatMap((s) => (s.name.includes(":") ? [s.name.split(":").pop()!] : [])),
    ...Object.keys(adopted),
  ]);

  const extras =
    opts.extras && opts.harness === "claude"
      ? await planExtras({
          cwd: opts.cwd,
          skillPaths: resolved.config.skillPaths,
          keepSkills: opts.keepSkills ?? [],
          keepPlugins: opts.keepPlugins ?? [],
          mode: opts.skillMode ?? "user-invocable-only",
          routedServers,
          unreachable: opts.unreachable,
        })
      : null;

  const extrasCount = (extras?.skills.length ?? 0) + (extras?.plugins.length ?? 0);
  const movedCount = plans.reduce((n, p) => n + p.moved.length, 0);
  if (!movedCount && !extrasCount) {
    return {
      plans,
      extras,
      backup: null,
      notes: ["Nothing to adopt — no downstream servers, skills or plugins are loaded directly by this harness."],
    };
  }
  if (opts.dryRun) return { plans, extras, backup: null, notes: ["Dry run — no files were changed."] };

  // settings.json is mutated by applyExtras, so it belongs in the same backup
  // as the server moves — one `restore` has to undo the whole adoption.
  if (extrasCount) {
    const text = await readText(settingsPath());
    if (text !== null) backup[settingsPath()] = text;
  }

  // The backup is written before the first mutation and outside the cache dir,
  // which `reindex` and cleanup tooling are entitled to delete at any time.
  const backupPath = join(backupDir(), `${opts.harness}-${stamp()}.json`);
  await ensureDir(join(backupPath, ".."));
  await writeText(backupPath, `${JSON.stringify({ harness: opts.harness, files: backup }, null, 2)}\n`);

  const touched = new Set(plans.filter((p) => p.moved.length).map((p) => p.file));
  for (const file of touched) {
    const config = docs.get(file);
    await writeText(
      file,
      file.endsWith(".toml") ? stringifyToml(config) : `${JSON.stringify(config, null, 2)}\n`,
    );
  }

  if (movedCount) await mergeIntoRouterConfig(adopted, resolved.configPath);
  if (extras && extrasCount) await applyExtras(extras);

  const notes: string[] = [];
  if (movedCount) notes.push(`Moved ${movedCount} server(s) into the router's config.`);
  if (extras?.skills.length) {
    notes.push(
      `Hid ${extras.skills.length} skill(s) from the model` +
        (extras.skills[0]?.mode === "user-invocable-only" ? " — /name still works for you." : "."),
    );
  }
  if (extras?.plugins.length) notes.push(`Disabled ${extras.plugins.length} plugin(s).`);
  notes.push(`Backup at ${backupPath}`);
  notes.push("Restart the harness — its tool list should now show only the router.");
  return { plans, extras, backup: backupPath, notes };
}

/** Adoption backups outlive the cache on purpose — losing one loses a config. */
export function backupDir(): string {
  return join(homeDir(), ".autorouter", "adopted");
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export async function runRestore(harness: Harness): Promise<string[]> {
  const dir = backupDir();
  const { readdir } = await import("node:fs/promises");
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.startsWith(`${harness}-`)).sort();
  } catch {
    return [`No adoption backups found for ${harness}.`];
  }
  const latest = files.at(-1);
  if (!latest) return [`No adoption backups found for ${harness}.`];

  const payload = JSON.parse((await readText(join(dir, latest)))!);
  const notes: string[] = [];
  for (const [file, text] of Object.entries(payload.files as Record<string, string>)) {
    await writeText(file, text);
    notes.push(`Restored ${file}`);
  }
  notes.push(`From ${join(dir, latest)}. The router's own config still lists these servers; that is harmless (duplicates are deduped) but you can remove them.`);
  return notes;
}

function jsonSites(harness: Harness, cwd: string): JsonSite[] {
  switch (harness) {
    case "claude":
      return [
        { file: join(homeDir(), ".claude.json"), section: "mcpServers", path: ["mcpServers"] },
        {
          file: join(homeDir(), ".claude.json"),
          section: `projects[${cwd}].mcpServers`,
          path: ["projects", cwd, "mcpServers"],
        },
        { file: join(cwd, ".mcp.json"), section: "mcpServers", path: ["mcpServers"] },
      ];
    case "cursor":
      return [
        { file: join(homeDir(), ".cursor", "mcp.json"), section: "mcpServers", path: ["mcpServers"] },
        { file: join(cwd, ".cursor", "mcp.json"), section: "mcpServers", path: ["mcpServers"] },
      ];
    case "vscode":
      return [
        { file: join(homeDir(), ".vscode", "mcp.json"), section: "servers", path: ["servers"] },
        { file: join(cwd, ".vscode", "mcp.json"), section: "servers", path: ["servers"] },
      ];
    default:
      return [];
  }
}

/** Servers named by an alwaysExpose pattern must remain in the harness config. */
function serversBehind(patterns: string[]): string[] {
  const out: string[] = [];
  for (const p of patterns) {
    const m = /^(?:mcp:)?([^:/.*]+)[/.]/.exec(p);
    if (m?.[1]) out.push(m[1]);
  }
  return out;
}

async function mergeIntoRouterConfig(
  servers: Record<string, any>,
  existingPath: string | null,
): Promise<void> {
  const path = existingPath ?? join(homeDir(), ".config", "autorouter", "config.json");
  await ensureDir(join(path, ".."));
  let config: any = {};
  if (await exists(path)) {
    try {
      config = JSON.parse(stripJsonComments((await readText(path)) ?? "{}"));
    } catch {
      config = {};
    }
  }
  config.servers = { ...servers, ...config.servers };
  await writeText(path, `${JSON.stringify(config, null, 2)}\n`);
}
