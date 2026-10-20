import { dirname, join, resolve, basename } from "node:path";
import { homeDir, readJson } from "../util/paths.ts";
import { readText } from "../util/fs.ts";
import { writeText, ensureDir } from "../util/fs.ts";
import { specKey } from "../config/adapters/shared.ts";
import type { ServerEntry } from "../config/types.ts";

/**
 * Whether the router may launch a server from a repo's `.mcp.json`.
 *
 * `.mcp.json` is checked into repositories, so a freshly cloned repo can name
 * any command it likes there, and the router enumerates servers at index time —
 * well before any call. Claude Code asks before launching one; the router must
 * not be the way around that prompt. The rule:
 *
 *   - the folder must be trusted (Claude Code's trust dialog), and then
 *   - an HTTP server is allowed: it runs nothing locally and still needs its
 *     own login, or
 *   - a stdio server must be approved, either in Claude Code
 *     (enabledMcpjsonServers / enableAllProjectMcpServers, in a scope the repo
 *     cannot write for itself) or with `autorouter approve`, which pins the
 *     exact command so an edited entry needs approving again.
 */
export type McpjsonApproval = {
  trusted: boolean;
  approved: (entry: ServerEntry) => boolean;
};

type ProjectState = {
  hasTrustDialogAccepted?: boolean;
  enabledMcpjsonServers?: string[];
  enableAllProjectMcpServers?: boolean;
};

type SettingsLike = {
  enabledMcpjsonServers?: string[];
  enableAllProjectMcpServers?: boolean;
};

/** root -> server name -> specKey it was approved with. */
type Approvals = Record<string, Record<string, string>>;

export function approvalsPath(): string {
  return join(homeDir(), ".autorouter", "approvals.json");
}

export async function readApprovals(): Promise<Approvals> {
  return (await readJson<Approvals>(approvalsPath())) ?? {};
}

/**
 * The repository a linked git worktree belongs to, or the path itself.
 *
 * `git worktree add` (and Claude Code's own worktrees) produce checkouts whose
 * `.git` is a file pointing into the main repo's `.git/worktrees/<name>`. They
 * share one history, so trust and approvals given to the repository hold for
 * every checkout of it — otherwise each new worktree silently loses servers.
 */
export async function mainCheckout(root: string): Promise<string> {
  const abs = resolve(root);
  const text = await readText(join(abs, ".git"));
  const m = text?.match(/^gitdir:\s*(.+)\s*$/m);
  if (!m) return abs;
  const gitdir = resolve(abs, m[1]!.trim());
  // <main>/.git/worktrees/<name>
  const common = dirname(dirname(gitdir));
  return basename(dirname(gitdir)) === "worktrees" && basename(common) === ".git" ? dirname(common) : abs;
}

/** Records that the user approved these exact server specs for `root`'s repository. */
export async function approveServers(root: string, entries: ServerEntry[]): Promise<void> {
  if (!entries.length) return;
  const all = await readApprovals();
  const abs = await mainCheckout(root);
  all[abs] = { ...all[abs] };
  for (const e of entries) all[abs]![e.name] = specKey(e);
  await ensureDir(join(approvalsPath(), ".."));
  await writeText(approvalsPath(), `${JSON.stringify(sortKeys(all), null, 2)}\n`);
}

export async function mcpjsonApproval(root: string): Promise<McpjsonApproval> {
  const abs = resolve(root);
  const claude = await readJson<{ projects?: Record<string, ProjectState> }>(
    join(homeDir(), ".claude.json"),
  );
  const main = await mainCheckout(abs);
  const project = claude?.projects?.[abs] ?? {};
  const trusted =
    project.hasTrustDialogAccepted === true || claude?.projects?.[main]?.hasTrustDialogAccepted === true;

  // Committed project settings only count once the folder is trusted — the
  // same rule Claude Code applies, since otherwise the repo approves itself.
  const scopes: (SettingsLike | null)[] = [
    project,
    await readJson<SettingsLike>(join(homeDir(), ".claude", "settings.json")),
    await readJson<SettingsLike>(join(abs, ".claude", "settings.local.json")),
    trusted ? await readJson<SettingsLike>(join(abs, ".claude", "settings.json")) : null,
  ];
  const all = scopes.some((s) => s?.enableAllProjectMcpServers === true);
  const named = new Set(scopes.flatMap((s) => s?.enabledMcpjsonServers ?? []));
  const approvals = await readApprovals();
  const pinned = { ...approvals[main], ...approvals[abs] };

  return {
    trusted,
    approved: (entry) => {
      if (!trusted) return false;
      if (entry.transport === "http") return true;
      return all || named.has(entry.name) || pinned[entry.name] === specKey(entry);
    },
  };
}

function sortKeys<T>(value: T): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.keys(value as object)
      .sort()
      .map((k) => [k, sortKeys((value as any)[k])]),
  ) as T;
}
