import { join, resolve } from "node:path";
import { ensureDir, exists, readText, writeText } from "../util/fs.ts";
import { homeDir, readJson, stripJsonComments } from "../util/paths.ts";
import { run } from "../util/proc.ts";
import { resolveConfig } from "../config/resolve.ts";
import { loadMcpjson } from "../config/adapters/claude.ts";
import { collectSkills } from "../catalog/providers/skills.ts";
import { isHome } from "./root.ts";

/**
 * Repo-scoped adoption: the project half of `adopt`, safe to run unprompted.
 *
 * A repo brings two things Claude Code loads into every prompt: the servers in
 * its `.mcp.json` and the skills in its `.claude/skills`. The router already
 * indexes both for the repo it runs in. This hides them from Claude Code using
 * the only file that is both per-repo and private — `.claude/settings.local.json`
 * — through two documented settings:
 *
 *   disabledMcpjsonServers: [name]               the server is not started
 *   skillOverrides: { name: "user-invocable-only" }  out of context, /name works
 *
 * Nothing committed is edited, nothing leaks into other projects, and every key
 * written is recorded so `restore --project` removes exactly those and leaves
 * the user's own edits alone. Only `.mcp.json` servers the router may launch
 * (workspace/trust.ts) are hidden — an unapproved one stays with Claude Code,
 * which will ask about it as usual.
 */
export type ProjectPlan = {
  root: string;
  file: string;
  servers: string[];
  skills: string[];
  /** Servers left alone because the router may not launch them. */
  unapproved: string[];
};

type LocalSettings = {
  disabledMcpjsonServers?: string[];
  skillOverrides?: Record<string, string>;
  [key: string]: unknown;
};

/** What autorouter added to each repo's settings.local.json, so it can be taken back out. */
type ProjectState = Record<string, { servers: string[]; skills: string[] }>;

const SKILL_MODE = "user-invocable-only";

export function projectStatePath(): string {
  return join(homeDir(), ".autorouter", "projects.json");
}

export function localSettingsPath(root: string): string {
  return join(resolve(root), ".claude", "settings.local.json");
}

export async function planProjectAdopt(rootIn: string): Promise<ProjectPlan | null> {
  const root = resolve(rootIn);
  // In the home directory ".claude" is user scope; there is no project.
  if (isHome(root)) return null;
  const resolved = await resolveConfig(root);
  const file = localSettingsPath(root);
  const settings = await readLocalSettings(file);
  if (settings === "invalid") return null;

  const plan: ProjectPlan = { root, file, servers: [], skills: [], unapproved: [] };
  const disabled = new Set(settings.disabledMcpjsonServers ?? []);

  if (resolved.config.import.includes("claude")) {
    for (const { entry, approved } of await loadMcpjson(root)) {
      if (!approved) plan.unapproved.push(entry.name);
      else if (!disabled.has(entry.name)) plan.servers.push(entry.name);
    }
  }

  const { capabilities } = await collectSkills(resolved.config.skillPaths, root, {
    includePlugins: false,
  });
  const overrides = settings.skillOverrides ?? {};
  for (const cap of capabilities) {
    // An explicit value — even "on" — is the user's decision, not ours to change.
    if (cap.origin !== "project" || cap.name in overrides) continue;
    if (!plan.skills.includes(cap.name)) plan.skills.push(cap.name);
  }
  plan.servers.sort();
  plan.skills.sort();
  plan.unapproved.sort();
  return plan;
}

/** Applies a plan; returns human-readable notes (empty when there was nothing to do). */
export async function applyProjectAdopt(plan: ProjectPlan): Promise<string[]> {
  if (!plan.servers.length && !plan.skills.length) return [];
  const settings = await readLocalSettings(plan.file);
  if (settings === "invalid") return [];
  const created = !(await exists(plan.file));

  const next: LocalSettings = { ...settings };
  if (plan.servers.length) {
    next.disabledMcpjsonServers = [...new Set([...(settings.disabledMcpjsonServers ?? []), ...plan.servers])];
  }
  if (plan.skills.length) {
    next.skillOverrides = { ...settings.skillOverrides };
    for (const name of plan.skills) next.skillOverrides[name] = SKILL_MODE;
  }

  await ensureDir(join(plan.file, ".."));
  await writeText(plan.file, `${JSON.stringify(next, null, 2)}\n`);
  await recordState(plan.root, plan.servers, plan.skills);
  if (created) await keepOutOfGit(plan.root);

  const notes: string[] = [];
  if (plan.servers.length) notes.push(`routing ${plan.servers.join(", ")} from ${plan.root}/.mcp.json`);
  if (plan.skills.length) notes.push(`routing ${plan.skills.length} project skill(s) in ${plan.root}`);
  return notes;
}

/** Plan and apply in one step, honouring `autoAdoptProject`. */
export async function runProjectAdopt(
  root: string,
  opts: { auto?: boolean } = {},
): Promise<{ plan: ProjectPlan | null; notes: string[] }> {
  if (opts.auto) {
    const { config } = await resolveConfig(root);
    if (config.autoAdoptProject === false) return { plan: null, notes: [] };
  }
  const plan = await planProjectAdopt(root);
  if (!plan) return { plan: null, notes: [] };
  return { plan, notes: await applyProjectAdopt(plan) };
}

/** Removes exactly what autorouter added to this repo's settings.local.json. */
export async function restoreProject(rootIn: string): Promise<string[]> {
  const root = resolve(rootIn);
  const state = await readState();
  const added = state[root];
  if (!added) return [`autorouter has not changed ${localSettingsPath(root)}.`];

  const file = localSettingsPath(root);
  const settings = await readLocalSettings(file);
  if (settings === "invalid") return [`${file} is not valid JSON — fix it, then run restore again.`];

  const next: LocalSettings = { ...settings };
  if (next.disabledMcpjsonServers) {
    next.disabledMcpjsonServers = next.disabledMcpjsonServers.filter((n) => !added.servers.includes(n));
  }
  if (next.skillOverrides) {
    next.skillOverrides = { ...next.skillOverrides };
    for (const name of added.skills) {
      // Only take back a value we set; one the user has since changed is theirs.
      if (next.skillOverrides[name] === SKILL_MODE) delete next.skillOverrides[name];
    }
  }
  await writeText(file, `${JSON.stringify(next, null, 2)}\n`);
  delete state[root];
  await writeState(state);
  return [
    `Restored ${file}: re-enabled ${added.servers.length} server(s) and ${added.skills.length} skill(s) in Claude Code.`,
    `Set "autoAdoptProject": false in the router config, or a running router will route them again.`,
  ];
}

async function readLocalSettings(file: string): Promise<LocalSettings | "invalid"> {
  const text = await readText(file);
  if (text === null || !text.trim()) return {};
  try {
    const parsed = JSON.parse(stripJsonComments(text));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : "invalid";
  } catch {
    // Never overwrite a file we could not read: that would discard the user's settings.
    return "invalid";
  }
}

async function readState(): Promise<ProjectState> {
  return (await readJson<ProjectState>(projectStatePath())) ?? {};
}

async function writeState(state: ProjectState): Promise<void> {
  await ensureDir(join(projectStatePath(), ".."));
  const sorted = Object.fromEntries(Object.keys(state).sort().map((k) => [k, state[k]]));
  await writeText(projectStatePath(), `${JSON.stringify(sorted, null, 2)}\n`);
}

async function recordState(root: string, servers: string[], skills: string[]): Promise<void> {
  const state = await readState();
  const prev = state[root] ?? { servers: [], skills: [] };
  state[root] = {
    servers: [...new Set([...prev.servers, ...servers])].sort(),
    skills: [...new Set([...prev.skills, ...skills])].sort(),
  };
  await writeState(state);
}

/**
 * Claude Code git-ignores settings.local.json only when it creates the file
 * itself. When the router creates it, make sure it stays out of commits —
 * through the repo's local exclude file, never the shared .gitignore.
 */
async function keepOutOfGit(root: string): Promise<void> {
  try {
    const rel = ".claude/settings.local.json";
    const check = await run("git", ["-C", root, "check-ignore", "-q", rel], { timeoutMs: 5000 });
    if (check.code !== 1) return; // 0: already ignored; anything else: not a repo / no git.
    const where = await run("git", ["-C", root, "rev-parse", "--git-path", "info/exclude"], {
      timeoutMs: 5000,
    });
    if (where.code !== 0) return;
    const excludePath = resolve(root, where.stdout.trim());
    const current = (await readText(excludePath)) ?? "";
    if (current.split("\n").some((l) => l.trim() === rel || l.trim() === `/${rel}`)) return;
    await ensureDir(join(excludePath, ".."));
    const sep = current && !current.endsWith("\n") ? "\n" : "";
    await writeText(excludePath, `${current}${sep}# added by autorouter\n/${rel}\n`);
  } catch {
    // No git, or not a repo: nothing to keep it out of.
  }
}
