import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ccServerName,
  claudeDirectServers,
  expandDirect,
  findHooks,
  findInjected,
  findStaleRefs,
  mcpConfigServers,
  readMemoryDocs,
  readSettingsFiles,
  renderHooks,
  renderInjected,
  renderStaleRefs,
  sessionStartSources,
} from "../src/cli/doctorChecks.ts";
import { homeDir } from "../src/util/paths.ts";

let dir: string;
let home: string;
let cwd: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "autorouter-doctor-"));
  home = join(dir, "home");
  cwd = join(dir, "repo");
  await mkdir(join(home, ".claude"), { recursive: true });
  await mkdir(join(cwd, ".claude"), { recursive: true });
  process.env.AUTOROUTER_HOME = home;
  if (homeDir() !== home) throw new Error(`sandbox not in effect: homeDir() = ${homeDir()}`);
});

afterEach(async () => {
  delete process.env.AUTOROUTER_HOME;
  await rm(dir, { recursive: true, force: true });
});

describe("hooks", () => {
  test("an empty SessionStart matcher fires on every moment", () => {
    expect(sessionStartSources("")).toEqual(["startup", "resume", "clear", "compact"]);
    expect(sessionStartSources("startup")).toEqual(["startup"]);
    expect(sessionStartSources("startup|resume")).toEqual(["startup", "resume"]);
  });

  test("flags loud SessionStart hooks from every settings scope", async () => {
    await writeFile(
      join(home, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "lavish-axi" }] }],
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "quiet" }] }],
        },
      }),
    );
    await writeFile(
      join(cwd, ".claude", "settings.local.json"),
      JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "chatty" }] }] } }),
    );
    const settings = await readSettingsFiles(cwd);
    expect(settings.map((s) => s.file)).toEqual([
      join(home, ".claude", "settings.json"),
      join(cwd, ".claude", "settings.local.json"),
    ]);

    const runs = [
      { command: "lavish-axi", event: "SessionStart:compact", stdoutBytes: 13_000 },
      { command: "lavish-axi", event: "SessionStart:startup", stdoutBytes: 13_400 },
      { command: "quiet", event: "PreToolUse:Bash", stdoutBytes: 3 },
      { command: "chatty", event: "UserPromptSubmit", stdoutBytes: 6_000 },
    ];
    const findings = findHooks(settings, runs);
    expect(findings.map((f) => f.command)).toEqual(["lavish-axi", "chatty"]);
    expect(findings[0]!.fires).toEqual(["startup", "resume", "clear", "compact"]);
    expect(findings[0]!.medianStdoutBytes).toBe(13_200);

    const text = renderHooks(findings).join("\n");
    expect(text).toContain("## Hooks");
    expect(text).toContain('set "matcher": "startup"');
    expect(text).toContain("trim what it prints");
    expect(text).not.toContain("quiet");
  });

  test("nothing to say when every hook is quiet", () => {
    expect(renderHooks([])).toEqual([]);
  });
});

describe("stale tool references", () => {
  test("names plugin servers the way Claude Code does", () => {
    expect(ccServerName("semble")).toBe("semble");
    expect(ccServerName("datadog:mcp")).toBe("plugin_datadog_mcp");
    expect(ccServerName("my.server")).toBe("my_server");
  });

  test("finds references to routed servers the harness no longer loads", async () => {
    await writeFile(
      join(home, ".claude", "CLAUDE.md"),
      [
        "# Notes",
        "Use `mcp__semble__search` to find code.",
        "<!-- autorouter -->",
        "Call mcp__semble__search through the router.",
        "<!-- /autorouter -->",
        "Logs: mcp__plugin_datadog_mcp__search_logs, and mcp__railway__deploy.",
        "Also mcp__semble__search again.",
      ].join("\n"),
    );
    await writeFile(join(cwd, "AGENTS.md"), "Run mcp__linear__get_issue for tickets.\n");

    const docs = await readMemoryDocs(cwd);
    // railway is still loaded directly, so naming it is fine.
    const refs = findStaleRefs(docs, ["semble", "datadog:mcp", "railway", "linear"], new Set(["railway"]));
    expect(refs.map((r) => [r.line, r.reference, r.server])).toEqual([
      [2, "mcp__semble__search", "semble"],
      [6, "mcp__plugin_datadog_mcp__search_logs", "datadog:mcp"],
      [7, "mcp__semble__search", "semble"],
      [1, "mcp__linear__get_issue", "linear"],
    ]);
    expect(refs[0]!.suggestion).toBe('call_capability({ id: "mcp:semble/search", ... })');
    expect(refs[1]!.suggestion).toContain('"mcp:datadog:mcp/search_logs"');

    const text = renderStaleRefs(refs).join("\n");
    expect(text).toContain(`${join(home, ".claude", "CLAUDE.md")}:2,7  mcp__semble__search`);
  });

  test("servers in the harness's own config and enabled plugins count as direct", async () => {
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({ mcpServers: { autorouter: {} }, projects: { [cwd]: { mcpServers: { linear: {} } } } }),
    );
    await writeFile(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { stripe: {} } }));
    await writeFile(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { "datadog@official": true, "posthog@official": false } }),
    );
    const direct = expandDirect(
      await claudeDirectServers(cwd, await readSettingsFiles(cwd), ["cmux-cua"]),
      ["datadog:mcp", "posthog:mcp", "semble"],
    );
    expect([...direct].sort()).toEqual(["autorouter", "cmux-cua", "datadog:mcp", "linear", "stripe"]);
  });
});

describe("injected servers", () => {
  test("reads inline --mcp-config JSON out of a ps command line", async () => {
    const line =
      '/Users/me/.local/bin/claude --session-id abc --settings /tmp/s.json --mcp-config={"mcpServers":{"cmux-cua":{"command":"/x/cmux-cua","args":["mcp","--socket","/tmp/a b.sock"]}}} --verbose';
    expect(await mcpConfigServers(line)).toEqual(["cmux-cua"]);
    expect(await mcpConfigServers("claude --mcp-config {broken")).toEqual([]);
  });

  test("reads --mcp-config file paths", async () => {
    const file = join(dir, "extra.json");
    await writeFile(file, JSON.stringify({ mcpServers: { one: {}, two: {} } }));
    expect(await mcpConfigServers(`claude --mcp-config ${file} --print`)).toEqual(["one", "two"]);
  });

  test("falls back to cmux's environment outside a claude process", async () => {
    expect(await findInjected(["zsh"], { CMUX_BUNDLE_ID: "com.cmuxterm.app" })).toEqual([
      { servers: ["cmux-cua"], source: "cmux (it passes --mcp-config to every agent it launches)" },
    ]);
    expect(await findInjected(["zsh"], {})).toEqual([]);
  });

  test("flags a server the router imports as well", async () => {
    const injected = await findInjected(['claude --mcp-config={"mcpServers":{"cmux-cua":{}}}'], {});
    const text = renderInjected(injected, ["cmux-cua", "semble"]).join("\n");
    expect(text).toContain("cmux-cua");
    expect(text).toContain("loaded twice");
    expect(text).toContain('drop "cmux" from "import"');
    expect(renderInjected([], ["cmux-cua"])).toEqual([]);
  });
});
