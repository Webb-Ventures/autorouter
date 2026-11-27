import { basename, join, resolve } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { ensureDir, readText, writeText } from "../util/fs.ts";
import { claudeInstall, defaultClaudeDir, homeDir, installLabel, stripJsonComments, type ClaudeInstall } from "../util/paths.ts";
import { resolveConfig, type ResolvedConfig } from "../config/resolve.ts";
import { upsertProjectServers, upsertServers } from "../config/write.ts";
import type { Harness } from "./init.ts";
import { isSelfReference, normalizeServer } from "../config/adapters/shared.ts";
import {
  applyExtras,
  assertSettingsWritable,
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
  /** For Claude Code, the install (config dir) this plan edits. */
  configDir?: string;
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

/** `project` marks a section that belongs to one repo, so its servers stay scoped to it. */
type JsonSite = { file: string; section: string; path: string[]; project?: string };

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
  /**
   * The Claude Code install to adopt (default: the active one — CLAUDE_CONFIG_DIR,
   * else ~/.claude). Ignored for other harnesses.
   */
  install?: ClaudeInstall;
  /**
   * The config already resolved for `cwd`, when the caller has it. Doctor and
   * auto-adopt run one pass per harness and `adopt` a preview then the real
   * thing; resolving again for each re-read every harness config to learn
   * nothing new. Only read-only inputs come from it (alwaysExpose, the server
   * list, the config path); the files adopt rewrites are always read fresh.
   * Used only when it was resolved for `install`: another install has its own
   * servers and plugins.
   */
  resolved?: ResolvedConfig;
}): Promise<AdoptResult> {
  const install = opts.install ?? claudeInstall();
  const resolved =
    opts.resolved && opts.resolved.install.dir === install.dir && opts.resolved.install.claudeJson === install.claudeJson
      ? opts.resolved
      : await resolveConfig(opts.cwd, { install });
  // alwaysExpose capabilities must stay first-class, so their servers stay put.
  const keep = new Set([
    "autorouter",
    ...opts.keep,
    ...serversBehind(resolved.config.alwaysExpose),
  ]);

  const plans: AdoptPlan[] = [];
  const adopted: Record<string, any> = {};
  /** Servers from a project-scoped section, bound for config.projects[root]. */
  const adoptedProject: Record<string, any> = {};
  /** Original file text, captured before anything is mutated. */
  const backup: Record<string, string> = {};
  /** Parsed, mutated document per file — one entry even when a file has two sections. */
  const docs = new Map<string, any>();

  const apply = (site: AdoptPlan, entries: Record<string, any>, target = adopted) => {
    for (const [name, spec] of Object.entries(entries)) {
      // The router's own registration stays in the harness whatever it is
      // called. Matching the name alone moved an entry called "router" out,
      // after which resolveConfig drops it as a self-reference: the harness
      // was left with no router at all.
      const entry = spec && typeof spec === "object" ? normalizeServer(name, spec, "adopt") : null;
      if (keep.has(name) || (entry && isSelfReference(entry))) {
        site.kept.push(name);
        continue;
      }
      site.moved.push(name);
      // First writer wins: the same server registered twice is one server.
      target[name] ??= spec;
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
    for (const site of jsonSites(opts.harness, opts.cwd, install)) {
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
        ...(opts.harness === "claude" ? { configDir: install.dir } : {}),
        file: site.file,
        section: site.section,
        moved: [],
        kept: [],
      };
      apply(plan, container, site.project ? adoptedProject : adopted);
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
    ...Object.keys(adoptedProject),
  ]);

  const extras =
    opts.extras && opts.harness === "claude"
      ? await planExtras({
          cwd: opts.cwd,
          skillPaths: resolved.config.skillPaths,
          keepSkills: opts.keepSkills ?? [],
          keepPlugins: opts.keepPlugins ?? [],
          mode: opts.skillMode ?? "name-only",
          routedServers,
          unreachable: opts.unreachable,
          install,
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
    // Checked before anything is written, so a settings file that cannot be
    // updated stops the adoption whole rather than halfway.
    const file = settingsPath(install);
    await assertSettingsWritable(file);
    const text = await readText(file);
    if (text !== null) backup[file] = text;
  }

  // The backup is written before the first mutation and outside the cache dir,
  // which `reindex` and cleanup tooling are entitled to delete at any time.
  // Each Claude install gets its own, tagged with its dir, so `restore` undoes
  // one install without touching the others.
  const claudeDirTag = opts.harness === "claude" ? install.dir : null;
  const backupPath = join(backupDir(), backupName(opts.harness, claudeDirTag, install.isDefault));
  await ensureDir(join(backupPath, ".."));
  await writeText(
    backupPath,
    `${JSON.stringify({ harness: opts.harness, ...(claudeDirTag ? { configDir: claudeDirTag } : {}), files: backup }, null, 2)}\n`,
  );

  // The router's config is written first. If that fails (it throws on a config
  // it cannot parse) the harness files are untouched; the other order removed
  // the servers from the harness and then failed to record them anywhere. A
  // failure after this point leaves a server in both places, which is harmless.
  if (Object.keys(adopted).length) await upsertServers(adopted, { configPath: resolved.configPath });
  if (Object.keys(adoptedProject).length) {
    await upsertProjectServers(resolve(opts.cwd), adoptedProject, { configPath: resolved.configPath });
  }

  const touched = new Set(plans.filter((p) => p.moved.length).map((p) => p.file));
  for (const file of touched) {
    const config = docs.get(file);
    await writeText(
      file,
      file.endsWith(".toml") ? stringifyToml(config) : `${JSON.stringify(config, null, 2)}\n`,
    );
  }
  if (extras && extrasCount) await applyExtras(extras);

  const notes: string[] = [];
  if (movedCount) notes.push(`Moved ${movedCount} server(s) into the router's config.`);
  if (extras?.skills.length) {
    notes.push(
      `Hid ${extras.skills.length} skill(s) from the model` +
        (extras.skills[0]?.mode === "name-only"
          ? " — Claude can still invoke them by name, and /name still works for you."
          : extras.skills[0]?.mode === "user-invocable-only"
            ? " — /name still works for you."
            : "."),
    );
  }
  if (extras?.plugins.length) notes.push(`Disabled ${extras.plugins.length} plugin(s).`);
  notes.push(`Backup at ${backupPath}`);
  notes.push("Restart the harness — its tool list should now show only the router.");
  return { plans, extras, backup: backupPath, notes };
}

/** The harnesses that hold MCP server registrations of their own. */
const HARNESSES: Harness[] = ["claude", "codex", "cursor", "vscode"];

/**
 * Keeps the invariant that a harness config holds no downstream servers.
 *
 * This is what makes `claude mcp add foo` a complete flow rather than half of
 * one: the server appears in the harness, the running router notices the config
 * changed, and the entry is moved behind the router before the next search. It
 * needs no diffing for "new" servers because adopt is already idempotent — a
 * second pass finds nothing to move and writes nothing.
 *
 * Servers only. Disabling a plugin or hiding a skill is a larger, more opinionated
 * change to someone's setup than relocating a server entry, and doing it
 * unprompted is not a trade the user agreed to by installing an MCP server.
 */
export async function runAutoAdopt(cwd: string): Promise<string[]> {
  const resolved = await resolveConfig(cwd);
  if (resolved.config.autoAdopt === false) return [];

  const notes: string[] = [];
  for (const harness of HARNESSES) {
    if (!resolved.config.import.includes(harness)) continue;
    try {
      const result = await runAdopt({ harness, cwd, keep: [], dryRun: false, extras: false, resolved });
      const moved = result.plans.flatMap((p) => p.moved);
      if (moved.length) notes.push(`adopted ${moved.join(", ")} from ${harness}`);
    } catch {
      // A harness config that cannot be read or rewritten is not a reason to
      // fail the search that triggered this.
    }
  }
  return notes;
}

/** Adoption backups outlive the cache on purpose — losing one loses a config. */
export function backupDir(): string {
  return join(homeDir(), ".autorouter", "adopted");
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * `<harness>-<stamp>.json`, plus `--<dir name>` for a Claude install other than
 * the default. The stamp leads, so names still sort by time.
 */
function backupName(harness: Harness, configDir: string | null, isDefault: boolean): string {
  const tag = configDir && !isDefault ? `--${basename(configDir).replace(/[^a-zA-Z0-9._-]+/g, "_")}` : "";
  return `${harness}-${stamp()}${tag}.json`;
}

/**
 * Undoes the most recent adopt of `harness`. For Claude Code that is per
 * install: only backups taken from `install` (default: the active one) count.
 * Backups from before installs were tracked carry no configDir and belong to
 * the default install — the only one adopt could edit then.
 */
export async function runRestore(
  harness: Harness,
  opts: { install?: ClaudeInstall } = {},
): Promise<string[]> {
  const dir = backupDir();
  const install = opts.install ?? claudeInstall();
  const where = harness === "claude" ? ` in ${installLabel(install)}` : "";
  const none = [`No adoption backups found for ${harness}${where}.`];
  const { readdir } = await import("node:fs/promises");
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.startsWith(`${harness}-`) && f.endsWith(".json")).sort();
  } catch {
    return none;
  }

  let latest: string | undefined;
  let payload: any;
  for (const name of files.reverse()) {
    let parsed: any;
    try {
      parsed = JSON.parse((await readText(join(dir, name))) ?? "");
    } catch {
      continue;
    }
    if (harness === "claude") {
      const owner = typeof parsed?.configDir === "string" ? parsed.configDir : defaultClaudeDir();
      if (owner !== install.dir) continue;
    }
    latest = name;
    payload = parsed;
    break;
  }
  if (!latest) return none;

  const notes: string[] = [];
  for (const [file, text] of Object.entries(payload.files as Record<string, string>)) {
    await writeText(file, text);
    notes.push(`Restored ${file}`);
  }
  notes.push(`From ${join(dir, latest)}. The router's own config still lists these servers; that is harmless (duplicates are deduped) but you can remove them.`);
  return notes;
}

/**
 * The harness config sections adopt may rewrite.
 *
 * Only files private to this user. A repo's `.mcp.json`, `.cursor/mcp.json` and
 * `.vscode/mcp.json` are committed: emptying them shows up as a diff for the
 * whole team, and moving their servers into the router's global config made a
 * repo's servers reachable from every other project. Project `.mcp.json`
 * servers are picked up in place instead (workspace/project.ts), and hidden
 * from Claude Code through the repo's own settings.local.json.
 */
function jsonSites(harness: Harness, cwd: string, install: ClaudeInstall): JsonSite[] {
  switch (harness) {
    case "claude":
      return [
        { file: install.claudeJson, section: "mcpServers", path: ["mcpServers"] },
        {
          file: install.claudeJson,
          section: `projects[${cwd}].mcpServers`,
          path: ["projects", cwd, "mcpServers"],
          project: cwd,
        },
      ];
    case "cursor":
      return [
        { file: join(homeDir(), ".cursor", "mcp.json"), section: "mcpServers", path: ["mcpServers"] },
      ];
    case "vscode":
      return [
        { file: join(homeDir(), ".vscode", "mcp.json"), section: "servers", path: ["servers"] },
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
