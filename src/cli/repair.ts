import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { exists, readText, writeText } from "../util/fs.ts";
import { homeDir, stripJsonComments } from "../util/paths.ts";
import { resolveConfig } from "../config/resolve.ts";
import { normalizeServer, specKey, type RawServer } from "../config/adapters/shared.ts";
import { removeServers, upsertProjectServers } from "../config/write.ts";
import { approveServers, mainCheckout } from "../workspace/trust.ts";
import { runProjectAdopt } from "../workspace/project.ts";
import { backupDir } from "./adopt.ts";

/**
 * Undoes what adopt used to do to project-scoped servers.
 *
 * Until adopt stopped touching committed files, it would empty a repo's
 * `.mcp.json` and move those servers into the router's *global* config — so
 * the team saw a diff, and the servers became reachable from every project.
 * Likewise a project's private servers (~/.claude.json projects[path]) were
 * promoted to global. Every adopt wrote a verbatim backup first, so the
 * original entries are recoverable:
 *
 *   - `.mcp.json` entries that adopt removed and the router still holds
 *     globally are put back in the file (verbatim from the backup when the
 *     only difference is those entries, merged otherwise), approved for the
 *     router — they were in use through it — and dropped from the global list
 *     unless some harness also registered them globally;
 *   - private project servers move from global to config.projects[path];
 *   - each repo is then adopted the new way, through settings.local.json.
 *
 * Entries the user removed themselves (absent from the router config too) are
 * left alone. Dry run unless `apply`.
 */
export type RepairPlan = {
  files: { file: string; root: string; restore: string[]; verbatim: boolean }[];
  /** Global router servers that move into a project scope. */
  scoped: { root: string; names: string[] }[];
  /** Global router servers that are dropped (restored to a repo file instead). */
  unglobal: string[];
  /**
   * Repo servers to approve for the router: every existing repo whose
   * `.mcp.json` holds the same server that is leaving the global list, restored
   * or not — otherwise a stdio server the router ran yesterday stops working there.
   */
  approve: { root: string; names: string[] }[];
};

type Doc = { mcpServers?: Record<string, RawServer>; projects?: Record<string, { mcpServers?: Record<string, RawServer> }> };

export async function planRepair(): Promise<RepairPlan> {
  const plan: RepairPlan = { files: [], scoped: [], unglobal: [], approve: [] };
  const backups = await listBackups();
  if (!backups.length) return plan;

  const resolved = await resolveConfig(homeDir());
  const globalServers = resolved.config.servers ?? {};
  const globalKey = (name: string) => {
    const raw = globalServers[name];
    const e = raw ? normalizeServer(name, raw as RawServer, "config") : null;
    return e ? specKey(e) : null;
  };

  /** Repo file -> server name -> {spec, text of a backup holding it}. */
  const repoEntries = new Map<string, Map<string, RawServer>>();
  const repoTexts = new Map<string, string[]>();
  /** Project path -> private servers that adopt moved out of ~/.claude.json. */
  const privateEntries = new Map<string, Map<string, RawServer>>();
  /** Names some harness registered globally: those stay global. */
  const registeredGlobally = new Set<string>();

  for (const payload of backups) {
    for (const [file, text] of Object.entries(payload.files ?? {})) {
      const doc = parse(text);
      if (!doc) continue;
      if (file.endsWith(`${"/"}.mcp.json`) && !file.startsWith(join(homeDir(), ".claude"))) {
        const map = repoEntries.get(file) ?? new Map();
        for (const [name, raw] of Object.entries(doc.mcpServers ?? {})) map.set(name, raw);
        repoEntries.set(file, map);
        repoTexts.set(file, [...(repoTexts.get(file) ?? []), text]);
        continue;
      }
      for (const name of Object.keys(doc.mcpServers ?? {})) registeredGlobally.add(name);
      if ((doc as any).mcp_servers) for (const name of Object.keys((doc as any).mcp_servers)) registeredGlobally.add(name);
      if ((doc as any).servers) for (const name of Object.keys((doc as any).servers)) registeredGlobally.add(name);
      for (const [path, project] of Object.entries(doc.projects ?? {})) {
        const map = privateEntries.get(path) ?? new Map();
        for (const [name, raw] of Object.entries(project?.mcpServers ?? {})) map.set(name, raw);
        if (map.size) privateEntries.set(path, map);
      }
    }
  }

  const unglobal = new Set<string>();
  for (const [file, entries] of [...repoEntries].sort(([a], [b]) => a.localeCompare(b))) {
    // Worktrees come and go; recreating a deleted one's directory to restore a
    // file nobody can see would be worse than leaving it.
    if (!(await exists(dirname(file)))) continue;
    const current = parse((await readText(file)) ?? "{}") ?? {};
    const present = current.mcpServers ?? {};
    const restore: string[] = [];
    for (const [name, raw] of entries) {
      if (name in present) continue;
      const e = normalizeServer(name, raw, "claude:mcp.json");
      // Only what adopt moved: the router still holds the same server globally.
      if (!e || globalKey(name) !== specKey(e)) continue;
      restore.push(name);
      if (!registeredGlobally.has(name)) unglobal.add(name);
    }
    if (!restore.length) continue;
    const verbatim = (repoTexts.get(file) ?? []).some((text) => restoresExactly(text, current, restore));
    plan.files.push({ file, root: dirname(file), restore: restore.sort(), verbatim });
  }

  for (const [root, entries] of [...privateEntries].sort(([a], [b]) => a.localeCompare(b))) {
    const names: string[] = [];
    for (const [name, raw] of entries) {
      const e = normalizeServer(name, raw, "claude");
      if (!e || globalKey(name) !== specKey(e) || registeredGlobally.has(name)) continue;
      if (plan.files.some((f) => f.root === root && f.restore.includes(name))) continue;
      names.push(name);
      unglobal.add(name);
    }
    if (names.length) plan.scoped.push({ root, names: names.sort() });
  }
  plan.unglobal = [...unglobal].sort();

  for (const file of [...repoEntries.keys()].sort()) {
    const root = dirname(file);
    if (!(await exists(root))) continue;
    const restoring = plan.files.find((f) => f.file === file)?.restore ?? [];
    const present = { ...(parse((await readText(file)) ?? "{}")?.mcpServers ?? {}) };
    for (const name of restoring) present[name] = repoEntries.get(file)!.get(name)!;
    const names = Object.entries(present)
      .filter(([name, raw]) => {
        if (!unglobal.has(name)) return false;
        const e = normalizeServer(name, raw, "claude:mcp.json");
        return e?.transport === "stdio" && globalKey(name) === specKey(e);
      })
      .map(([name]) => name)
      .sort();
    if (!names.length) continue;
    // Approvals are per repository, so worktrees of one repo collapse to one line.
    const repo = await mainCheckout(root);
    const existing = plan.approve.find((a) => a.root === repo);
    if (existing) existing.names = [...new Set([...existing.names, ...names])].sort();
    else plan.approve.push({ root: repo, names });
  }
  return plan;
}

export async function applyRepair(plan: RepairPlan): Promise<string[]> {
  const notes: string[] = [];
  const backups = await listBackups();
  const resolved = await resolveConfig(homeDir());

  for (const f of plan.files) {
    const currentText = (await readText(f.file)) ?? "{}";
    const current = parse(currentText) ?? {};
    const texts = backups.flatMap((b) => (b.files?.[f.file] ? [b.files[f.file]!] : []));
    const verbatim = f.verbatim ? texts.find((t) => restoresExactly(t, current, f.restore)) : undefined;
    if (verbatim) {
      await writeText(f.file, verbatim);
    } else {
      const source = new Map<string, RawServer>();
      for (const t of texts) for (const [n, r] of Object.entries(parse(t)?.mcpServers ?? {})) source.set(n, r);
      const next = { ...current, mcpServers: { ...current.mcpServers } };
      for (const name of f.restore) next.mcpServers[name] = source.get(name)!;
      await writeText(f.file, `${JSON.stringify(next, null, 2)}\n`);
    }
    notes.push(`Restored ${f.restore.length} server(s) to ${f.file}${verbatim ? " (byte-for-byte from backup)" : ""}: ${f.restore.join(", ")}`);
  }

  // These ran through the router before adopt moved them; keep them running.
  for (const a of plan.approve) {
    // The spec approved is the router's own global one, which the plan matched
    // against each repo's .mcp.json entry.
    const entries = a.names
      .map((name) => normalizeServer(name, resolved.config.servers[name] as RawServer, "claude:mcp.json"))
      .filter((e): e is NonNullable<typeof e> => Boolean(e));
    await approveServers(a.root, entries);
  }
  if (plan.approve.length) notes.push(`Approved stdio servers for the router in ${plan.approve.length} repo(s).`);

  for (const s of plan.scoped) {
    const servers: Record<string, unknown> = {};
    for (const name of s.names) servers[name] = resolved.config.servers[name];
    await upsertProjectServers(s.root, servers, { configPath: resolved.configPath });
    notes.push(`Scoped ${s.names.join(", ")} to ${s.root}`);
  }

  if (plan.unglobal.length) {
    const removed = await removeServers(plan.unglobal, resolved.configPath);
    if (removed.length) notes.push(`Removed from the global router config: ${removed.join(", ")}`);
  }

  for (const root of [...new Set(plan.files.map((f) => f.root))]) {
    if (!(await exists(root))) continue;
    const { notes: adopted, plan: p } = await runProjectAdopt(root);
    for (const n of adopted) notes.push(`Adopted: ${n}`);
    if (p?.unapproved.length) {
      notes.push(`Left with Claude Code (not approved for the router): ${p.unapproved.join(", ")} in ${root}`);
    }
  }
  if (notes.length) notes.push("Restart Claude Code in those repos to pick up the change.");
  return notes;
}

export function formatRepairPlan(plan: RepairPlan): string[] {
  const lines: string[] = [];
  for (const f of plan.files) {
    lines.push(`  restore  ${f.file}  +${f.restore.length}: ${f.restore.join(", ")}${f.verbatim ? "  (verbatim)" : ""}`);
  }
  for (const s of plan.scoped) lines.push(`  scope    ${s.root}: ${s.names.join(", ")}`);
  if (plan.unglobal.length) lines.push(`  unglobal ${plan.unglobal.join(", ")}`);
  for (const a of plan.approve) lines.push(`  approve  ${a.root}: ${a.names.join(", ")}`);
  return lines;
}

async function listBackups(): Promise<{ files?: Record<string, string> }[]> {
  let names: string[];
  try {
    names = (await readdir(backupDir())).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const out: { files?: Record<string, string> }[] = [];
  for (const name of names) {
    const text = await readText(join(backupDir(), name));
    try {
      if (text) out.push(JSON.parse(text));
    } catch {}
  }
  return out;
}

function parse(text: string): Doc | null {
  try {
    const v = JSON.parse(stripJsonComments(text));
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

/** True when `text` is exactly the current file plus the servers being restored. */
function restoresExactly(text: string, current: Doc, restore: string[]): boolean {
  const doc = parse(text);
  if (!doc?.mcpServers) return false;
  const { mcpServers: _a, ...restDoc } = doc;
  const { mcpServers: _b, ...restCurrent } = current;
  if (JSON.stringify(restDoc) !== JSON.stringify(restCurrent)) return false;
  const present = current.mcpServers ?? {};
  const want = new Set([...Object.keys(present), ...restore]);
  const have = Object.keys(doc.mcpServers);
  if (have.length !== want.size || !have.every((n) => want.has(n))) return false;
  return Object.entries(present).every(([n, raw]) => JSON.stringify(doc.mcpServers![n]) === JSON.stringify(raw));
}
