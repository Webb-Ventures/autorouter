import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { readPluginContents } from "../src/config/adapters/pluginContents.ts";
import { planExtras, applyExtras } from "../src/cli/adoptExtras.ts";
import { homeDir, claudeInstall } from "../src/util/paths.ts";

/**
 * Plugins that contribute things the router has no equivalent for — LSP
 * servers above all — must never be disabled by adopt. The official LSP
 * plugins ship no plugin.json at all: their marketplace entry is the manifest.
 */
let home = "";
const write = async (rel: string, body: unknown) => {
  const p = join(home, rel);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, typeof body === "string" ? body : JSON.stringify(body));
};

const MKT = ".claude/plugins/marketplaces/official";

async function install(name: string, marketplace = "official") {
  const root = join(home, "cache", marketplace, name);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "README.md"), "readme");
  return { key: `${name}@${marketplace}`, name, root };
}

async function registerAll(plugins: { key: string; root: string }[]) {
  await write(".claude/plugins/installed_plugins.json", {
    version: 2,
    plugins: Object.fromEntries(plugins.map((p) => [p.key, [{ scope: "user", installPath: p.root }]])),
  });
}

const plan = (routed: string[] = [], keepPlugins: string[] = []) =>
  planExtras({
    cwd: home,
    skillPaths: ["~/.claude/skills"],
    keepSkills: [],
    keepPlugins,
    mode: "name-only",
    routedServers: new Set(routed),
  });

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "autorouter-plugin-contents-"));
  process.env.AUTOROUTER_HOME = home;
  if (homeDir() !== home) throw new Error(`sandbox not in effect: homeDir() = ${homeDir()}`);
  await write(".claude/settings.json", { enabledPlugins: {} });
});

afterEach(async () => {
  delete process.env.AUTOROUTER_HOME;
  await rm(home, { recursive: true, force: true });
});

describe("readPluginContents", () => {
  test("reads lspServers from the marketplace entry of a plugin with no plugin.json", async () => {
    const p = await install("rust-analyzer-lsp");
    await write(`${MKT}/.claude-plugin/marketplace.json`, {
      name: "official",
      plugins: [
        { name: "other", source: "./x" },
        {
          name: "rust-analyzer-lsp",
          source: "./plugins/rust-analyzer-lsp",
          strict: false,
          lspServers: { "rust-analyzer": { command: "rust-analyzer", extensionToLanguage: { ".rs": "rust" } } },
        },
      ],
    });
    const c = await readPluginContents(p);
    expect(c.servers).toEqual([]);
    expect(c.unroutable).toEqual([{ kind: "LSP servers", names: ["rust-analyzer"] }]);
  });

  test("finds the marketplace through known_marketplaces.json", async () => {
    const p = await install("swift-lsp", "elsewhere");
    const location = join(home, "custom-mkt");
    await write(".claude/plugins/known_marketplaces.json", { elsewhere: { installLocation: location } });
    await write("custom-mkt/.claude-plugin/marketplace.json", {
      plugins: [{ name: "swift-lsp", lspServers: { "sourcekit-lsp": { command: "sourcekit-lsp" } } }],
    });
    expect((await readPluginContents(p)).unroutable).toEqual([{ kind: "LSP servers", names: ["sourcekit-lsp"] }]);
  });

  test("reads marketplaces from the install the plugin belongs to", async () => {
    // A second install (CLAUDE_CONFIG_DIR=~/.claude-work) keeps its own
    // marketplaces; the default install's copy must not be consulted.
    const p = await install("go-lsp");
    await write(".claude-work/plugins/marketplaces/official/.claude-plugin/marketplace.json", {
      plugins: [{ name: "go-lsp", lspServers: { gopls: { command: "gopls" } } }],
    });
    expect((await readPluginContents(p)).unroutable).toEqual([]);
    const work = claudeInstall(join(home, ".claude-work"));
    expect((await readPluginContents(p, work)).unroutable).toEqual([{ kind: "LSP servers", names: ["gopls"] }]);
  });

  test("reads every default location and every manifest form", async () => {
    const p = await install("full");
    const at = (rel: string) => join("cache", "official", "full", rel);
    await write(at(".claude-plugin/plugin.json"), {
      name: "full",
      mcpServers: ["./more-mcp.json", { inline: { command: "x" } }],
      lspServers: "./lsp/servers.json",
      hooks: { PreToolUse: [] },
      agents: ["./custom/reviewer.md"],
    });
    await write(at(".mcp.json"), { mcpServers: { dflt: { command: "x" } } });
    await write(at("more-mcp.json"), { extra: { command: "x" } });
    await write(at(".lsp.json"), { go: { command: "gopls" } });
    await write(at("lsp/servers.json"), { py: { command: "pyright" } });
    await write(at("hooks/hooks.json"), { hooks: { SessionStart: [] } });
    await write(at("commands/sub/deploy.md"), "cmd");
    // The manifest's agents key replaces the default agents/ directory.
    await write(at("agents/ignored.md"), "agent");
    await write(at("custom/reviewer.md"), "agent");
    await write(at("output-styles/terse.md"), "style");
    await write(at("monitors/monitors.json"), [{ name: "watch", command: "x", description: "d" }]);
    await write(at("bin/tool"), "#!/bin/sh");

    const c = await readPluginContents(p);
    expect(c.servers.sort()).toEqual(["dflt", "extra", "inline"]);
    expect(Object.fromEntries(c.unroutable.map((u) => [u.kind, u.names]))).toEqual({
      "LSP servers": ["go", "py"],
      hooks: ["SessionStart", "PreToolUse"],
      commands: ["sub/deploy"],
      agents: ["reviewer"],
      "output styles": ["terse"],
      monitors: ["watch"],
      executables: ["tool"],
    });
  });

  test("a plugin with only MCP servers and skills has nothing unroutable", async () => {
    const p = await install("plain");
    await write("cache/official/plain/.claude-plugin/plugin.json", { name: "plain", mcpServers: { s: { command: "x" } } });
    await write("cache/official/plain/skills/a/SKILL.md", "---\nname: a\ndescription: A.\n---\n");
    expect(await readPluginContents(p)).toEqual({ servers: ["s"], unroutable: [] });
  });
});

describe("planExtras with unroutable plugin contents", () => {
  async function lspPlugin() {
    const p = await install("rust-analyzer-lsp");
    await write(`${MKT}/.claude-plugin/marketplace.json`, {
      plugins: [{ name: "rust-analyzer-lsp", strict: false, lspServers: { "rust-analyzer": { command: "rust-analyzer" } } }],
    });
    return p;
  }

  test("leaves an LSP-only plugin enabled and says why", async () => {
    await registerAll([await lspPlugin()]);
    const res = await plan();
    expect(res.plugins).toEqual([]);
    expect(res.skipped).toEqual([
      "plugin rust-analyzer-lsp (contributes LSP servers rust-analyzer, which the router cannot stand in for)",
    ]);
  });

  test("leaves a plugin with routed servers but hooks enabled", async () => {
    const p = await install("hooked");
    await write("cache/official/hooked/.claude-plugin/plugin.json", { name: "hooked", mcpServers: { srv: { command: "x" } } });
    await write("cache/official/hooked/hooks/hooks.json", { hooks: { PostToolUse: [] } });
    await registerAll([p]);
    const res = await plan(["srv"]);
    expect(res.plugins).toEqual([]);
    expect(res.skipped.join(" ")).toContain("hooks PostToolUse");
  });

  test("an already-disabled LSP plugin is flagged with how to re-enable it", async () => {
    const p = await lspPlugin();
    await registerAll([p]);
    await write(".claude/settings.json", { enabledPlugins: { [p.key]: false } });
    const res = await plan();
    expect(res.plugins).toEqual([]);
    const note = res.skipped.join(" ");
    expect(note).toContain("already disabled");
    expect(note).toContain(`enabledPlugins["${p.key}"] to true`);
  });

  test("'skills only' means the router actually indexes the plugin's skills", async () => {
    const skilled = await install("skilled");
    await write("cache/official/skilled/skills/s1/SKILL.md", "---\nname: s1\ndescription: One.\n---\n");
    const empty = await install("empty");
    await registerAll([skilled, empty]);
    const res = await plan();
    expect(res.plugins).toEqual([
      { id: skilled.key, name: "skilled", reason: "skills only — the router indexes its 1 skill(s)" },
    ]);
    expect(res.skipped).toEqual(["plugin empty (contributes no MCP servers or skills — nothing to route)"]);
  });

  test("a plugin whose server lives in the default .mcp.json is not mistaken for skills-only", async () => {
    // plugin.json-only parsing used to miss .mcp.json, label the plugin
    // "skills only" and disable it along with an unrouted server.
    const p = await install("dotmcp");
    await write("cache/official/dotmcp/.mcp.json", { mcpServers: { hidden: { command: "x" } } });
    await write("cache/official/dotmcp/skills/s/SKILL.md", "---\nname: s\ndescription: S.\n---\n");
    await registerAll([p]);
    const res = await plan();
    expect(res.plugins).toEqual([]);
    expect(res.skipped.join(" ")).toContain("its server hidden is not routed");
  });

  test("applying the plan never touches an LSP plugin's enabled state", async () => {
    const p = await lspPlugin();
    await registerAll([p]);
    await write(".claude/settings.json", { enabledPlugins: { [p.key]: true } });
    await applyExtras(await plan());
    const settings = JSON.parse(await readFile(join(home, ".claude/settings.json"), "utf8"));
    expect(settings.enabledPlugins[p.key]).toBe(true);
  });

  test("--keep-plugin still short-circuits before any analysis", async () => {
    await registerAll([await lspPlugin()]);
    const res = await plan([], ["rust-analyzer-lsp"]);
    expect(res.plugins).toEqual([]);
    expect(res.skipped).toEqual([]);
  });
});
