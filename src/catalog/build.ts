import { join } from "node:path";
import { stat } from "node:fs/promises";
import type { ResolvedConfig } from "../config/resolve.ts";
import type { Catalog, Capability } from "./types.ts";
import { CATALOG_VERSION, matchesPattern } from "./types.ts";
import { collectSkills } from "./providers/skills.ts";
import { collectPluginAssets } from "./providers/plugins.ts";
import { connect, enumerateServer } from "./providers/mcp.ts";
import { cacheDir } from "../util/paths.ts";
import { ensureDir, readText, writeText } from "../util/fs.ts";
import { authHint, authPath } from "../config/oauth.ts";

export function catalogPath(cwd: string): string {
  const slug = cwd.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, "").slice(-80);
  return join(cacheDir(), `catalog-${slug}.json`);
}

export async function buildCatalog(resolved: ResolvedConfig): Promise<Catalog> {
  const { config, servers, cwd, configPath } = resolved;
  const capabilities: Capability[] = [];
  const errors: Record<string, string> = {};
  const sourceFiles: string[] = configPath ? [configPath] : [];

  // A grant is a real input to the catalog: an unauthorized server contributes
  // zero capabilities, so obtaining a token changes the result as surely as
  // editing the config does. Tracking that is what makes `autorouter login`
  // visible to a running serve process — the alternative is waiting out the
  // 6-hour TTL while the model is told the tool does not exist.
  sourceFiles.push(
    ...servers.filter((s) => s.transport === "http").map((s) => `${AUTH}${authPath(s.name)}`),
  );

  const skills = await collectSkills(config.skillPaths, cwd, {
    includePlugins: config.import.includes("plugins"),
  });
  capabilities.push(...skills.capabilities);
  sourceFiles.push(...skills.sources);

  const pluginAssets = await collectPluginAssets();
  capabilities.push(...pluginAssets.capabilities);
  sourceFiles.push(...pluginAssets.sources);

  // Servers are enumerated concurrently; one bad server must not block the rest.
  const results = await Promise.all(
    servers.map(async (entry) => {
      let client;
      try {
        client = await connect(entry);
        return { entry, caps: await enumerateServer(entry, client) };
      } catch (err) {
        return { entry, error: authHint(entry.name, err) };
      } finally {
        try {
          await client?.close();
        } catch {}
      }
    }),
  );
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
    sources: await fingerprint(sourceFiles),
    capabilities: filtered,
    errors,
  };
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

async function fingerprint(files: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await Promise.all(
    [...new Set(files)].map(async (key) => {
      if (key.startsWith(AUTH)) {
        out[key] = (await hasAccessToken(key.slice(AUTH.length))) ? "granted" : "none";
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
    return catalog.version === CATALOG_VERSION ? catalog : null;
  } catch {
    return null;
  }
}

export async function saveCatalog(catalog: Catalog): Promise<void> {
  await ensureDir(cacheDir());
  await writeText(catalogPath(catalog.cwd), JSON.stringify(catalog));
}

/**
 * A catalog is stale when it has aged past the TTL or any indexed source file
 * changed. Server tool lists can change without any local file changing, which
 * is what the TTL covers.
 */
export async function isStale(catalog: Catalog, ttlSec: number): Promise<boolean> {
  if (Date.now() - catalog.builtAt > ttlSec * 1000) return true;
  const current = await fingerprint(Object.keys(catalog.sources));
  for (const [file, fp] of Object.entries(catalog.sources)) {
    if (current[file] !== fp) return true;
  }
  return false;
}

/** Returns a usable catalog, rebuilding in the background when merely stale. */
export async function getCatalog(
  resolved: ResolvedConfig,
  opts: { force?: boolean } = {},
): Promise<Catalog> {
  if (!opts.force) {
    const cached = await loadCatalog(resolved.cwd);
    if (cached && !(await isStale(cached, resolved.config.cacheTtlSec))) return cached;
    if (cached) {
      // Serve the stale catalog now, refresh for next time.
      void buildCatalog(resolved).then(saveCatalog).catch(() => {});
      return cached;
    }
  }
  const fresh = await buildCatalog(resolved);
  await saveCatalog(fresh);
  return fresh;
}
