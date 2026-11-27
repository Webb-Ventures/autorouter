import { readFile, writeFile, readdir, stat, lstat, mkdir, realpath, rename, rm, chmod } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * Bun-free filesystem helpers. The router is bundled for the Node target so it
 * can be launched with npx from harnesses (Codex, Cursor) where Bun may not be
 * installed, so nothing below may use Bun.file / Bun.Glob.
 */

export async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Replaces a file's contents atomically.
 *
 * These are other programs' config files (~/.claude.json, settings.json,
 * config.toml) as well as the router's own. Writing in place truncates first,
 * so an interrupt — or another process reading at that moment — sees an empty
 * or half-written file. The new contents go to a sibling temp file and are
 * renamed over the target instead.
 *
 * The rename lands on the file a symlink points at, not on the link: configs
 * managed by a dotfiles tool are links, and replacing one with a regular file
 * would detach it. The target's permissions are kept.
 */
export async function writeText(path: string, contents: string): Promise<void> {
  let target = path;
  let mode: number | undefined;
  try {
    target = await realpath(path);
    mode = (await stat(target)).mode & 0o777;
  } catch {
    // Missing: created below. A dangling link is written through in place, so
    // the file appears where the link points.
    const link = await lstat(path).catch(() => null);
    if (link?.isSymbolicLink()) return void (await writeFile(path, contents, "utf8"));
  }

  const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.${Date.now().toString(36)}.tmp`);
  try {
    await writeFile(tmp, contents, { encoding: "utf8", mode: mode ?? 0o666 });
    if (mode !== undefined) await chmod(tmp, mode);
    await rename(tmp, target);
  } catch {
    await rm(tmp, { force: true }).catch(() => {});
    // A directory that cannot take a new file, or a target another process
    // holds open on Windows. The in-place write is still better than failing.
    await writeFile(path, contents, "utf8");
  }
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

/** Recursive search for files with an exact basename, e.g. "SKILL.md". */
export async function findByName(
  root: string,
  filename: string,
  maxDepth = 4,
): Promise<string[]> {
  const out: string[] = [];
  // Skill managers install by symlinking into ~/.claude/skills, and a Dirent
  // for a symlink reports isDirectory() === false however it points. Following
  // links is therefore required, not a nicety — but it also makes cycles
  // possible, so visited real paths are tracked.
  const visited = new Set<string>();
  const walk = async (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    let key: string;
    try {
      key = await realpath(dir);
    } catch {
      return;
    }
    if (visited.has(key)) return;
    visited.add(key);

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = join(dir, entry.name);
      if (entry.name === filename && !entry.isDirectory()) {
        out.push(full);
        continue;
      }
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isSymbolicLink()) {
        // Resolve to decide: a link may point at either a dir or the file.
        try {
          if ((await stat(full)).isDirectory()) await walk(full, depth + 1);
        } catch {
          // Broken link — skip it rather than fail the whole scan.
        }
      }
    }
  };
  await walk(root, 0);
  return out;
}

/** Non-recursive listing of files matching an extension. */
export async function listFiles(root: string, ext: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(ext))
    .map((e) => join(root, e.name));
}
