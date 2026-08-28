import { homedir } from "node:os";
import { resolve, isAbsolute, join } from "node:path";
import { readText } from "./fs.ts";

/**
 * The single home-directory lookup for the whole router.
 *
 * Bun's os.homedir() reads the OS passwd entry and ignores $HOME, so a test
 * that sets HOME does *not* sandbox anything — code that writes to harness
 * configs would happily rewrite the developer's real ~/.claude.json. Every
 * home-relative path therefore goes through here, and $AUTOROUTER_HOME is the
 * one supported way to redirect it (tests, fixtures, containers).
 */
export function homeDir(): string {
  const override = process.env.AUTOROUTER_HOME;
  if (override) return isAbsolute(override) ? override : resolve(process.cwd(), override);
  return process.env.HOME || homedir();
}

export function expandHome(p: string): string {
  if (p === "~") return homeDir();
  if (p.startsWith("~/")) return join(homeDir(), p.slice(2));
  return p;
}

export function absPath(p: string, base = process.cwd()): string {
  const e = expandHome(p);
  return isAbsolute(e) ? e : resolve(base, e);
}

export function cacheDir(): string {
  return process.env.AUTOROUTER_CACHE_DIR
    ? absPath(process.env.AUTOROUTER_CACHE_DIR)
    : join(homeDir(), ".cache", "autorouter");
}

export async function readJson<T>(path: string): Promise<T | null> {
  const text = await readText(path);
  if (!text || !text.trim()) return null;
  try {
    return JSON.parse(stripJsonComments(text)) as T;
  } catch {
    return null;
  }
}

/** Tolerates the // and /* *\/ comments that VS Code / Cursor configs allow. */
export function stripJsonComments(text: string): string {
  let out = "";
  let inStr = false;
  let esc = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const n = text[i + 1];
    if (inLine) {
      if (c === "\n") { inLine = false; out += c; }
      continue;
    }
    if (inBlock) {
      if (c === "*" && n === "/") { inBlock = false; i++; }
      continue;
    }
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === "/" && n === "/") { inLine = true; i++; continue; }
    if (c === "/" && n === "*") { inBlock = true; i++; continue; }
    out += c;
  }
  return out;
}
