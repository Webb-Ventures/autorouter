import { readFile, writeFile, readdir, stat, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";

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

export async function writeText(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, "utf8");
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
