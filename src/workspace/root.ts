import { readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homeDir } from "../util/paths.ts";

/**
 * Where the session is working.
 *
 * Claude Code answers roots/list with its launch directory (plus any
 * --add-dir directories), which is the only reliable signal: an MCP stdio
 * server's own cwd is whatever the harness happened to spawn it with.
 * CLAUDE_PROJECT_DIR is the next best thing, and process.cwd() the last resort.
 */
export function workspaceRoot(roots: string[] = []): string {
  const first = roots.map(rootToPath).find((p): p is string => Boolean(p));
  if (first) return first;
  const env = process.env.CLAUDE_PROJECT_DIR;
  if (env) return resolve(env);
  return process.cwd();
}

/** MCP roots are file:// URIs; anything else is not a directory we can read. */
export function rootToPath(uri: string): string | null {
  if (!uri) return null;
  if (uri.startsWith("file://")) {
    try {
      return fileURLToPath(uri);
    } catch {
      return null;
    }
  }
  return uri.startsWith("/") ? uri : null;
}

/** The enclosing git work tree, or null outside one. `.git` may be a file (worktrees). */
export async function gitRoot(dir: string): Promise<string | null> {
  let current = resolve(dir);
  for (;;) {
    try {
      await stat(join(current, ".git"));
      return current;
    } catch {}
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * `dir` and each parent up to the git root, nearest first.
 *
 * This is the set of directories Claude Code reads project skills from at
 * startup. Outside a repo it is just `dir`: walking further would reach the
 * home directory, whose .claude/skills are user skills, not project ones.
 */
export async function projectDirs(dir: string): Promise<string[]> {
  const start = resolve(dir);
  const top = await gitRoot(start);
  if (!top) return [start];
  const out: string[] = [];
  let current = start;
  for (;;) {
    out.push(current);
    if (current === top) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return out;
}

/** True when `dir` is the home directory, where ".claude" means user scope. */
export function isHome(dir: string): boolean {
  return resolve(dir) === resolve(homeDir());
}

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "coverage",
  ".git",
  ".next",
  ".turbo",
  ".venv",
  "venv",
  "__pycache__",
]);

/**
 * Every `<subdir>/.claude/skills` below `top`, excluding `top` itself.
 *
 * Claude Code only loads these once it touches a file in that subdirectory, so
 * a monorepo's per-app skills are invisible from its root. The router can index
 * them up front at no context cost. Bounded in depth and in directories
 * visited, because this runs on every catalog build of arbitrarily large repos.
 */
export async function nestedSkillDirs(
  top: string,
  opts: { maxDepth?: number; maxDirs?: number } = {},
): Promise<string[]> {
  const maxDepth = opts.maxDepth ?? 4;
  let budget = opts.maxDirs ?? 2000;
  const out: string[] = [];
  const walk = async (dir: string, depth: number) => {
    if (depth > maxDepth || budget <= 0) return;
    budget--;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === ".claude") {
        if (depth > 0) {
          const skills = join(dir, ".claude", "skills");
          try {
            if ((await stat(skills)).isDirectory()) out.push(skills);
          } catch {}
        }
        continue;
      }
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      await walk(join(dir, entry.name), depth + 1);
    }
  };
  await walk(top, 0);
  return out.sort();
}
