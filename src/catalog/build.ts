import { basename, join, resolve } from "node:path";
import { readdir, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { ResolvedConfig } from "../config/resolve.ts";
import type { ServerEntry } from "../config/types.ts";
import type { Catalog, Capability } from "./types.ts";
import { CATALOG_VERSION, matchesPattern } from "./types.ts";
import { collectSkills } from "./providers/skills.ts";
import { collectPluginAssets } from "./providers/plugins.ts";
import { connect, enumerateServer } from "./providers/mcp.ts";
import { cacheDir, homeDir, stripJsonComments } from "../util/paths.ts";
import { ensureDir, readText, writeText } from "../util/fs.ts";
import { authHint, authPath } from "../config/oauth.ts";
import { routerConfigPath } from "../config/write.ts";
import { listInstalledPlugins } from "../config/adapters/plugins.ts";
import { mainCheckout } from "../workspace/trust.ts";

export function catalogPath(cwd: string): string {
  // The slug is only for a human reading the cache dir. It is lossy
  // ("/a/foo-bar" and "/a/foo/bar" slug the same, as do long paths sharing a
  // tail), so the hash is what keeps two projects out of one file.
  const slug = cwd.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, "").slice(-60);
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 10);
  return join(cacheDir(), `catalog-${slug}-${hash}.json`);
}

export type BuildOptions = {
  /**
   * A server the caller enumerated moments ago, whose capabilities stand in
   * for connecting to it again. `autorouter add` has just started the new
   * server to check it answers; launching it a second time for the rebuild
   * doubled the slowest part of the command (an `npx -y` first run). Used only
   * when the resolved entry is that same server under that same name, since
   * capability ids embed the name and dedupe may have renamed or folded it.
   */
  reuse?: { entry: ServerEntry; capabilities: Capability[] };
};

export async function buildCatalog(resolved: ResolvedConfig, opts: BuildOptions = {}): Promise<Catalog> {
  const { config, servers, cwd, configPath } = resolved;
  const capabilities: Capability[] = [];
  const errors: Record<string, string> = {};
  // The router's own config, plus every harness config it imports from — a
  // server appearing in one of those is the most common way this catalog goes
  // out of date.
  // With no config yet, watch where one would be created: `autorouter add`
  // writes it there, and a running router has to notice.
  const sourceFiles: string[] = [configPath ?? routerConfigPath(null), ...resolved.sources];

  // A grant is a real input to the catalog: an unauthorized server contributes
  // zero capabilities, so obtaining a token changes the result as surely as
  // editing the config does. Tracking that is what makes `autorouter login`
  // visible to a running serve process — the alternative is waiting out the
  // 6-hour TTL while the model is told the tool does not exist.
  sourceFiles.push(
    ...servers.filter((s) => s.transport === "http").map((s) => `${AUTH}${authPath(s.name)}`),
  );

  // Same switch for plugin skills and plugin assets: leaving "plugins" out of
  // `import` means none of a plugin's contents are indexed, commands and
  // agents included. The installed list is read once here for both of them,
  // per build, so a long-lived process never holds on to a stale copy.
  const includePlugins = config.import.includes("plugins");
  const plugins = includePlugins ? await listInstalledPlugins() : [];

  // Skills, plugin assets and servers share nothing, so they are gathered
  // concurrently; the slowest (server connects) no longer waits behind the file
  // walks. Results are still appended in the old order below — skills, plugin
  // assets, then servers in config order — because search breaks score ties by
  // position.
  const [skills, pluginAssets, results] = await Promise.all([
    collectSkills(config.skillPaths, cwd, { includePlugins, plugins }),
    includePlugins ? collectPluginAssets(plugins) : null,
    // Servers are enumerated concurrently; one bad server must not block the rest.
    Promise.all(
      servers.map(async (entry) => {
        const reused = reusable(entry, opts.reuse);
        if (reused) return { entry, caps: reused };
        let client;
        try {
          client = await connect(entry);
          return { entry, caps: await enumerateServer(entry, client) };
        } catch (err) {
          return { entry, error: authHint(entry.name, err, entry.transport === "http" ? entry.oauth : undefined) };
        } finally {
          try {
            await client?.close();
          } catch {}
        }
      }),
    ),
  ]);
  capabilities.push(...skills.capabilities);
  sourceFiles.push(...skills.sources);
  if (pluginAssets) {
    capabilities.push(...pluginAssets.capabilities);
    sourceFiles.push(...pluginAssets.sources);
  }
  for (const r of results) {
    if ("error" in r && r.error) errors[r.entry.name] = r.error;
    else if ("caps" in r && r.caps) capabilities.push(...r.caps);
  }

  const filtered = capabilities.filter(
    (c) => !config.exclude.some((p) => matchesPattern(c.id, p)),
  );

  return {
    version: CATALOG_VERSION,
    builtAt: Date.now(),
    cwd,
    sources: await fingerprint(sourceFiles, cwd),
    capabilities: filtered,
    errors,
  };
}

/** The reused capabilities, when `entry` is exactly the server they came from. */
function reusable(entry: ServerEntry, reuse: BuildOptions["reuse"]): Capability[] | null {
  if (!reuse || entry.name !== reuse.entry.name) return null;
  // Origin records which configs listed it and a sign-in command is never
  // used to enumerate; everything else decides what gets launched or fetched.
  const launch = (e: ServerEntry) => JSON.stringify({ ...e, origin: undefined, login: undefined });
  return launch(entry) === launch(reuse.entry) ? reuse.capabilities : null;
}

/**
 * Marks a source whose fingerprint is its authorization state rather than its
 * bytes. Two things rule out an mtime on a grant file: the SDK writes discovery
 * and client-registration into it during a *failed* connect, so the file exists
 * well before anyone logs in; and it rewrites the whole file on every silent
 * token refresh, which would re-enumerate every server about once an hour for a
 * change the catalog cannot see.
 */
const AUTH = "auth:";

/**
 * Fingerprints every source. `previous` is the catalog's own record, which lets
 * a content-fingerprinted file whose stat has not moved skip being re-read.
 */
async function fingerprint(
  files: string[],
  cwd: string,
  previous: Record<string, string> = {},
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await Promise.all(
    [...new Set(files)].map(async (key) => {
      if (key.startsWith(AUTH)) {
        out[key] = (await hasAccessToken(key.slice(AUTH.length))) ? "granted" : "none";
        return;
      }
      const select = catalogInputs(key);
      if (select) {
        out[key] = await contentFingerprint(key, select, cwd, previous[key]);
        return;
      }
      try {
        const s = await stat(key);
        out[key] = `${s.mtimeMs}:${s.size}`;
      } catch {
        out[key] = "missing";
      }
    }),
  );
  return out;
}

/**
 * Harness files that are mostly *not* about MCP servers, and the parts of them
 * the catalog actually reads.
 *
 * Claude Code rewrites ~/.claude.json every few minutes — startup counters,
 * tips, per-project history — and an mtime fingerprint turned each of those
 * writes into a full rebuild that reconnected to every server, with the next
 * search blocked behind it. These two files are fingerprinted by the inputs
 * the importers and the .mcp.json trust check read from them (config/adapters/
 * claude.ts, workspace/trust.ts), so only a change to those invalidates the
 * catalog. Everything else keeps the plain stat fingerprint: its contents are
 * catalog input as a whole.
 */
function catalogInputs(path: string): ((doc: any, cwd: string) => Promise<unknown>) | undefined {
  const home = homeDir();
  if (path === join(home, ".claude.json")) return claudeJsonInputs;
  if (path === join(home, ".claude", "settings.json")) return settingsInputs;
  return undefined;
}

/** What loadClaude, mcpjsonApproval and adopt read from ~/.claude.json for `cwd`. */
async function claudeJsonInputs(doc: any, cwd: string): Promise<unknown> {
  const projects = doc?.projects;
  // loadClaude looks the project up by cwd as given, trust.ts by its resolved
  // form and by the main checkout of a linked worktree.
  const keys = [...new Set([cwd, resolve(cwd), await mainCheckout(cwd)])].sort();
  return {
    mcpServers: doc?.mcpServers,
    projects: keys.map((k) => {
      const p = projects?.[k];
      return [
        k,
        p && {
          mcpServers: p.mcpServers,
          hasTrustDialogAccepted: p.hasTrustDialogAccepted,
          enabledMcpjsonServers: p.enabledMcpjsonServers,
          enableAllProjectMcpServers: p.enableAllProjectMcpServers,
        },
      ];
    }),
  };
}

/** The .mcp.json approvals trust.ts reads from ~/.claude/settings.json. */
async function settingsInputs(doc: any): Promise<unknown> {
  return {
    enabledMcpjsonServers: doc?.enabledMcpjsonServers,
    enableAllProjectMcpServers: doc?.enableAllProjectMcpServers,
  };
}

/** The last digest computed per file and cwd, so a changed stat is hashed once, not per check. */
const digests = new Map<string, { stat: string; value: string }>();

/**
 * `<mtime>:<size>#<digest of the catalog inputs>`.
 *
 * The stat is kept so an untouched file is never read: an unchanged stat
 * returns the recorded value as is. When it has moved, only the digest is
 * compared (see sameSource). A file that cannot be parsed gets the bare stat,
 * which never equals a digest — so breaking the file, and later fixing it,
 * both read as changes, as they would have before.
 */
async function contentFingerprint(
  path: string,
  select: (doc: any, cwd: string) => Promise<unknown>,
  cwd: string,
  previous: string | undefined,
): Promise<string> {
  let st: string;
  try {
    const s = await stat(path);
    st = `${s.mtimeMs}:${s.size}`;
  } catch {
    return "missing";
  }
  if (previous?.startsWith(`${st}#`)) return previous;
  const memoKey = `${path}\0${cwd}`;
  const memo = digests.get(memoKey);
  if (memo?.stat === st) return memo.value;

  let value = st;
  const text = await readText(path);
  const doc = text === null ? undefined : parseLenient(text);
  if (doc !== undefined) {
    const digest = createHash("sha256")
      .update(canonical(await select(doc, cwd)))
      .digest("hex")
      .slice(0, 16);
    value = `${st}#${digest}`;
  }
  digests.set(memoKey, { stat: st, value });
  return value;
}

/** readJson's reading of a file (empty is null), but undefined for unparseable. */
function parseLenient(text: string): unknown {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    try {
      return JSON.parse(stripJsonComments(text));
    } catch {
      return undefined;
    }
  }
}

/** JSON with sorted keys, so a rewrite that only reorders keys is not a change. */
function canonical(value: unknown): string {
  return (
    JSON.stringify(value, (_key, v) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]))
        : v,
    ) ?? "null"
  );
}

/** Whether a recorded fingerprint still holds; content fingerprints compare by digest alone. */
function sameSource(recorded: string, current: string | undefined): boolean {
  if (current === undefined) return false;
  if (recorded === current) return true;
  const a = recorded.indexOf("#");
  const b = current.indexOf("#");
  return a !== -1 && b !== -1 && recorded.slice(a) === current.slice(b);
}

async function hasAccessToken(path: string): Promise<boolean> {
  const text = await readText(path);
  if (!text) return false;
  try {
    return Boolean((JSON.parse(text) as { tokens?: { access_token?: string } }).tokens?.access_token);
  } catch {
    return false;
  }
}

export async function loadCatalog(cwd: string): Promise<Catalog | null> {
  const text = await readText(catalogPath(cwd));
  if (!text) return null;
  try {
    const catalog = JSON.parse(text) as Catalog;
    return catalog.version === CATALOG_VERSION && catalog.cwd === cwd ? catalog : null;
  } catch {
    return null;
  }
}

export async function saveCatalog(catalog: Catalog): Promise<void> {
  await ensureDir(cacheDir());
  const path = catalogPath(catalog.cwd);
  await writeText(path, JSON.stringify(catalog));
  await pruneCatalogs(path);
}

/** A catalog untouched this long belongs to a directory nobody works in any more. */
const CATALOG_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Deletes per-directory catalogs that have not been written in a month.
 *
 * One file accrues per directory the router ever ran in, and nothing removed
 * them — the catalogPath rename alone orphaned every file written before it.
 * A deleted catalog costs only a rebuild, which a month-old one (well past
 * the TTL) needed anyway. Best effort: only `catalog-*.json` is touched, never
 * `keep`, and a failure is ignored, since another router may be pruning too.
 */
export async function pruneCatalogs(
  keep: string,
  now = Date.now(),
  maxAgeMs = CATALOG_MAX_AGE_MS,
): Promise<string[]> {
  const removed: string[] = [];
  try {
    const dir = cacheDir();
    for (const name of await readdir(dir)) {
      if (!/^catalog-.*\.json$/.test(name) || name === basename(keep)) continue;
      const file = join(dir, name);
      try {
        const st = await stat(file);
        if (!st.isFile() || now - st.mtimeMs < maxAgeMs) continue;
        await rm(file, { force: true });
        removed.push(file);
      } catch {
        // Raced with another router's prune; nothing to do.
      }
    }
  } catch {
    // No cache dir yet, or one we cannot list.
  }
  return removed;
}

/**
 * A catalog is stale when it has aged past the TTL or any indexed source file
 * changed. Server tool lists can change without any local file changing, which
 * is what the TTL covers.
 */
export async function isStale(catalog: Catalog, ttlSec: number): Promise<boolean> {
  if (Date.now() - catalog.builtAt > ttlSec * 1000) return true;
  const current = await fingerprint(Object.keys(catalog.sources), catalog.cwd, catalog.sources);
  for (const [file, fp] of Object.entries(catalog.sources)) {
    if (!sameSource(fp, current[file])) return true;
  }
  return false;
}

/**
 * Returns a usable catalog, rebuilding in the background when merely stale.
 *
 * `rebuilding` is that background build (already saving itself to disk). A
 * caller that will want the fresh catalog adopts it instead of building again:
 * `serve` used to run this build, ignore its result, and then rebuild a second
 * time on the first search because the catalog it held was still the stale one.
 * One-shot commands drop it, as before — it finishes if the process lives long
 * enough and leaves a fresh catalog for the next run.
 */
export async function getCatalog(
  resolved: ResolvedConfig,
  opts: { force?: boolean } & BuildOptions = {},
): Promise<{ catalog: Catalog; rebuilding: Promise<Catalog> | null }> {
  if (!opts.force) {
    const cached = await loadCatalog(resolved.cwd);
    if (cached && !(await isStale(cached, resolved.config.cacheTtlSec))) return { catalog: cached, rebuilding: null };
    if (cached) {
      // Serve the stale catalog now, refresh for next time.
      const rebuilding = buildCatalog(resolved).then(async (fresh) => {
        await saveCatalog(fresh);
        return fresh;
      });
      // Nobody may ever await it; its failure must not surface as unhandled.
      rebuilding.catch(() => {});
      return { catalog: cached, rebuilding };
    }
  }
  const fresh = await buildCatalog(resolved, { reuse: opts.reuse });
  await saveCatalog(fresh);
  return { catalog: fresh, rebuilding: null };
}
