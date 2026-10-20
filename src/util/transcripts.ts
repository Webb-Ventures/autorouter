import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { homeDir } from "./paths.ts";

/**
 * Claude Code's session transcripts: one JSONL file per session under
 * ~/.claude/projects/<slug>/. The format is internal to Claude Code and moves
 * between releases, so everything here reads defensively — a line that does
 * not parse, or an entry type we do not know, is counted and skipped rather
 * than treated as an error.
 */

export type TranscriptFile = { path: string; project: string; mtimeMs: number; size: number };

export function projectsDir(): string {
  return join(homeDir(), ".claude", "projects");
}

/** Claude Code's directory name for a project: every non-alphanumeric becomes "-". */
export function projectSlug(dir: string): string {
  return dir.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * Transcript files, oldest first. `days` filters on mtime — the only place a
 * wall clock enters, since it decides which files count, never what they say.
 */
export async function listTranscripts(
  opts: { days?: number; project?: string; now?: number; limit?: number } = {},
): Promise<TranscriptFile[]> {
  const root = projectsDir();
  let projects: string[];
  try {
    projects = (await readdir(root)).sort();
  } catch {
    return [];
  }
  const slug = opts.project ? projectSlug(opts.project) : null;
  const cutoff = opts.days ? (opts.now ?? Date.now()) - opts.days * 86_400_000 : 0;
  const out: TranscriptFile[] = [];
  for (const project of projects) {
    if (slug && project !== slug) continue;
    let names: string[];
    try {
      names = await readdir(join(root, project));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(root, project, name);
      try {
        const s = await stat(path);
        if (!s.isFile() || s.mtimeMs < cutoff) continue;
        out.push({ path, project, mtimeMs: s.mtimeMs, size: s.size });
      } catch {
        // Deleted between readdir and stat.
      }
    }
  }
  out.sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
  return opts.limit ? out.slice(-opts.limit) : out;
}

/** Substrings a line must contain to be worth parsing at all. */
export type LineFilter = (line: string) => boolean;

/**
 * Streams a transcript's entries. Lines that fail the cheap substring filter are
 * never parsed, which is what keeps a gigabyte of transcripts tractable: most of
 * the bulk is bookkeeping entries (titles, modes, file snapshots) no report needs.
 */
export async function eachEntry(
  path: string,
  filter: LineFilter,
  visit: (entry: any) => void,
): Promise<{ parsed: number; unparsed: number }> {
  let parsed = 0;
  let unparsed = 0;
  const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line || !filter(line)) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      unparsed++;
      continue;
    }
    if (!entry || typeof entry !== "object") {
      unparsed++;
      continue;
    }
    parsed++;
    visit(entry);
  }
  return { parsed, unparsed };
}

export type HookRun = { command: string; event: string; stdoutBytes: number };

/** `hook_success` attachments: what each hook printed, per run. */
export function hookRunOf(entry: any): HookRun | null {
  if (entry?.type !== "attachment") return null;
  const a = entry.attachment;
  if (!a || a.type !== "hook_success") return null;
  const command = typeof a.command === "string" ? a.command : "";
  const event = typeof a.hookName === "string" ? a.hookName : typeof a.hookEvent === "string" ? a.hookEvent : "?";
  const stdout = typeof a.stdout === "string" ? a.stdout : typeof a.content === "string" ? a.content : "";
  return { command, event, stdoutBytes: Buffer.byteLength(stdout) };
}

/** Hook runs from the most recent transcripts, for doctor — a sample, not a census. */
export async function recentHookRuns(opts: { files?: number; days?: number } = {}): Promise<HookRun[]> {
  const files = await listTranscripts({ days: opts.days ?? 14, limit: opts.files ?? 40 });
  const runs: HookRun[] = [];
  for (const f of files) {
    try {
      await eachEntry(f.path, (l) => l.includes('"hook_success"'), (e) => {
        const run = hookRunOf(e);
        if (run) runs.push(run);
      });
    } catch {
      // Unreadable file: skip.
    }
  }
  return runs;
}

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function quantile(xs: number[], q: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))]!;
}
