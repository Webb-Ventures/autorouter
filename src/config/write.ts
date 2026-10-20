import { join } from "node:path";
import { ensureDir, exists, readText, writeText } from "../util/fs.ts";
import { homeDir, stripJsonComments } from "../util/paths.ts";

/**
 * Writes to the router's own config.
 *
 * Everything that registers a server ends up here — `adopt` moving a harness's
 * entries out, and `add` putting a new one in — so the file is parsed, merged
 * and rewritten in exactly one place. The config is hand-editable and often
 * commented, hence `stripJsonComments` on the way in; comments do not survive a
 * rewrite, which is the accepted cost of being able to write it at all.
 */
export function routerConfigPath(existingPath: string | null): string {
  return existingPath ?? join(homeDir(), ".config", "autorouter", "config.json");
}

async function read(path: string): Promise<Record<string, any>> {
  if (!(await exists(path))) return {};
  try {
    return JSON.parse(stripJsonComments((await readText(path)) ?? "{}"));
  } catch {
    // A config too broken to parse is not a config to merge into. Returning {}
    // would silently discard every other setting in it on the next write.
    throw new Error(`${path} is not valid JSON — fix it before writing to it.`);
  }
}

/**
 * Registers servers, returning the path written.
 *
 * `overwrite` is the difference between the two callers. Adopt moves a whole
 * harness at once and must not clobber an entry the user tuned by hand, so an
 * existing entry wins. Add names one server explicitly, which is an instruction
 * rather than a merge — silently keeping the old spec there would look like the
 * command did nothing.
 */
export async function upsertServers(
  servers: Record<string, unknown>,
  opts: { configPath: string | null; overwrite?: boolean },
): Promise<string> {
  const path = routerConfigPath(opts.configPath);
  await ensureDir(join(path, ".."));
  const config = await read(path);
  config.servers = opts.overwrite
    ? { ...config.servers, ...servers }
    : { ...servers, ...config.servers };
  await writeText(path, `${JSON.stringify(config, null, 2)}\n`);
  return path;
}

/** Removes a server. False when there was nothing by that name to remove. */
export async function removeServer(
  name: string,
  configPath: string | null,
): Promise<{ removed: boolean; path: string }> {
  const path = routerConfigPath(configPath);
  const config = await read(path);
  if (!config.servers || !(name in config.servers)) return { removed: false, path };
  delete config.servers[name];
  await writeText(path, `${JSON.stringify(config, null, 2)}\n`);
  return { removed: true, path };
}

/**
 * Registers servers that belong to one project (config.projects[root]).
 *
 * A server registered for a single repo must stay scoped to it. Writing it into
 * the top-level `servers` — which is what adopt used to do — made a repo's
 * servers reachable from every other project the router ran in.
 */
export async function upsertProjectServers(
  root: string,
  servers: Record<string, unknown>,
  opts: { configPath: string | null },
): Promise<string> {
  const path = routerConfigPath(opts.configPath);
  await ensureDir(join(path, ".."));
  const config = await read(path);
  config.projects = { ...config.projects };
  const current = config.projects[root] ?? {};
  config.projects[root] = { ...current, servers: { ...servers, ...current.servers } };
  await writeText(path, `${JSON.stringify(config, null, 2)}\n`);
  return path;
}

/** Removes several top-level servers at once; returns the names actually removed. */
export async function removeServers(names: string[], configPath: string | null): Promise<string[]> {
  const path = routerConfigPath(configPath);
  const config = await read(path);
  const removed = names.filter((n) => config.servers && n in config.servers);
  if (!removed.length) return [];
  for (const n of removed) delete config.servers[n];
  await writeText(path, `${JSON.stringify(config, null, 2)}\n`);
  return removed;
}
