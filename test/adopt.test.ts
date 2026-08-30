import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { runAdopt, runRestore, runAutoAdopt } from "../src/cli/adopt.ts";
import { parseAddSpec, runAdd, runRemove } from "../src/cli/add.ts";
import { homeDir } from "../src/util/paths.ts";

let dir: string;
let home: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "autorouter-adopt-"));
  home = join(dir, "home");
  await mkdir(home, { recursive: true });
  // These tests rewrite harness configs, so the sandbox has to be real. Setting
  // HOME is not enough — Bun's os.homedir() reads the passwd entry and ignores
  // it — which is exactly why AUTOROUTER_HOME exists.
  process.env.AUTOROUTER_HOME = home;
  process.env.AUTOROUTER_CACHE_DIR = join(dir, "cache");
  process.env.AUTOROUTER_CONFIG = join(dir, "autorouter.json");
  await writeFile(join(dir, "autorouter.json"), JSON.stringify({ import: [], alwaysExpose: ["semble.search"] }));

  // Fail loudly rather than touch a real config if the override ever regresses.
  if (homeDir() !== home) throw new Error(`sandbox not in effect: homeDir() = ${homeDir()}`);
});

afterEach(async () => {
  delete process.env.AUTOROUTER_HOME;
  delete process.env.AUTOROUTER_CACHE_DIR;
  delete process.env.AUTOROUTER_CONFIG;
  await rm(dir, { recursive: true, force: true });
});

async function writeClaudeConfig(cwd: string) {
  await writeFile(
    join(home, ".claude.json"),
    JSON.stringify(
      {
        mcpServers: {
          autorouter: { command: "npx", args: ["autorouter", "serve"] },
          semble: { command: "uvx", args: ["semble"] },
          railway: { command: "npx", args: ["@railway/mcp"] },
        },
        projects: { [cwd]: { mcpServers: { linear: { url: "https://mcp.linear.app/mcp" } } } },
      },
      null,
      2,
    ),
  );
}

describe("adopt", () => {
  test("moves downstream servers out of the harness config", async () => {
    await writeClaudeConfig(dir);
    const { plans } = await runAdopt({ harness: "claude", cwd: dir, keep: [], dryRun: false });

    const after = JSON.parse(await readFile(join(home, ".claude.json"), "utf8"));
    expect(Object.keys(after.mcpServers)).toEqual(["autorouter", "semble"]);
    expect(after.projects[dir].mcpServers).toEqual({});
    expect(plans.flatMap((p) => p.moved).sort()).toEqual(["linear", "railway"]);
  });

  test("never moves the router itself", async () => {
    await writeClaudeConfig(dir);
    const { plans } = await runAdopt({ harness: "claude", cwd: dir, keep: [], dryRun: true });
    expect(plans.flatMap((p) => p.moved)).not.toContain("autorouter");
  });

  test("keeps servers backing an alwaysExpose pattern first-class", async () => {
    await writeClaudeConfig(dir);
    const { plans } = await runAdopt({ harness: "claude", cwd: dir, keep: [], dryRun: true });
    expect(plans.flatMap((p) => p.kept)).toContain("semble");
  });

  test("honours --keep", async () => {
    await writeClaudeConfig(dir);
    const { plans } = await runAdopt({ harness: "claude", cwd: dir, keep: ["railway"], dryRun: true });
    expect(plans.flatMap((p) => p.moved)).toEqual(["linear"]);
  });

  test("a dry run changes nothing on disk", async () => {
    await writeClaudeConfig(dir);
    const before = await readFile(join(home, ".claude.json"), "utf8");
    await runAdopt({ harness: "claude", cwd: dir, keep: [], dryRun: true });
    expect(await readFile(join(home, ".claude.json"), "utf8")).toBe(before);
  });

  test("moved servers land in the router's own config", async () => {
    await writeClaudeConfig(dir);
    await runAdopt({ harness: "claude", cwd: dir, keep: [], dryRun: false });
    const routerCfg = JSON.parse(await readFile(join(dir, "autorouter.json"), "utf8"));
    expect(Object.keys(routerCfg.servers).sort()).toEqual(["linear", "railway"]);
    expect(routerCfg.servers.railway.args).toEqual(["@railway/mcp"]);
  });

  test("restore puts the harness config back byte for byte", async () => {
    await writeClaudeConfig(dir);
    const before = await readFile(join(home, ".claude.json"), "utf8");
    await runAdopt({ harness: "claude", cwd: dir, keep: [], dryRun: false });
    expect(await readFile(join(home, ".claude.json"), "utf8")).not.toBe(before);

    await runRestore("claude");
    expect(await readFile(join(home, ".claude.json"), "utf8")).toBe(before);
  });

  test("adopting a codex config rewrites the TOML", async () => {
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(
      join(home, ".codex", "config.toml"),
      'model = "gpt-5.6"\n\n[mcp_servers.railway]\ncommand = "npx"\nargs = ["@railway/mcp"]\n',
    );
    await runAdopt({ harness: "codex", cwd: dir, keep: [], dryRun: false });
    const after = await readFile(join(home, ".codex", "config.toml"), "utf8");
    expect(after).not.toContain("mcp_servers.railway");
    expect(after).toContain("gpt-5.6");
  });

  test("the backup exists before the config is rewritten", async () => {
    await writeClaudeConfig(dir);
    const original = await readFile(join(home, ".claude.json"), "utf8");
    const { backup } = await runAdopt({ harness: "claude", cwd: dir, keep: [], dryRun: false });

    // Backups live outside the cache dir, which reindex is free to wipe.
    expect(backup).toBeTruthy();
    expect(backup!.startsWith(join(dir, "cache"))).toBe(false);
    const payload = JSON.parse(await readFile(backup!, "utf8"));
    expect(payload.files[join(home, ".claude.json")]).toBe(original);
  });

  test("reports nothing to do on an empty harness", async () => {
    const { plans, notes } = await runAdopt({ harness: "cursor", cwd: dir, keep: [], dryRun: true });
    expect(plans.flatMap((p) => p.moved)).toEqual([]);
    expect(notes[0]).toContain("Nothing to adopt");
  });
});

describe("adopt: skills and plugins", () => {
  /**
   * Moving MCP servers alone leaves skills and plugins fully loaded, which was
   * the whole complaint: the harness config shrinks but the prompt does not.
   */
  let home = "";
  const write = async (rel: string, body: string) => {
    const p = join(home, rel);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, body);
  };

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "autorouter-extras-"));
    process.env.AUTOROUTER_HOME = home;
    process.env.AUTOROUTER_CACHE_DIR = join(home, "cache");
    // The outer beforeEach pins AUTOROUTER_CONFIG to a different sandbox; these
    // tests need the config that lives inside their own home.
    delete process.env.AUTOROUTER_CONFIG;
    if (homeDir() !== home) throw new Error(`sandbox not in effect: homeDir() = ${homeDir()}`);

    await write(".claude/skills/demo/SKILL.md", "---\nname: demo\ndescription: A demo skill.\n---\nbody\n");
    await write(".claude/settings.json", JSON.stringify({ model: "opus", enabledPlugins: { "demoplug@mkt": true } }));
    await write("plug/.claude-plugin/plugin.json", JSON.stringify({
      name: "demoplug",
      mcpServers: { demosrv: { command: "echo", args: ["hi"] } },
    }));
    await write("plug/skills/ps/SKILL.md", "---\nname: plugskill\ndescription: From the plugin.\n---\n");
    await write(".claude/plugins/installed_plugins.json", JSON.stringify({
      version: 2,
      plugins: { "demoplug@mkt": [{ scope: "user", installPath: join(home, "plug") }] },
    }));
    await write(".claude.json", JSON.stringify({
      mcpServers: { demosrv: { command: "echo", args: ["hi"] } },
    }));
    await write(".config/autorouter/config.json", JSON.stringify({ import: ["claude", "plugins"] }));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  test("hides skills and disables plugins, and restore undoes both", async () => {
    const res = await runAdopt({ harness: "claude", cwd: home, keep: [], dryRun: false, extras: true });
    expect(res.extras?.plugins.map((p) => p.id)).toEqual(["demoplug@mkt"]);
    // The plugin's own skill is covered by disabling the plugin, so listing it
    // separately would be noise — only the user skill is overridden.
    expect(res.extras?.skills.map((s) => s.name)).toEqual(["demo"]);

    const settings = JSON.parse(await readFile(join(home, ".claude/settings.json"), "utf8"));
    expect(settings.skillOverrides.demo).toBe("user-invocable-only");
    expect(settings.enabledPlugins["demoplug@mkt"]).toBe(false);
    // Unrelated settings must survive the rewrite.
    expect(settings.model).toBe("opus");

    await runRestore("claude");
    const back = JSON.parse(await readFile(join(home, ".claude/settings.json"), "utf8"));
    expect(back.skillOverrides).toBeUndefined();
    expect(back.enabledPlugins["demoplug@mkt"]).toBe(true);
  });

  test("refuses to disable a plugin whose servers the router cannot reach", async () => {
    // Disabling the plugin would take away a server that currently works and
    // hand it to a router that cannot stand in for it — a strict loss.
    const res = await runAdopt({
      harness: "claude", cwd: home, keep: [], dryRun: true, extras: true,
      unreachable: new Set(["demosrv"]),
    });
    expect(res.extras?.plugins).toEqual([]);
    expect(res.extras?.skipped.join(" ")).toContain("cannot reach demosrv");
    // The plugin stays enabled, so its skills stay loaded too — hiding them
    // while the plugin is live would be a half-measure the user did not ask for.
    expect(res.extras?.skills.map((s) => s.name)).toEqual(["demo"]);
  });

  test("refuses to disable a plugin whose servers are not routed at all", async () => {
    // Without the plugins importer the router never learns about the plugin's
    // servers, so disabling it would delete them rather than route them.
    await write(".config/autorouter/config.json", JSON.stringify({ import: ["claude"] }));
    await write("plug/.claude-plugin/plugin.json", JSON.stringify({
      name: "demoplug",
      mcpServers: { demosrv: { command: "echo" }, extra: { command: "echo" } },
    }));
    const res = await runAdopt({ harness: "claude", cwd: home, keep: [], dryRun: true, extras: true });
    expect(res.extras?.plugins).toEqual([]);
    expect(res.extras?.skipped.join(" ")).toContain("extra");
    // Falls back to hiding the plugin's skills individually.
    expect(res.extras?.skills.map((s) => s.name).sort()).toEqual(["demo", "plugskill"]);
  });

  test("--servers-only leaves skills and plugins alone", async () => {
    const res = await runAdopt({ harness: "claude", cwd: home, keep: [], dryRun: false, extras: false });
    expect(res.extras).toBeNull();
    const settings = JSON.parse(await readFile(join(home, ".claude/settings.json"), "utf8"));
    expect(settings.skillOverrides).toBeUndefined();
    expect(settings.enabledPlugins["demoplug@mkt"]).toBe(true);
  });

  test("keepSkills and keepPlugins are honoured", async () => {
    const res = await runAdopt({
      harness: "claude", cwd: home, keep: [], dryRun: true, extras: true,
      keepSkills: ["demo"], keepPlugins: ["demoplug"],
    });
    expect(res.extras?.skills).toEqual([]);
    expect(res.extras?.plugins).toEqual([]);
  });

  test("other harnesses have no skills or plugins to hide", async () => {
    const res = await runAdopt({ harness: "cursor", cwd: home, keep: [], dryRun: true, extras: true });
    expect(res.extras).toBeNull();
  });
});

describe("add", () => {
  test("registers an http server the next resolve returns", async () => {
    const res = await runAdd({ name: "linear", url: "https://mcp.linear.app/mcp" }, dir);
    // The fixture URL does not answer, which is the common case for a fresh
    // OAuth server — the entry must still be saved, or `autorouter login` has
    // nothing to authorize.
    expect(res.path).toBeTruthy();
    const written = JSON.parse(await readFile(process.env.AUTOROUTER_CONFIG!, "utf8"));
    expect(written.servers.linear).toEqual({ url: "https://mcp.linear.app/mcp" });
  }, 30_000);

  test("accepts a pasted mcpServers snippet, and a bare entry with a name", async () => {
    expect(parseAddSpec({ json: '{"mcpServers":{"linear":{"url":"https://x/mcp"}}}' })).toEqual({
      name: "linear",
      raw: { url: "https://x/mcp" },
    });
    expect(parseAddSpec({ name: "foo", json: '{"command":"npx","args":["foo"]}' })).toEqual({
      name: "foo",
      raw: { command: "npx", args: ["foo"] },
    });
  });

  test("a multi-server snippet has to say which one", () => {
    const json = '{"mcpServers":{"a":{"url":"https://a"},"b":{"url":"https://b"}}}';
    expect(() => parseAddSpec({ json })).toThrow(/2 servers/);
    expect(parseAddSpec({ name: "b", json }).raw).toEqual({ url: "https://b" });
  });

  test("refuses to register the router with itself", async () => {
    const res = await runAdd({ name: "loop", command: "npx", args: ["autorouter", "serve"] }, dir);
    expect(res.ok).toBe(false);
    expect(res.message).toContain("recurse");
    const written = JSON.parse(await readFile(process.env.AUTOROUTER_CONFIG!, "utf8"));
    expect(written.servers?.loop).toBeUndefined();
  });

  test("remove reports a name that was never there", async () => {
    expect(await runRemove("nope", dir)).toContain('No server named "nope"');
  });

  test("remove warns when a harness will just re-import it", async () => {
    await writeClaudeConfig(dir);
    await writeFile(
      process.env.AUTOROUTER_CONFIG!,
      JSON.stringify({ import: ["claude"], servers: { railway: { command: "npx", args: ["@railway/mcp"] } } }),
    );
    const note = await runRemove("railway", dir);
    expect(note).toContain("a harness still registers it");
  });
});

describe("auto-adopt", () => {
  test("empties the harness config and is a no-op the second time", async () => {
    await writeClaudeConfig(dir);
    await writeFile(process.env.AUTOROUTER_CONFIG!, JSON.stringify({ import: ["claude"] }));

    const first = await runAutoAdopt(dir);
    expect(first.join(" ")).toContain("adopted");
    const after = JSON.parse(await readFile(join(home, ".claude.json"), "utf8"));
    expect(Object.keys(after.mcpServers)).toEqual(["autorouter"]);

    // Idempotence is what makes this safe to run on every staleness check: a
    // second pass must not rewrite the file or emit a second notification.
    expect(await runAutoAdopt(dir)).toEqual([]);
  }, 30_000);

  test("does nothing when switched off", async () => {
    await writeClaudeConfig(dir);
    await writeFile(
      process.env.AUTOROUTER_CONFIG!,
      JSON.stringify({ import: ["claude"], autoAdopt: false }),
    );
    expect(await runAutoAdopt(dir)).toEqual([]);
    const after = JSON.parse(await readFile(join(home, ".claude.json"), "utf8"));
    expect(Object.keys(after.mcpServers)).toContain("railway");
  });

  test("leaves skills and plugins alone", async () => {
    await writeClaudeConfig(dir);
    await writeFile(join(home, ".claude"), "", { flag: "a" }).catch(() => {});
    await writeFile(process.env.AUTOROUTER_CONFIG!, JSON.stringify({ import: ["claude"] }));
    await runAutoAdopt(dir);
    // settings.json is where skill and plugin state lives; auto-adopt must not
    // have created or touched it.
    await expect(readFile(join(home, ".claude", "settings.json"), "utf8")).rejects.toThrow();
  }, 30_000);
});
