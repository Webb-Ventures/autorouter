import { join } from "node:path";
import { DEFAULT_CONFIG, type RouterConfig, type ServerEntry } from "./types.ts";
import { homeDir, absPath, readJson } from "../util/paths.ts";
import { loadClaude } from "./adapters/claude.ts";
import { loadCursor, loadVscode } from "./adapters/cursor.ts";
import { loadCodex } from "./adapters/codex.ts";
import { loadPluginServers } from "./adapters/plugins.ts";
import { isSelfReference, normalizeServer, specKey } from "./adapters/shared.ts";

export type ResolvedConfig = {
  config: RouterConfig;
  servers: ServerEntry[];
  configPath: string | null;
  cwd: string;
};

function configCandidates(cwd: string): string[] {
  const explicit = process.env.AUTOROUTER_CONFIG;
  return [
    ...(explicit ? [absPath(explicit, cwd)] : []),
    join(cwd, ".autorouter.json"),
    join(cwd, "autorouter.json"),
    join(homeDir(), ".config", "autorouter", "config.json"),
    join(homeDir(), ".autorouter.json"),
  ];
}

/** Drops keys whose value is undefined so they cannot shadow a default. */
function pruneUndefined<T extends object>(o: T | null | undefined): Partial<T> {
  if (!o) return {};
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export async function resolveConfig(cwd = process.cwd()): Promise<ResolvedConfig> {
  let user: Partial<RouterConfig> | null = null;
  let configPath: string | null = null;
  for (const candidate of configCandidates(cwd)) {
    const loaded = await readJson<Partial<RouterConfig>>(candidate);
    if (loaded) {
      user = loaded;
      configPath = candidate;
      break;
    }
  }

  // Spreading `user` wholesale would let a key that is merely *present* and
  // undefined blank a default — and `adopt` writes a config containing only
  // `servers`, which is exactly that case. Take a user value only when it is
  // actually set, so omitting a key means "keep the default" rather than
  // "disable it". `servers` is the one exception: it is purely additive and has
  // no meaningful default.
  const config: RouterConfig = {
    ...DEFAULT_CONFIG,
    ...pruneUndefined(user),
    selector: { ...DEFAULT_CONFIG.selector, ...pruneUndefined(user?.selector) },
    embeddings: { ...DEFAULT_CONFIG.embeddings, ...pruneUndefined(user?.embeddings) },
    servers: { ...user?.servers },
  };

  applyEnvOverrides(config);

  const imported: ServerEntry[] = [];
  const loaders: Record<string, () => Promise<ServerEntry[]>> = {
    claude: () => loadClaude(cwd),
    cursor: () => loadCursor(cwd),
    vscode: () => loadVscode(cwd),
    codex: () => loadCodex(cwd),
    plugins: () => loadPluginServers(),
  };
  for (const name of config.import) {
    const load = loaders[name];
    if (!load) continue;
    try {
      imported.push(...(await load()));
    } catch {
      // A broken harness config must not take the router down.
    }
  }

  for (const [name, raw] of Object.entries(config.servers)) {
    const entry = normalizeServer(name, raw as any, "config");
    if (entry) imported.push(entry);
  }

  return { config, servers: dedupeServers(imported), configPath, cwd };
}

/**
 * Env overrides let a harness pin router behaviour in its own server entry
 * (written by `autorouter init`) without a shared config file that would apply
 * to every harness at once.
 */
function applyEnvOverrides(config: RouterConfig): void {
  const env = process.env;
  if (env.AUTOROUTER_IMPORT) {
    config.import = env.AUTOROUTER_IMPORT.split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (env.AUTOROUTER_SELECTOR_MODEL) config.selector.model = env.AUTOROUTER_SELECTOR_MODEL;
  if (env.AUTOROUTER_SELECTOR_PROVIDER) {
    config.selector.provider = env.AUTOROUTER_SELECTOR_PROVIDER as RouterConfig["selector"]["provider"];
  }
  if (env.AUTOROUTER_SELECTOR_MODE) {
    config.selector.mode = env.AUTOROUTER_SELECTOR_MODE as RouterConfig["selector"]["mode"];
  }
  if (env.AUTOROUTER_SELECTOR_BASE_URL) config.selector.baseUrl = env.AUTOROUTER_SELECTOR_BASE_URL;
  if (env.AUTOROUTER_EMBEDDINGS_PROVIDER) {
    config.embeddings.provider = env.AUTOROUTER_EMBEDDINGS_PROVIDER as RouterConfig["embeddings"]["provider"];
  }
  if (env.AUTOROUTER_EMBEDDINGS_MODEL) config.embeddings.model = env.AUTOROUTER_EMBEDDINGS_MODEL;
}

/**
 * The same server is usually registered in several harnesses at once. Collapse
 * by launch command (not by name, since names differ across configs) and drop
 * anything that would re-launch this router.
 */
export function dedupeServers(entries: ServerEntry[]): ServerEntry[] {
  const byKey = new Map<string, ServerEntry>();
  const usedNames = new Set<string>();
  for (const entry of entries) {
    if (entry.disabled || isSelfReference(entry)) continue;
    const key = specKey(entry);
    const existing = byKey.get(key);
    if (existing) {
      // Prefer the shorter, more canonical name; record both origins.
      if (entry.name.length < existing.name.length) {
        usedNames.delete(existing.name);
        byKey.set(key, { ...entry, origin: `${existing.origin}+${entry.origin}` });
        usedNames.add(entry.name);
      } else if (!existing.origin.includes(entry.origin)) {
        existing.origin = `${existing.origin}+${entry.origin}`;
      }
      continue;
    }
    let name = entry.name;
    let n = 2;
    while (usedNames.has(name)) name = `${entry.name}-${n++}`;
    usedNames.add(name);
    byKey.set(key, { ...entry, name });
  }
  return [...byKey.values()];
}
