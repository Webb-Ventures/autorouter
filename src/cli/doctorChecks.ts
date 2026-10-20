import { join } from "node:path";
import { homeDir, readJson } from "../util/paths.ts";
import { readText } from "../util/fs.ts";
import { run } from "../util/proc.ts";
import { median, type HookRun } from "../util/transcripts.ts";
import { fmtBytes, QUIET_HOOK_BYTES } from "./audit.ts";

/**
 * Doctor's context checks: things outside the router's own config that still
 * cost context on every call. All of them report and suggest; none of them edit
 * — hooks, CLAUDE.md and the terminal's launch flags belong to the user and to
 * other tools.
 */

type HookSpec = { type?: string; command?: string };
type HookGroup = { matcher?: string; hooks?: HookSpec[] };
export type ClaudeSettings = {
  hooks?: Record<string, HookGroup[]>;
  enabledPlugins?: Record<string, boolean>;
};

/** Claude Code's settings files that apply in `cwd`, lowest precedence first. */
export function settingsFiles(cwd: string): string[] {
  return [
    join(homeDir(), ".claude", "settings.json"),
    join(cwd, ".claude", "settings.json"),
    join(cwd, ".claude", "settings.local.json"),
  ];
}

export async function readSettingsFiles(cwd: string): Promise<{ file: string; settings: ClaudeSettings }[]> {
  const out: { file: string; settings: ClaudeSettings }[] = [];
  for (const file of settingsFiles(cwd)) {
    const settings = await readJson<ClaudeSettings>(file);
    if (settings && typeof settings === "object") out.push({ file, settings });
  }
  return out;
}

// ── Hooks ────────────────────────────────────────────────────────────────────

/** The SessionStart moments a matcher fires on. An empty matcher means all of them. */
const SESSION_START_SOURCES = ["startup", "resume", "clear", "compact"];

export function sessionStartSources(matcher: string | undefined): string[] {
  if (!matcher || matcher === "*") return SESSION_START_SOURCES;
  try {
    const re = new RegExp(`^(?:${matcher})$`);
    return SESSION_START_SOURCES.filter((s) => re.test(s));
  } catch {
    return SESSION_START_SOURCES.filter((s) => matcher.split("|").includes(s));
  }
}

export type HookFinding = {
  file: string;
  event: string;
  matcher: string;
  command: string;
  /** SessionStart moments it runs on, when the event is SessionStart. */
  fires: string[];
  runs: number;
  medianStdoutBytes: number | null;
};

/**
 * Hooks whose output reaches the context. SessionStart output is injected
 * verbatim, and a hook with an empty matcher runs again after every compaction,
 * /clear and resume — so a large one is paid many times a day. Hooks on other
 * events are listed only when the transcripts show them printing something.
 */
export function findHooks(
  files: { file: string; settings: ClaudeSettings }[],
  runs: HookRun[],
): HookFinding[] {
  const byCommand = new Map<string, number[]>();
  for (const r of runs) {
    const sizes = byCommand.get(r.command) ?? [];
    sizes.push(r.stdoutBytes);
    byCommand.set(r.command, sizes);
  }
  const out: HookFinding[] = [];
  for (const { file, settings } of files) {
    for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
      for (const group of Array.isArray(groups) ? groups : []) {
        for (const hook of Array.isArray(group?.hooks) ? group.hooks : []) {
          if (typeof hook?.command !== "string") continue;
          const sizes = byCommand.get(hook.command) ?? [];
          const med = sizes.length ? median(sizes) : null;
          const isStart = event === "SessionStart";
          if (!isStart && (med === null || med < QUIET_HOOK_BYTES)) continue;
          out.push({
            file,
            event,
            matcher: group.matcher ?? "",
            command: hook.command,
            fires: isStart ? sessionStartSources(group.matcher) : [],
            runs: sizes.length,
            medianStdoutBytes: med,
          });
        }
      }
    }
  }
  return out.sort(
    (a, b) => (b.medianStdoutBytes ?? 0) - (a.medianStdoutBytes ?? 0) || a.command.localeCompare(b.command),
  );
}

export function renderHooks(findings: HookFinding[]): string[] {
  const loud = findings.filter((f) => f.medianStdoutBytes === null || f.medianStdoutBytes >= QUIET_HOOK_BYTES);
  if (!loud.length) return [];
  const lines = ["## Hooks", "  Output from these lands in context:"];
  for (const f of loud) {
    const size =
      f.medianStdoutBytes === null ? "no runs in recent transcripts" : `median ${fmtBytes(f.medianStdoutBytes)} over ${f.runs} runs`;
    const when = f.fires.length ? ` on ${f.fires.join("|")}` : "";
    lines.push(`  ${oneLine(f.command).slice(0, 60)}  [${f.event}${when}]  ${size}`);
    lines.push(`    ${f.file}`);
    if (f.fires.includes("compact") && (f.medianStdoutBytes ?? 0) >= 2048) {
      lines.push('    → it re-runs after every compaction; set "matcher": "startup" to run it once per session');
    } else if ((f.medianStdoutBytes ?? 0) >= 4096) {
      lines.push("    → trim what it prints; every byte is re-read on every call");
    }
  }
  return lines;
}

// ── Stale tool references in CLAUDE.md ───────────────────────────────────────

/** Claude Code's sanitized form of a server or tool name inside an mcp__ tool name. */
export function ccNamePart(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** The name Claude Code gives a router server's tools: mcp__<this>__tool. */
export function ccServerName(routerName: string): string {
  const i = routerName.indexOf(":");
  if (i === -1) return ccNamePart(routerName);
  // Plugin servers are "<plugin>:<server>" to the router.
  return `plugin_${ccNamePart(routerName.slice(0, i))}_${ccNamePart(routerName.slice(i + 1))}`;
}

export type StaleRef = { file: string; line: number; reference: string; server: string; suggestion: string };

/** Files whose instructions are loaded into every session in `cwd`. */
export function memoryFiles(cwd: string): string[] {
  return [
    join(homeDir(), ".claude", "CLAUDE.md"),
    join(cwd, "CLAUDE.md"),
    join(cwd, "CLAUDE.local.md"),
    join(cwd, ".claude", "CLAUDE.md"),
    join(cwd, "AGENTS.md"),
  ];
}

/**
 * Lines that name a tool by its direct mcp__ name when the harness no longer
 * loads that server — it sits behind the router. The model reads those words on
 * every turn and then looks for a tool that is not there.
 */
export function findStaleRefs(
  docs: { file: string; text: string }[],
  routed: string[],
  direct: Set<string>,
): StaleRef[] {
  const targets = routed
    .filter((name) => !direct.has(name))
    .map((name) => ({ name, cc: ccServerName(name) }))
    // Longest first, so "plugin_x_y" wins over a server literally named "plugin".
    .sort((a, b) => b.cc.length - a.cc.length);
  const out: StaleRef[] = [];
  for (const { file, text } of docs) {
    // The router's own primer names router tools on purpose; blank it out but
    // keep its newlines so line numbers stay true.
    const body = text.replace(/<!-- autorouter -->[\s\S]*?<!-- \/autorouter -->/g, (m) => m.replace(/[^\n]/g, " "));
    const lines = body.split("\n");
    lines.forEach((line, i) => {
      const re = /mcp__([A-Za-z0-9_-]+)/g;
      for (let m = re.exec(line); m; m = re.exec(line)) {
        const full = m[1]!;
        const hit = targets.find((t) => full === t.cc || full.startsWith(`${t.cc}__`));
        if (!hit) continue;
        const tool = full === hit.cc ? "" : full.slice(hit.cc.length + 2);
        out.push({
          file,
          line: i + 1,
          reference: `mcp__${full}`,
          server: hit.name,
          suggestion: tool
            ? `call_capability({ id: "mcp:${hit.name}/${tool}", ... })`
            : `find_capabilities({ query: "..." }) — ${hit.name} is behind the router`,
        });
      }
    });
  }
  return out;
}

/** Servers Claude Code itself loads in `cwd`: its own configs and enabled plugins. */
export async function claudeDirectServers(
  cwd: string,
  settings: { settings: ClaudeSettings }[],
  injected: string[],
): Promise<Set<string>> {
  const direct = new Set<string>(injected);
  type ClaudeJson = {
    mcpServers?: Record<string, unknown>;
    projects?: Record<string, { mcpServers?: Record<string, unknown> }>;
  };
  const global = await readJson<ClaudeJson>(join(homeDir(), ".claude.json"));
  for (const name of Object.keys(global?.mcpServers ?? {})) direct.add(name);
  for (const name of Object.keys(global?.projects?.[cwd]?.mcpServers ?? {})) direct.add(name);
  const local = await readJson<ClaudeJson>(join(cwd, ".mcp.json"));
  for (const name of Object.keys(local?.mcpServers ?? {})) direct.add(name);
  // An enabled plugin's servers load with it; the router names them "<plugin>:<server>".
  const enabled = new Map<string, boolean>();
  for (const { settings: s } of settings) {
    for (const [id, on] of Object.entries(s.enabledPlugins ?? {})) enabled.set(id.split("@")[0] ?? id, Boolean(on));
  }
  for (const [plugin, on] of enabled) if (on) direct.add(`${plugin}:*`);
  return direct;
}

/** Expands "<plugin>:*" markers in `direct` against the router's server names. */
export function expandDirect(direct: Set<string>, routed: string[]): Set<string> {
  const out = new Set<string>();
  for (const d of direct) {
    if (d.endsWith(":*")) {
      const prefix = d.slice(0, -1);
      for (const r of routed) if (r.startsWith(prefix)) out.add(r);
    } else out.add(d);
  }
  return out;
}

export async function readMemoryDocs(cwd: string): Promise<{ file: string; text: string }[]> {
  const out: { file: string; text: string }[] = [];
  const seen = new Set<string>();
  for (const file of memoryFiles(cwd)) {
    if (seen.has(file)) continue;
    seen.add(file);
    const text = await readText(file);
    if (text) out.push({ file, text });
  }
  return out;
}

export function renderStaleRefs(refs: StaleRef[]): string[] {
  if (!refs.length) return [];
  const lines = [
    "## Stale tool references",
    "  These instructions name tools the harness no longer loads (they are behind",
    "  the router), so the model looks for a tool that is not there:",
  ];
  // One entry per file and reference, listing every line it appears on.
  const grouped = new Map<string, { ref: StaleRef; lines: number[] }>();
  for (const r of refs) {
    const key = `${r.file}\0${r.reference}`;
    const g = grouped.get(key) ?? { ref: r, lines: [] };
    g.lines.push(r.line);
    grouped.set(key, g);
  }
  for (const { ref, lines: at } of grouped.values()) {
    lines.push(`  ${ref.file}:${at.join(",")}  ${ref.reference}`);
    lines.push(`    → ${ref.suggestion}`);
  }
  return lines;
}

// ── Servers injected on the command line ─────────────────────────────────────

/**
 * Server names from every --mcp-config in a command line. The value is either
 * inline JSON or a path to a JSON file; `ps` joins argv with spaces, so inline
 * JSON is recovered by brace matching rather than by splitting on whitespace.
 */
export async function mcpConfigServers(commandLine: string): Promise<string[]> {
  const names = new Set<string>();
  const flag = /--mcp-config(?:=|\s+)/g;
  for (let m = flag.exec(commandLine); m; m = flag.exec(commandLine)) {
    let rest = commandLine.slice(m.index + m[0].length);
    if (rest.startsWith("'") || rest.startsWith('"')) rest = rest.slice(1);
    if (rest.startsWith("{")) {
      const json = balancedObject(rest);
      if (json) {
        try {
          for (const n of Object.keys(JSON.parse(json)?.mcpServers ?? {})) names.add(n);
        } catch {
          // Not JSON after all.
        }
      }
      continue;
    }
    // One or more file paths, up to the next flag.
    for (const path of rest.split(/\s+--/)[0]!.split(/\s+/).filter(Boolean)) {
      const config = await readJson<{ mcpServers?: Record<string, unknown> }>(path);
      for (const n of Object.keys(config?.mcpServers ?? {})) names.add(n);
    }
  }
  return [...names].sort();
}

function balancedObject(s: string): string | null {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return s.slice(0, i + 1);
  }
  return null;
}

/** Command lines of this process's ancestors, nearest first. Empty where `ps` is unavailable. */
export async function ancestorCommandLines(maxDepth = 8): Promise<string[]> {
  if (process.platform === "win32") return [];
  const out: string[] = [];
  let pid = process.ppid;
  for (let i = 0; i < maxDepth && pid > 1; i++) {
    try {
      const r = await run("ps", ["-o", "ppid=", "-o", "args=", "-p", String(pid)], { timeoutMs: 2000 });
      const text = r.stdout.trim();
      if (!text) break;
      const m = /^(\d+)\s+([\s\S]*)$/.exec(text);
      if (!m) break;
      out.push(m[2]!);
      pid = Number(m[1]);
    } catch {
      break;
    }
  }
  return out;
}

export type Injected = { servers: string[]; source: string };

/**
 * Servers a launcher passed straight to the harness. `adopt` cannot move these —
 * they are in no file — so the only remedies are the launcher's own settings or
 * not importing a duplicate into the router as well.
 */
export async function findInjected(
  commandLines: string[],
  env: Record<string, string | undefined> = process.env,
): Promise<Injected[]> {
  const out: Injected[] = [];
  for (const line of commandLines) {
    if (!/(^|\/)claude(\s|$)/.test(line.split(/\s+--/)[0] ?? "") && !line.includes("--mcp-config")) continue;
    const servers = await mcpConfigServers(line);
    if (servers.length) out.push({ servers, source: "--mcp-config on the running claude" });
  }
  // Outside a claude process (doctor run from a plain terminal), cmux's
  // environment is the tell: it injects cmux-cua into every agent it launches.
  if (!out.length && (env.CMUX_BUNDLE_ID || env.CMUX_SURFACE_ID || env.CMUX_BUNDLED_CLI_PATH)) {
    out.push({ servers: ["cmux-cua"], source: "cmux (it passes --mcp-config to every agent it launches)" });
  }
  return out;
}

export function renderInjected(injected: Injected[], routed: string[]): string[] {
  if (!injected.length) return [];
  const routedSet = new Set(routed);
  const lines = ["## Injected servers", "  Loaded by the harness from its command line, so adopt cannot move them:"];
  for (const inj of injected) {
    for (const s of inj.servers) {
      const dup = routedSet.has(s);
      lines.push(`  ${s.padEnd(20)} via ${inj.source}${dup ? "  — also imported by the router (loaded twice)" : ""}`);
      if (dup) {
        lines.push(
          s === "cmux-cua"
            ? '    → turn off the injection in cmux if it offers that, or drop "cmux" from "import" to remove the duplicate'
            : "    → remove it from the launcher, or exclude it from the router",
        );
      }
    }
  }
  return lines;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
