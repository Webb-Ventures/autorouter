import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, mkdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectAudit,
  eventFamily,
  mcpServerOf,
  renderAudit,
  simulate,
  type SimCall,
} from "../src/cli/audit.ts";
import { listTranscripts, projectSlug } from "../src/util/transcripts.ts";
import { homeDir } from "../src/util/paths.ts";

let dir: string;
let home: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "autorouter-audit-"));
  home = join(dir, "home");
  await mkdir(join(home, ".claude", "projects"), { recursive: true });
  process.env.AUTOROUTER_HOME = home;
  if (homeDir() !== home) throw new Error(`sandbox not in effect: homeDir() = ${homeDir()}`);
});

afterEach(async () => {
  delete process.env.AUTOROUTER_HOME;
  await rm(dir, { recursive: true, force: true });
});

const usage = (read: number, write: number, out: number, input = 2) => ({
  input_tokens: input,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: write,
  output_tokens: out,
});

function assistant(id: string, u: object, content: object[], extra: object = {}) {
  return { type: "assistant", message: { id, usage: u, content }, ...extra };
}
function toolResult(id: string, text: string) {
  return { type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: text }] } };
}

/** A session: prompt, a Bash call with a big result, a compaction, and more work. */
function session(): (object | string)[] {
  return [
    { type: "user", message: { content: "fix the bug" } },
    // One message streamed as two entries: one call, output is the larger figure.
    assistant("m1", usage(0, 20_000, 10), [{ type: "thinking", thinking: "" }]),
    assistant("m1", usage(0, 20_000, 400), [
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "cat big.log" } },
    ]),
    toolResult("t1", "x".repeat(40_000)),
    assistant("m2", usage(20_000, 10_500, 50), [
      { type: "tool_use", id: "t2", name: "mcp__cmux-cua__click", input: {} },
    ]),
    toolResult("t2", "ok"),
    // A subagent's own traffic is not this session's context.
    assistant("side", usage(0, 999_999, 1), [], { isSidechain: true }),
    {
      type: "attachment",
      attachment: { type: "hook_success", hookName: "SessionStart:compact", command: "loud-hook", stdout: "y".repeat(5000) },
    },
    { type: "system", subtype: "compact_boundary", compactMetadata: { preTokens: 30_000, postTokens: 4_000 } },
    { type: "user", isCompactSummary: true, message: { content: "summary ".repeat(500) } },
    assistant("m3", usage(0, 26_000, 30), [{ type: "text", text: "done" }]),
    // A truncated write: passes the substring filter, fails to parse.
    '{"type":"assistant","message":{"id":"m4"',
    // Bookkeeping lines never get parsed at all.
    "not json at all",
  ];
}

async function writeSession(project: string, name: string, entries: (object | string)[]) {
  const d = join(home, ".claude", "projects", projectSlug(project));
  await mkdir(d, { recursive: true });
  const path = join(d, `${name}.jsonl`);
  await writeFile(path, entries.map((e) => (typeof e === "string" ? e : JSON.stringify(e))).join("\n") + "\n");
  return path;
}

describe("audit", () => {
  test("dedupes streamed messages, skips sidechains and resets on compaction", async () => {
    await writeSession("/work/app", "s1", session());
    const r = await collectAudit();

    expect(r.sessions).toBe(1);
    expect(r.calls).toBe(3);
    expect(r.processed).toBe(20_002 + 30_502 + 26_002);
    expect(r.cacheRead).toBe(20_000);
    expect(r.output).toBe(400 + 50 + 30);
    expect(r.compactions).toBe(1);
    expect(r.medianPreCompaction).toBe(30_000);
    expect(r.medianPostCompaction).toBe(26_002);
    expect(r.unparsedLines).toBe(1);

    const share = Object.fromEntries(r.shares.map((s) => [s.category, s.share]));
    const total = r.shares.reduce((a, s) => a + s.share, 0);
    expect(total).toBeCloseTo(1, 6);
    expect(share.bash).toBeGreaterThan(0);
    expect(share.startup).toBeGreaterThan(0);
    // The summary is charged to the call after the compaction, nothing before it.
    expect(share.summaries).toBeGreaterThan(0);
  });

  test("reports hooks by event family and direct MCP use", async () => {
    await writeSession("/work/app", "s1", session());
    const r = await collectAudit();
    expect(r.hooks).toEqual([
      { command: "loud-hook", runs: 1, medianStdoutBytes: 5000, events: { "SessionStart:compact": 1 } },
    ]);
    expect(r.directMcp).toEqual([{ server: "cmux-cua", calls: 1 }]);
    expect(eventFamily("PreToolUse:Bash")).toBe("PreToolUse");
    expect(eventFamily("SessionStart:clear")).toBe("SessionStart:clear");
    expect(mcpServerOf("mcp__plugin_datadog_mcp__search")).toBe("plugin_datadog_mcp");
    expect(mcpServerOf("Bash")).toBeNull();
  });

  test("prices windows against the configured autoCompactWindow", async () => {
    await writeSession("/work/app", "s1", session());
    await writeFile(join(home, ".claude", "settings.json"), JSON.stringify({ autoCompactWindow: 170000 }));
    const r = await collectAudit();
    expect(r.window?.current).toBe(170_000);
    const current = r.window!.sweep.find((s) => s.window === 170_000)!;
    expect(current.change).toBe(0);
    expect(r.window!.recommended).not.toBeNull();

    const text = renderAudit(r, { days: 14 });
    expect(text).toContain("## Context bill");
    expect(text).toContain("## What fills it");
    expect(text).toContain("autoCompactWindow: 170000");
    expect(text).toContain("← current");
    expect(text).toContain("loud-hook");
  });

  test("filters by project and by age", async () => {
    await writeSession("/work/app", "s1", session());
    const old = await writeSession("/work/other", "s2", session());
    const longAgo = new Date(Date.now() - 30 * 86_400_000);
    await utimes(old, longAgo, longAgo);

    expect((await listTranscripts()).length).toBe(2);
    expect((await listTranscripts({ days: 14 })).length).toBe(1);
    expect((await listTranscripts({ project: "/work/other" })).map((f) => f.project)).toEqual(["-work-other"]);
    expect((await collectAudit({ project: "/work/nowhere" })).calls).toBe(0);
  });

  test("an empty history renders without numbers", async () => {
    const r = await collectAudit({ days: 14 });
    expect(r.calls).toBe(0);
    expect(r.window).toBeNull();
    expect(renderAudit(r)).toContain("No API calls found");
  });
});

describe("simulate", () => {
  /** One long session growing 5k per call. */
  const grow = (calls: number): SimCall[][] => [
    Array.from({ length: calls }, (_, i) => ({
      tot: 30_000 + i * 5_000,
      cw: 5_000,
      inp: 2,
      out: 300,
      th: 0,
      thPrev: 0,
      tr: 0,
      afterBoundary: false,
    })),
  ];
  const params = { startup: 20_000, summary: 10_000, keptFraction: 0.1, compactionOutput: 5_000 };

  test("a smaller window compacts more and keeps a smaller context", () => {
    const big = simulate(grow(200), { ...params, window: 350_000 });
    const small = simulate(grow(200), { ...params, window: 150_000 });
    expect(small.compactions).toBeGreaterThan(big.compactions);
    expect(small.avgContext).toBeLessThan(big.avgContext);
    expect(small.cost).toBeLessThan(big.cost);
  });

  test("a recorded compaction boundary is not growth", () => {
    const s = grow(10);
    s[0]![5]!.afterBoundary = true;
    s[0]![5]!.tot = 1_000;
    const r = simulate(s, { ...params, window: 1_000_000 });
    expect(r.compactions).toBe(0);
    expect(Number.isFinite(r.cost)).toBe(true);
  });
});
