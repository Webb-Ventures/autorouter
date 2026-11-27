import { existsSync, readdirSync, statSync } from "node:fs";
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

/**
 * One Claude Code install: its config directory and its global state file.
 *
 * Claude Code reads everything from one directory — settings.json, skills/,
 * plugins/, projects/ (transcripts), CLAUDE.md — which is `$CLAUDE_CONFIG_DIR`
 * when that is set and `~/.claude` otherwise. The global state file holding
 * `mcpServers` and `projects` follows a different rule: it is
 * `join($CLAUDE_CONFIG_DIR || $HOME, ".claude.json")`, so the default install
 * keeps it *beside* ~/.claude, while every other install keeps it *inside* its
 * own dir. (Claude Code also still reads a legacy `<dir>/.config.json` when
 * that exists and `.claude.json` does not; so does this.)
 */
export type ClaudeInstall = {
  /** The config directory: settings.json, skills/, plugins/, projects/. */
  dir: string;
  /** The global state file with mcpServers and projects[cwd]. */
  claudeJson: string;
  /** True for the install Claude Code uses when CLAUDE_CONFIG_DIR is unset. */
  isDefault: boolean;
};

/** `~/.claude`, the config dir Claude Code uses when CLAUDE_CONFIG_DIR is unset. */
export function defaultClaudeDir(): string {
  return join(homeDir(), ".claude");
}

/**
 * $CLAUDE_CONFIG_DIR, resolved — or null when unset.
 *
 * Under $AUTOROUTER_HOME (the test and fixture sandbox) a CLAUDE_CONFIG_DIR
 * that points outside the sandbox is ignored. Otherwise running the suite from
 * a shell launched by a non-default install would rewrite that install's real
 * configs — the exact failure AUTOROUTER_HOME exists to prevent.
 */
export function envClaudeDir(): string | null {
  const raw = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (!raw) return null;
  const dir = absPath(raw);
  if (process.env.AUTOROUTER_HOME) {
    const home = homeDir();
    if (dir !== home && !dir.startsWith(`${home}/`)) return null;
  }
  return dir;
}

/**
 * The install a Claude path resolves against. With no argument, the active
 * one — whatever CLAUDE_CONFIG_DIR says, as Claude Code would read it. With a
 * directory, that install, as if Claude Code were launched with
 * CLAUDE_CONFIG_DIR=dir — except that `~/.claude` named without the variable
 * set is the default install, whose state file is `~/.claude.json`.
 */
export function claudeInstall(dir?: string): ClaudeInstall {
  const fromEnv = envClaudeDir();
  const target = dir ? stripSlash(absPath(dir)) : (fromEnv ?? defaultClaudeDir());
  const viaEnv = fromEnv !== null && stripSlash(fromEnv) === target;
  const isDefault = target === defaultClaudeDir() && !viaEnv;
  const primary = join(isDefault ? homeDir() : target, ".claude.json");
  const legacy = join(target, ".config.json");
  const claudeJson = !existsSync(primary) && existsSync(legacy) ? legacy : primary;
  return { dir: target, claudeJson, isDefault };
}

export function claudeSettingsPath(install: ClaudeInstall = claudeInstall()): string {
  return join(install.dir, "settings.json");
}

/**
 * Rewrites a `~/.claude/...` path onto `install`'s dir. The default skill path
 * is spelled `~/.claude/skills` in configs; for another install the same
 * setting means that install's own skills folder.
 */
export function inClaudeDir(p: string, install: ClaudeInstall = claudeInstall()): string {
  const m = /^~\/\.claude(\/.*)?$/.exec(p);
  if (!m) return p;
  return join(install.dir, m[1] ?? "");
}

/**
 * Directories under $HOME that look like Claude Code installs: `~/.claude`
 * and every `~/.claude-*` / `~/.claude*` directory holding a settings.json or a
 * .claude.json. The default install comes first; the rest sort by name.
 */
export function discoverClaudeInstalls(): ClaudeInstall[] {
  const home = homeDir();
  let names: string[];
  try {
    names = readdirSync(home);
  } catch {
    return [];
  }
  const out: ClaudeInstall[] = [];
  for (const name of names.sort()) {
    if (!name.startsWith(".claude")) continue;
    const dir = join(home, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const install = claudeInstall(dir);
    const real =
      existsSync(join(dir, "settings.json")) ||
      existsSync(join(dir, ".claude.json")) ||
      (install.isDefault && existsSync(install.claudeJson));
    if (real) out.push(install);
  }
  return out.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
}

/** A short label for an install in output: "~/.claude-bts". */
export function installLabel(install: ClaudeInstall): string {
  const home = homeDir();
  return install.dir.startsWith(`${home}/`) ? `~/${install.dir.slice(home.length + 1)}` : install.dir;
}

function stripSlash(p: string): string {
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
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
