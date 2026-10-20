import { join } from "node:path";
import { homeDir, readJson } from "../util/paths.ts";
import {
  eachEntry,
  hookRunOf,
  listTranscripts,
  median,
  quantile,
  type HookRun,
} from "../util/transcripts.ts";

/**
 * The real context bill, read from Claude Code's own transcripts.
 *
 * `doctor` prices tool schemas, which is what a router saves on paper. But a
 * harness that defers MCP schemas already loads them by name only, and what a
 * session actually pays for is context size × number of calls: every API call
 * re-reads everything still in the window. This reads the usage fields Claude
 * Code records per call and attributes them to what filled the window, then
 * replays the same sessions under other compaction windows.
 */

export type AuditOptions = { days?: number; project?: string; now?: number };

/** What fills the context, in display order. */
export const CATEGORIES = [
  ["startup", "startup overhead (system prompt, tools, skills, CLAUDE.md)"],
  ["carried", "carried over through compaction (kept turns, re-attached files)"],
  ["thinking", "Claude's thinking (kept in context)"],
  ["bash", "Bash output"],
  ["toolInputs", "Claude's tool calls (commands, edits, writes)"],
  ["read", "Read (file contents)"],
  ["summaries", "compaction summaries"],
  ["prompts", "your prompts"],
  ["replies", "Claude's replies"],
  ["router", "autorouter results"],
  ["images", "images / screenshots"],
  ["web", "web fetch / search"],
  ["agents", "subagent reports"],
  ["hooks", "hooks, reminders, task notifications"],
  ["other", "other tool results"],
] as const;
export type Category = (typeof CATEGORIES)[number][0];

/** One API call, as much of it as the window replay needs. */
export type SimCall = {
  tot: number;
  cw: number;
  inp: number;
  out: number;
  /** Thinking this call produced (output minus visible content). */
  th: number;
  /** Thinking the previous call left in context. */
  thPrev: number;
  /** Bash and Read output that arrived since the previous call. */
  tr: number;
  /** First call after a compaction boundary: its growth is not real growth. */
  afterBoundary: boolean;
};

export type SimParams = {
  window: number;
  startup: number;
  summary: number;
  keptFraction: number;
  compactionOutput: number;
  trim?: number;
};

export type AuditReport = {
  files: number;
  sessions: number;
  calls: number;
  unparsedLines: number;
  processed: number;
  cacheRead: number;
  cacheWrite: number;
  uncachedInput: number;
  output: number;
  avgContext: number;
  compactions: number;
  medianPreCompaction: number;
  medianPostCompaction: number;
  medianSessionStart: number;
  /** Share of processed tokens, by category, in CATEGORIES order. */
  shares: { category: Category; label: string; share: number; tokens: number }[];
  /** Calls per 50k band of context size. */
  histogram: { band: string; calls: number }[];
  hooks: { command: string; runs: number; medianStdoutBytes: number; events: Record<string, number> }[];
  /** MCP tools the harness called directly rather than through the router, per server. */
  directMcp: { server: string; calls: number }[];
  window: {
    current: number | null;
    /** Where `current` came from, e.g. modelSettings["claude-opus-5-5"]. */
    source: string | null;
    model: string | null;
    baseline: number;
    params: SimParams;
    sweep: { window: number; change: number; compactions: number; avgContext: number }[];
    recommended: number | null;
  } | null;
};

const CHARS_PER_TOKEN = 4;
const IMAGE_TOKENS = 1600;
const tok = (chars: number) => chars / CHARS_PER_TOKEN;
/** API-equivalent weights relative to uncached input: a proxy for subscription usage. */
export const COST_WEIGHTS = { read: 0.1, write: 1.25, input: 1, output: 5 };
/** Below this a hook's output is noise, not context. */
export const QUIET_HOOK_BYTES = 256;
const SWEEP = [100_000, 120_000, 140_000, 170_000, 200_000, 250_000, 300_000, 350_000];

/** Lines worth parsing for the audit. Everything else is skipped unparsed. */
const AUDIT_FILTER = (l: string) =>
  l.includes('"assistant"') ||
  l.includes('"user"') ||
  l.includes("compact") ||
  l.includes('"hook_success"');

function textLength(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return content == null ? 0 : JSON.stringify(content).length;
  let n = 0;
  for (const p of content) {
    if (p && typeof p === "object" && typeof (p as any).text === "string") n += (p as any).text.length;
  }
  return n;
}

function resultCategory(tool: string | undefined): Category {
  switch (tool) {
    case "Bash":
      return "bash";
    case "Read":
      return "read";
    case "Agent":
    case "Task":
      return "agents";
    case "WebFetch":
    case "WebSearch":
      return "web";
  }
  if (tool?.startsWith("mcp__autorouter__")) return "router";
  return "other";
}

/** The server part of a Claude Code MCP tool name: mcp__<server>__<tool>. */
export function mcpServerOf(tool: string): string | null {
  if (!tool.startsWith("mcp__")) return null;
  const rest = tool.slice(5);
  const i = rest.indexOf("__");
  return i <= 0 ? null : rest.slice(0, i);
}

/**
 * One session's walk. Attribution keeps a running per-category total of what is
 * live in the window, and at every call charges each category its live tokens —
 * so a block costs its size once for every later call that re-reads it. What the
 * usage says is in context but no block explains is the residual: startup
 * overhead at the first call, and what compaction carried over after that.
 */
class SessionScan {
  live = new Map<Category, number>();
  acc = new Map<Category, number>();
  calls: SimCall[] = [];
  seen = new Set<string>();
  toolNames = new Map<string, string>();
  pending: { id: string; out: number; visible: number; call: SimCall | null } | null = null;
  startResidual: number | null = null;
  firstTot: number | null = null;
  afterBoundary = false;
  awaitingPost = false;
  trSinceCall = 0;
  lastThinking = 0;

  processed = 0;
  cacheRead = 0;
  cacheWrite = 0;
  input = 0;
  output = 0;
  pre: number[] = [];
  post: number[] = [];
  summaries: number[] = [];
  compactions = 0;
  histogram: number[] = new Array(8).fill(0);
  /** API calls per model id, to pick which per-model compaction setting applies. */
  models = new Map<string, number>();
  hooks: HookRun[] = [];
  directMcp = new Map<string, number>();

  add(cat: Category, tokens: number) {
    if (tokens > 0) this.live.set(cat, (this.live.get(cat) ?? 0) + tokens);
  }

  finalize() {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    const thinking = Math.max(p.out - p.visible, 0);
    if (p.call) {
      p.call.out = p.out;
      p.call.th = thinking;
    }
    this.lastThinking = thinking;
    this.add("thinking", thinking);
  }

  visit(e: any) {
    if (e.isSidechain) return;
    const m = e.message && typeof e.message === "object" ? e.message : {};

    if (e.type === "assistant") {
      const id = typeof m.id === "string" ? m.id : `${this.calls.length}:${this.seen.size}`;
      if (this.pending && this.pending.id !== id) this.finalize();
      const u = m.usage ?? {};
      const out = Number(u.output_tokens) || 0;
      if (!this.pending) {
        this.pending = { id, out: 0, visible: 0, call: null };
        if (typeof m.model === "string") this.models.set(m.model, (this.models.get(m.model) ?? 0) + 1);
        const cw = Number(u.cache_creation_input_tokens) || 0;
        const cr = Number(u.cache_read_input_tokens) || 0;
        const inp = Number(u.input_tokens) || 0;
        const tot = cw + cr + inp;
        if (tot && !this.seen.has(id)) {
          this.seen.add(id);
          this.chargeCall(tot);
          this.processed += tot;
          this.cacheRead += cr;
          this.cacheWrite += cw;
          this.input += inp;
          if (this.awaitingPost) {
            this.post.push(tot);
            this.awaitingPost = false;
          }
          const call: SimCall = {
            tot,
            cw,
            inp,
            out: 0,
            th: 0,
            thPrev: this.lastThinking,
            tr: this.trSinceCall,
            afterBoundary: this.afterBoundary,
          };
          this.calls.push(call);
          this.pending.call = call;
          this.trSinceCall = 0;
          this.afterBoundary = false;
          this.histogram[Math.min(Math.floor(tot / 50_000), 7)]!++;
        }
      }
      const p = this.pending;
      if (out > p.out) {
        // Output is reported once per streamed entry; the largest is the total.
        if (p.call) this.output += out - p.out;
        p.out = out;
      }
      for (const c of Array.isArray(m.content) ? m.content : []) {
        if (!c || typeof c !== "object") continue;
        if (c.type === "thinking") continue;
        const size = tok(JSON.stringify(c).length);
        p.visible += size;
        if (c.type === "tool_use") {
          if (typeof c.id === "string" && typeof c.name === "string") this.toolNames.set(c.id, c.name);
          this.add("toolInputs", tok(JSON.stringify(c.input ?? {}).length));
          const server = typeof c.name === "string" ? mcpServerOf(c.name) : null;
          if (server && server !== "autorouter") this.directMcp.set(server, (this.directMcp.get(server) ?? 0) + 1);
        } else if (c.type === "text") {
          this.add("replies", tok(typeof c.text === "string" ? c.text.length : 0));
        }
      }
      return;
    }

    this.finalize();

    if (e.type === "system" && e.subtype === "compact_boundary") {
      this.live.clear();
      this.compactions++;
      this.afterBoundary = true;
      this.awaitingPost = true;
      const meta = e.compactMetadata ?? {};
      if (Number(meta.preTokens) > 0) this.pre.push(Number(meta.preTokens));
      if (Number(meta.postTokens) > 0) this.summaries.push(Number(meta.postTokens));
      return;
    }
    if (e.isCompactSummary) {
      this.add("summaries", tok(textLength(m.content)));
      return;
    }
    if (e.type === "attachment") {
      const run = hookRunOf(e);
      if (run) this.hooks.push(run);
      return;
    }
    if (e.type !== "user") return;

    const content = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
    for (const c of Array.isArray(content) ? content : []) {
      if (!c || typeof c !== "object") continue;
      if (c.type === "tool_result") {
        const cat = resultCategory(this.toolNames.get(c.tool_use_id));
        let chars = 0;
        if (typeof c.content === "string") chars = c.content.length;
        else if (Array.isArray(c.content)) {
          for (const part of c.content) {
            if (part?.type === "image") this.add("images", IMAGE_TOKENS);
            else if (typeof part?.text === "string") chars += part.text.length;
          }
        }
        this.add(cat, tok(chars));
        if (cat === "bash" || cat === "read") this.trSinceCall += tok(chars);
      } else if (c.type === "text") {
        const text = typeof c.text === "string" ? c.text : "";
        this.add(text.trimStart().startsWith("<") ? "hooks" : "prompts", tok(text.length));
      } else if (c.type === "image") {
        this.add("images", IMAGE_TOKENS);
      }
    }
  }

  chargeCall(tot: number) {
    let content = 0;
    for (const v of this.live.values()) content += v;
    let scale = 1;
    let residual = tot - content;
    if (residual < 0) {
      // chars/4 overshot the real count: scale the estimate down to the truth.
      scale = tot / content;
      residual = 0;
    }
    for (const [cat, v] of this.live) this.acc.set(cat, (this.acc.get(cat) ?? 0) + v * scale);
    if (this.startResidual === null) {
      this.startResidual = residual;
      this.firstTot = tot;
    }
    this.acc.set("startup", (this.acc.get("startup") ?? 0) + Math.min(residual, this.startResidual));
    this.acc.set("carried", (this.acc.get("carried") ?? 0) + Math.max(residual - this.startResidual, 0));
  }
}

/**
 * Replays recorded sessions under a compaction window. Each call's real context
 * growth is applied to a simulated window that compacts at 90.5% of `window`
 * (the observed trigger point) down to startup + summary + a kept fraction of
 * what was there. A cache write much larger than the call's growth was a cache
 * expiry, which rewrites the whole simulated context.
 */
export function simulate(sessions: SimCall[][], p: SimParams): { cost: number; compactions: number; avgContext: number } {
  const trim = p.trim ?? 0;
  const trigger = p.window * 0.905;
  let read = 0;
  let write = 0;
  let input = 0;
  let output = 0;
  let compactions = 0;
  let n = 0;
  for (const s of sessions) {
    let ctx: number | null = null;
    let prevTot = 0;
    for (const c of s) {
      let d: number;
      let full: boolean;
      if (ctx === null) {
        ctx = c.tot - trim;
        d = ctx;
        full = true;
      } else {
        d = c.afterBoundary ? 0 : c.tot - prevTot;
        ctx = Math.max(ctx + d, p.startup - trim);
        full = false;
      }
      prevTot = c.tot;
      if (ctx > trigger) {
        compactions++;
        read += ctx;
        output += p.compactionOutput;
        ctx = p.startup - trim + p.summary + p.keptFraction * ctx;
        full = true;
      }
      n++;
      const rewrite = full || c.cw > Math.max(d, 0) * 1.5 + 4000;
      const cw = rewrite ? ctx : Math.max(d, 0);
      read += Math.max(ctx - cw, 0);
      write += cw;
      input += c.inp;
      output += c.out;
    }
  }
  const w = COST_WEIGHTS;
  return {
    cost: read * w.read + write * w.write + input * w.input + output * w.output,
    compactions,
    avgContext: n ? (read + write) / n : 0,
  };
}

/**
 * Claude Code's autoCompactWindow for `model`, or null when unset.
 *
 * A per-model value (modelSettings[<model>].autoCompactWindow) wins over the
 * top-level one. Transcripts record dated or suffixed ids ("claude-opus-5-5",
 * "claude-opus-5-5[1m]"), so the longest settings key the id starts with is used.
 */
export async function currentCompactWindow(
  model: string | null = null,
): Promise<{ value: number; source: string } | null> {
  const settings = await readJson<{
    autoCompactWindow?: unknown;
    modelSettings?: Record<string, { autoCompactWindow?: unknown }>;
  }>(join(homeDir(), ".claude", "settings.json"));
  const valid = (v: unknown) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
  if (model && settings?.modelSettings) {
    const key = Object.keys(settings.modelSettings)
      .filter((k) => model.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    const v = key ? valid(settings.modelSettings[key]?.autoCompactWindow) : null;
    if (key && v) return { value: v, source: `modelSettings["${key}"]` };
  }
  const v = valid(settings?.autoCompactWindow);
  return v ? { value: v, source: "autoCompactWindow" } : null;
}

export async function collectAudit(opts: AuditOptions = {}): Promise<AuditReport> {
  const files = await listTranscripts({ days: opts.days, project: opts.project, now: opts.now });
  const acc = new Map<Category, number>();
  const sessions: SimCall[][] = [];
  const pre: number[] = [];
  const post: number[] = [];
  const summaries: number[] = [];
  const firsts: number[] = [];
  const histogram = new Array(8).fill(0) as number[];
  const hooks = new Map<string, { sizes: number[]; events: Map<string, number> }>();
  const directMcp = new Map<string, number>();
  const models = new Map<string, number>();
  let unparsed = 0;
  let processed = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let input = 0;
  let output = 0;
  let compactions = 0;
  let calls = 0;

  for (const f of files) {
    const scan = new SessionScan();
    try {
      const r = await eachEntry(f.path, AUDIT_FILTER, (e) => scan.visit(e));
      unparsed += r.unparsed;
    } catch {
      continue;
    }
    scan.finalize();
    for (const run of scan.hooks) {
      const h = hooks.get(run.command) ?? { sizes: [] as number[], events: new Map<string, number>() };
      h.sizes.push(run.stdoutBytes);
      const event = eventFamily(run.event);
      h.events.set(event, (h.events.get(event) ?? 0) + 1);
      hooks.set(run.command, h);
    }
    for (const [server, n] of scan.directMcp) directMcp.set(server, (directMcp.get(server) ?? 0) + n);
    for (const [model, n] of scan.models) models.set(model, (models.get(model) ?? 0) + n);
    if (!scan.calls.length) continue;
    sessions.push(scan.calls);
    calls += scan.calls.length;
    for (const [cat, v] of scan.acc) acc.set(cat, (acc.get(cat) ?? 0) + v);
    pre.push(...scan.pre);
    post.push(...scan.post);
    summaries.push(...scan.summaries);
    if (scan.firstTot !== null) firsts.push(scan.firstTot);
    scan.histogram.forEach((n, i) => (histogram[i]! += n));
    processed += scan.processed;
    cacheRead += scan.cacheRead;
    cacheWrite += scan.cacheWrite;
    input += scan.input;
    output += scan.output;
    compactions += scan.compactions;
  }

  const total = [...acc.values()].reduce((a, b) => a + b, 0);
  const shares = CATEGORIES.map(([category, label]) => {
    const v = acc.get(category) ?? 0;
    // Attribution is estimated in chars/4; scale it onto the measured total.
    const tokens = total ? (v / total) * processed : 0;
    return { category, label, share: total ? v / total : 0, tokens };
  });

  // The model most calls used decides which per-model setting is "current".
  const model = [...models].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
  const window = calls ? await sweepWindows(sessions, { pre, post, summaries, firsts }, model) : null;

  return {
    files: files.length,
    sessions: sessions.length,
    calls,
    unparsedLines: unparsed,
    processed,
    cacheRead,
    cacheWrite,
    uncachedInput: input,
    output,
    avgContext: calls ? processed / calls : 0,
    compactions,
    medianPreCompaction: median(pre),
    medianPostCompaction: median(post),
    medianSessionStart: median(firsts),
    shares,
    histogram: histogram.map((n, i) => ({ band: i < 7 ? `${i * 50}-${i * 50 + 50}k` : "350k+", calls: n })),
    hooks: [...hooks]
      .map(([command, h]) => ({
        command,
        runs: h.sizes.length,
        medianStdoutBytes: median(h.sizes),
        events: Object.fromEntries([...h.events].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
      }))
      .sort((a, b) => b.runs * b.medianStdoutBytes - a.runs * a.medianStdoutBytes || a.command.localeCompare(b.command)),
    directMcp: [...directMcp]
      .map(([server, calls]) => ({ server, calls }))
      .sort((a, b) => b.calls - a.calls || a.server.localeCompare(b.server)),
    window,
  };
}

/**
 * Calibrates the replay against what compaction actually did in these
 * transcripts, then prices each candidate window against the current one.
 */
async function sweepWindows(
  sessions: SimCall[][],
  m: { pre: number[]; post: number[]; summaries: number[]; firsts: number[] },
  model: string | null,
): Promise<NonNullable<AuditReport["window"]>> {
  // The quieter sessions' first call is the closest thing to bare startup cost;
  // the median is inflated by sessions that open with a large prompt or skill.
  const startup = m.firsts.length ? quantile(m.firsts, 0.25) : 25_000;
  const summary = m.summaries.length ? median(m.summaries) : 22_000;
  const keptFraction =
    m.pre.length && m.post.length
      ? Math.min(0.3, Math.max(0.05, (median(m.post) - startup - summary) / median(m.pre)))
      : 0.13;
  const params: SimParams = { window: 0, startup, summary, keptFraction, compactionOutput: 15_000 };

  const setting = await currentCompactWindow(model);
  const current = setting?.value ?? null;
  const baseline = current ?? 350_000;
  const windows = [...new Set([...SWEEP, baseline])].sort((a, b) => a - b);
  const base = simulate(sessions, { ...params, window: baseline });
  const sweep = windows.map((window) => {
    const r = simulate(sessions, { ...params, window });
    return {
      window,
      change: base.cost ? r.cost / base.cost - 1 : 0,
      compactions: r.compactions,
      avgContext: r.avgContext,
    };
  });
  // Every compaction loses detail, so among windows within 1.5 points of the
  // cheapest, prefer the largest.
  const best = Math.min(...sweep.map((s) => s.change));
  const recommended = [...sweep].reverse().find((s) => s.change <= best + 0.015)?.window ?? null;
  return { current, source: setting?.source ?? null, model, baseline, params, sweep, recommended };
}

export function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(Math.round(n));
}

export function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${Math.round(n)}B`;
}

const pct = (x: number, digits = 1) => `${(x * 100).toFixed(digits)}%`;

export function renderAudit(r: AuditReport, opts: { days?: number; project?: string } = {}): string {
  const lines: string[] = ["# autorouter audit", ""];
  const scope = [opts.days ? `last ${opts.days} days` : "all time", opts.project ? `project ${opts.project}` : "all projects"];
  lines.push(
    `transcripts: ${r.files} files, ${r.sessions} sessions, ${r.calls.toLocaleString("en-US")} API calls (${scope.join(", ")})`,
  );
  if (r.unparsedLines) lines.push(`unparsed lines skipped: ${r.unparsedLines}`);
  if (!r.calls) {
    lines.push("", "No API calls found in ~/.claude/projects for this range.");
    return lines.join("\n");
  }

  lines.push("", "## Context bill");
  lines.push(`  avg context per call   ${fmtTokens(r.avgContext)}`);
  lines.push(`  input processed        ${fmtTokens(r.processed)} (${pct(r.cacheRead / r.processed, 0)} cache reads)`);
  lines.push(`  output                 ${fmtTokens(r.output)}`);
  lines.push(
    `  compactions            ${r.compactions}` +
      (r.compactions ? ` (median ${fmtTokens(r.medianPreCompaction)} before → ${fmtTokens(r.medianPostCompaction)} after)` : ""),
  );
  lines.push(`  session start          median ${fmtTokens(r.medianSessionStart)} at the first call (startup + first prompt)`);

  lines.push("", "## What fills it (tokens × calls each stays in context)");
  for (const s of r.shares) {
    if (s.share < 0.0005) continue;
    lines.push(`  ${pct(s.share).padStart(6)}  ${fmtTokens(s.tokens).padStart(6)}  ${s.label}`);
  }

  lines.push("", "## Context size per call");
  const maxCalls = Math.max(...r.histogram.map((h) => h.calls), 1);
  for (const h of r.histogram) {
    if (!h.calls && h.band === "350k+") continue;
    const bar = "█".repeat(Math.round((h.calls / maxCalls) * 30));
    lines.push(`  ${h.band.padStart(9)}  ${String(h.calls).padStart(6)}  ${bar}`);
  }

  if (r.window) {
    const w = r.window;
    lines.push("", "## Compaction window (replay, API-equivalent cost)");
    lines.push(
      w.current
        ? `  autoCompactWindow: ${w.current} (${w.source} in ~/.claude/settings.json${w.model ? `, for ${w.model}, the model most calls used` : ""})`
        : `  autoCompactWindow: unset — changes below are relative to ${fmtTokens(w.baseline)}`,
    );
    lines.push("     window    change  compactions  avg context");
    for (const s of w.sweep) {
      const mark = s.window === w.baseline ? "  ← current" : s.window === w.recommended ? "  ← recommended" : "";
      lines.push(
        `  ${fmtTokens(s.window).padStart(9)}  ${`${s.change > 0 ? "+" : ""}${(s.change * 100).toFixed(1)}%`.padStart(8)}  ${String(s.compactions).padStart(11)}  ${fmtTokens(s.avgContext).padStart(11)}${mark}`,
      );
    }
    if (w.recommended && w.recommended !== w.baseline) {
      const rec = w.sweep.find((s) => s.window === w.recommended)!;
      lines.push(
        "",
        `  → set ${w.source?.startsWith("modelSettings") ? `${w.source}.autoCompactWindow` : `"autoCompactWindow"`} to ${w.recommended} in ~/.claude/settings.json (est. ${(rec.change * 100).toFixed(0)}% usage)`,
      );
    }
    lines.push(
      `  model: compacts at 90.5% of the window to ${fmtTokens(w.params.startup)} startup + ${fmtTokens(w.params.summary)} summary + ${pct(w.params.keptFraction, 0)} kept;`,
      `  weights: cache read ×${COST_WEIGHTS.read}, cache write ×${COST_WEIGHTS.write}, output ×${COST_WEIGHTS.output}. Relative, not exact.`,
    );
  }

  if (r.hooks.length) {
    // A hook that prints a few bytes of JSON costs nothing worth listing; the
    // ones that matter are those whose output lands in context on every run.
    const loud = r.hooks.filter((h) => h.medianStdoutBytes >= QUIET_HOOK_BYTES);
    const quiet = r.hooks.length - loud.length;
    lines.push("", "## Hooks (median output per run, from the transcripts)");
    for (const h of loud.slice(0, 8)) {
      const events = Object.entries(h.events)
        .slice(0, 4)
        .map(([e, n]) => `${e} ${n}`)
        .join(", ");
      lines.push(`  ${truncate(oneLine(h.command), 36).padEnd(36)}  ${String(h.runs).padStart(5)} runs  median ${fmtBytes(h.medianStdoutBytes).padStart(7)}  (${events})`);
    }
    if (!loud.length) lines.push("  none print more than a few hundred bytes");
    if (quiet) lines.push(`  (${quiet} quiet hook${quiet === 1 ? "" : "s"} omitted)`);
  }

  if (r.directMcp.length) {
    lines.push("", "## MCP tools called directly by the harness (not through the router)");
    for (const d of r.directMcp.slice(0, 10)) lines.push(`  ${d.server.padEnd(28)} ${d.calls} calls`);
  }

  return lines.join("\n");
}

export async function runAudit(opts: AuditOptions & { json?: boolean }): Promise<string> {
  const report = await collectAudit(opts);
  if (opts.json) return JSON.stringify(report, (_k, v) => (typeof v === "number" ? Math.round(v * 1e4) / 1e4 : v), 2);
  return renderAudit(report, opts);
}

/**
 * "PreToolUse:Bash" and "PreToolUse:Edit" are one hook firing on different
 * tools; "SessionStart:compact" and "SessionStart:startup" are different
 * moments, and which ones a hook runs on is the point of reporting it.
 */
export function eventFamily(event: string): string {
  const [family] = event.split(":");
  return family === "SessionStart" ? event : family!;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
