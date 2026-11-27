import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, mkdir, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  claudeInstall,
  claudeSettingsPath,
  discoverClaudeInstalls,
  homeDir,
  inClaudeDir,
} from "../src/util/paths.ts";
import { loadClaude } from "../src/config/adapters/claude.ts";
import { listInstalledPlugins } from "../src/config/adapters/plugins.ts";
import { collectSkills } from "../src/catalog/providers/skills.ts";
import { projectsDir } from "../src/util/transcripts.ts";
import { resolveConfig } from "../src/config/resolve.ts";
import { catalogPath } from "../src/catalog/build.ts";
import { runAdopt, runRestore, backupDir } from "../src/cli/adopt.ts";
import { DEFAULT_CONFIG } from "../src/config/types.ts";
import { runDoctor } from "../src/cli/doctor.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

let home = "";
let work = "";

const write = async (rel: string, body: unknown) => {
  const p = join(home, rel);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, typeof body === "string" ? body : JSON.stringify(body, null, 2));
};
const readJsonFile = async (rel: string) => JSON.parse(await readFile(join(home, rel), "utf8"));
const skill = (name: string) => `---\nname: ${name}\ndescription: The ${name} skill.\n---\nbody\n`;

/**
 * Two installs, laid out the way Claude Code lays them out: the default keeps
 * its state file beside ~/.claude, the other keeps it inside its own dir.
 */
async function twoInstalls() {
  await write(".claude.json", { mcpServers: { autorouter: { command: "autorouter" }, railway: { command: "railway-mcp" } } });
  await write(".claude/settings.json", { model: "opus" });
  await write(".claude/skills/shared/SKILL.md", skill("shared"));

  await write(".claude-bts/.claude.json", { mcpServers: { autorouter: { command: "autorouter" }, linear: { command: "linear-mcp" } } });
  await write(".claude-bts/settings.json", { model: "sonnet" });
  await write(".claude-bts/skills/port-mainstage/SKILL.md", skill("port-mainstage"));
  await write(".claude-bts/skills/keepme/SKILL.md", skill("keepme"));
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "autorouter-installs-"));
  work = join(home, "work");
  await mkdir(work, { recursive: true });
  process.env.AUTOROUTER_HOME = home;
  process.env.AUTOROUTER_CACHE_DIR = join(home, "cache");
  delete process.env.AUTOROUTER_CONFIG;
  delete process.env.CLAUDE_CONFIG_DIR;
  await write(".config/autorouter/config.json", { import: ["claude", "plugins"] });
  if (homeDir() !== home) throw new Error(`sandbox not in effect: homeDir() = ${homeDir()}`);
});

afterEach(async () => {
  delete process.env.AUTOROUTER_HOME;
  delete process.env.AUTOROUTER_CACHE_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
  await rm(home, { recursive: true, force: true });
});

describe("Claude path resolution", () => {
  test("without CLAUDE_CONFIG_DIR: ~/.claude, with its state file beside it", () => {
    const i = claudeInstall();
    expect(i).toEqual({ dir: join(home, ".claude"), claudeJson: join(home, ".claude.json"), isDefault: true });
    expect(claudeSettingsPath()).toBe(join(home, ".claude", "settings.json"));
  });

  test("with CLAUDE_CONFIG_DIR: everything, the state file included, comes from that dir", () => {
    process.env.CLAUDE_CONFIG_DIR = join(home, ".claude-bts");
    const i = claudeInstall();
    expect(i.dir).toBe(join(home, ".claude-bts"));
    expect(i.claudeJson).toBe(join(home, ".claude-bts", ".claude.json"));
    expect(i.isDefault).toBe(false);
    expect(claudeSettingsPath()).toBe(join(home, ".claude-bts", "settings.json"));
    expect(projectsDir()).toBe(join(home, ".claude-bts", "projects"));
    expect(inClaudeDir("~/.claude/skills")).toBe(join(home, ".claude-bts", "skills"));
    expect(inClaudeDir("~/.config/skills")).toBe("~/.config/skills");
  });

  test("CLAUDE_CONFIG_DIR=~/.claude puts the state file inside it, as Claude Code does", () => {
    process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
    expect(claudeInstall().claudeJson).toBe(join(home, ".claude", ".claude.json"));
    // Named without the variable, ~/.claude is the default install.
    delete process.env.CLAUDE_CONFIG_DIR;
    expect(claudeInstall(join(home, ".claude")).claudeJson).toBe(join(home, ".claude.json"));
  });

  test("a legacy .config.json is read when .claude.json is missing", async () => {
    await write(".claude-old/.config.json", { mcpServers: {} });
    expect(claudeInstall(join(home, ".claude-old")).claudeJson).toBe(join(home, ".claude-old", ".config.json"));
    await write(".claude-old/.claude.json", { mcpServers: {} });
    expect(claudeInstall(join(home, ".claude-old")).claudeJson).toBe(join(home, ".claude-old", ".claude.json"));
  });

  test("a CLAUDE_CONFIG_DIR outside the AUTOROUTER_HOME sandbox is ignored", () => {
    process.env.CLAUDE_CONFIG_DIR = join(tmpdir(), "definitely-not-in-the-sandbox");
    expect(claudeInstall().dir).toBe(join(home, ".claude"));
  });

  test("discovery finds ~/.claude* dirs that look like installs, default first", async () => {
    await twoInstalls();
    await write(".claude-wv-2/settings.json", {});
    await mkdir(join(home, ".claude-empty"), { recursive: true });
    await write(".claude.json.bak", "{}");
    expect(discoverClaudeInstalls().map((i) => i.dir)).toEqual([
      join(home, ".claude"),
      join(home, ".claude-bts"),
      join(home, ".claude-wv-2"),
    ]);
  });

  test("servers, plugins, skills and sources follow the active install", async () => {
    await twoInstalls();
    await write("plug/skills/ps/SKILL.md", skill("plugskill"));
    await write(".claude-bts/plugins/installed_plugins.json", {
      plugins: { "btsplug@mkt": [{ installPath: join(home, "plug") }] },
    });

    expect((await loadClaude(work)).map((s) => s.name).sort()).toEqual(["autorouter", "railway"]);
    expect(await listInstalledPlugins()).toEqual([]);

    process.env.CLAUDE_CONFIG_DIR = join(home, ".claude-bts");
    expect((await loadClaude(work)).map((s) => s.name).sort()).toEqual(["autorouter", "linear"]);
    expect((await listInstalledPlugins()).map((p) => p.key)).toEqual(["btsplug@mkt"]);

    const { capabilities } = await collectSkills(DEFAULT_CONFIG.skillPaths, work);
    const names = capabilities.map((c) => c.name).sort();
    expect(names).toEqual(["keepme", "plugskill", "port-mainstage"]);
    expect(names).not.toContain("shared");

    const resolved = await resolveConfig(work);
    expect(resolved.install.dir).toBe(join(home, ".claude-bts"));
    expect(resolved.sources).toContain(join(home, ".claude-bts", ".claude.json"));
    expect(resolved.sources).toContain(join(home, ".claude-bts", "settings.json"));
    expect(resolved.sources).not.toContain(join(home, ".claude.json"));
  });

  test("each install gets its own catalog file", () => {
    const main = catalogPath(work);
    process.env.CLAUDE_CONFIG_DIR = join(home, ".claude-bts");
    expect(catalogPath(work)).not.toBe(main);
  });
});

describe("adopt and restore across installs", () => {
  const bts = () => claudeInstall(join(home, ".claude-bts"));
  const main = () => claudeInstall(join(home, ".claude"));

  test("each install is adopted in its own files, with its own backup", async () => {
    await twoInstalls();
    for (const install of [main(), bts()]) {
      await runAdopt({ harness: "claude", cwd: work, keep: [], dryRun: false, extras: true, install });
    }

    expect(Object.keys((await readJsonFile(".claude.json")).mcpServers)).toEqual(["autorouter"]);
    expect(Object.keys((await readJsonFile(".claude-bts/.claude.json")).mcpServers)).toEqual(["autorouter"]);
    expect((await readJsonFile(".claude/settings.json")).skillOverrides).toEqual({ shared: "name-only" });
    expect((await readJsonFile(".claude-bts/settings.json")).skillOverrides).toEqual({
      keepme: "name-only",
      "port-mainstage": "name-only",
    });
    // Both installs' servers land in the one router config.
    expect(Object.keys((await readJsonFile(".config/autorouter/config.json")).servers).sort()).toEqual([
      "linear",
      "railway",
    ]);

    const backups = (await readdir(backupDir())).sort();
    expect(backups).toHaveLength(2);
    const tags = await Promise.all(backups.map(async (b) => JSON.parse(await readFile(join(backupDir(), b), "utf8")).configDir));
    expect(tags.sort()).toEqual([join(home, ".claude"), join(home, ".claude-bts")]);
  });

  test("restore undoes one install and leaves the other adopted", async () => {
    await twoInstalls();
    const before = await readFile(join(home, ".claude-bts/.claude.json"), "utf8");
    const beforeSettings = await readFile(join(home, ".claude-bts/settings.json"), "utf8");
    for (const install of [main(), bts()]) {
      await runAdopt({ harness: "claude", cwd: work, keep: [], dryRun: false, extras: true, install });
    }

    const notes = await runRestore("claude", { install: bts() });
    expect(notes.join("\n")).toContain(join(home, ".claude-bts", ".claude.json"));
    expect(await readFile(join(home, ".claude-bts/.claude.json"), "utf8")).toBe(before);
    expect(await readFile(join(home, ".claude-bts/settings.json"), "utf8")).toBe(beforeSettings);
    // The default install is still adopted.
    expect(Object.keys((await readJsonFile(".claude.json")).mcpServers)).toEqual(["autorouter"]);

    await runRestore("claude", { install: main() });
    expect(Object.keys((await readJsonFile(".claude.json")).mcpServers).sort()).toEqual(["autorouter", "railway"]);
  });

  test("restore with CLAUDE_CONFIG_DIR set restores that install", async () => {
    await twoInstalls();
    const before = await readFile(join(home, ".claude-bts/.claude.json"), "utf8");
    await runAdopt({ harness: "claude", cwd: work, keep: [], dryRun: false, install: bts() });
    await runAdopt({ harness: "claude", cwd: work, keep: [], dryRun: false, install: main() });
    process.env.CLAUDE_CONFIG_DIR = join(home, ".claude-bts");
    await runRestore("claude");
    expect(await readFile(join(home, ".claude-bts/.claude.json"), "utf8")).toBe(before);
    expect(Object.keys((await readJsonFile(".claude.json")).mcpServers)).toEqual(["autorouter"]);
  });

  test("a backup from before installs were tracked belongs to the default install", async () => {
    await twoInstalls();
    await mkdir(backupDir(), { recursive: true });
    await writeFile(
      join(backupDir(), "claude-2020-01-01T00-00-00-000Z.json"),
      JSON.stringify({ harness: "claude", files: { [join(home, ".claude.json")]: "{}\n" } }),
    );
    expect((await runRestore("claude", { install: bts() }))[0]).toContain("No adoption backups");
    await runRestore("claude", { install: main() });
    expect(await readFile(join(home, ".claude.json"), "utf8")).toBe("{}\n");
  });

  test("--keep-skill, --keep-plugin, --servers-only and --dry-run apply per install", async () => {
    await twoInstalls();
    await write("plug/.claude-plugin/plugin.json", { name: "btsplug" });
    await write("plug/skills/ps/SKILL.md", skill("plugskill"));
    await write(".claude-bts/plugins/installed_plugins.json", {
      plugins: { "btsplug@mkt": [{ installPath: join(home, "plug") }] },
    });
    const opts = { harness: "claude" as const, cwd: work, keep: [], extras: true, keepSkills: ["keepme"], keepPlugins: ["btsplug"] };

    const dry = await runAdopt({ ...opts, dryRun: true, install: bts() });
    expect(dry.extras?.skills.map((s) => s.name)).toEqual(["port-mainstage"]);
    expect(dry.extras?.plugins).toEqual([]);
    expect(dry.extras?.file).toBe(join(home, ".claude-bts", "settings.json"));
    expect(Object.keys((await readJsonFile(".claude-bts/.claude.json")).mcpServers)).toContain("linear");

    const serversOnly = await runAdopt({ ...opts, extras: false, dryRun: false, install: bts() });
    expect(serversOnly.extras).toBeNull();
    expect((await readJsonFile(".claude-bts/settings.json")).skillOverrides).toBeUndefined();

    await runAdopt({ ...opts, dryRun: false, install: bts() });
    const settings = await readJsonFile(".claude-bts/settings.json");
    expect(settings.skillOverrides).toEqual({ "port-mainstage": "name-only" });
    expect(settings.enabledPlugins?.["btsplug@mkt"]).toBeUndefined();
    // The other install was never touched.
    expect(await readJsonFile(".claude/settings.json")).toEqual({ model: "opus" });
  });
});

describe("CLI", () => {
  const cli = (args: string[], env: Record<string, string> = {}) => {
    const base: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "CLAUDE_CONFIG_DIR") base[k] = v;
    const r = Bun.spawnSync(["bun", CLI, ...args], { cwd: work, env: { ...base, ...env } });
    return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
  };

  test("adopt --all-claude-dirs --dry-run plans every install and changes nothing", async () => {
    await twoInstalls();
    const before = await readFile(join(home, ".claude-bts/.claude.json"), "utf8");
    const r = cli(["adopt", "--target", "claude", "--all-claude-dirs", "--dry-run", "--keep-skill", "keepme"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("== ~/.claude ==");
    expect(r.out).toContain("== ~/.claude-bts ==");
    expect(r.out).toContain(join(home, ".claude-bts", "settings.json"));
    expect(r.out).toContain("port-mainstage");
    expect(r.out).not.toContain("hide skill      keepme");
    expect(await readFile(join(home, ".claude-bts/.claude.json"), "utf8")).toBe(before);
  });

  test("dry run under CLAUDE_CONFIG_DIR lists that install's files, not ~/.claude's", async () => {
    await twoInstalls();
    const r = cli(["adopt", "--target", "claude", "--dry-run"], { CLAUDE_CONFIG_DIR: join(home, ".claude-bts") });
    expect(r.code).toBe(0);
    expect(r.out).toContain(join(home, ".claude-bts", "settings.json"));
    expect(r.out).not.toContain(join(home, ".claude", "settings.json"));
  });

  test("repeated --config-dir adopts each, and restore undoes each", async () => {
    await twoInstalls();
    await write(".claude-wv/.claude.json", { mcpServers: { datadog: { command: "dd-mcp" } } });
    const before = await readFile(join(home, ".claude-wv/.claude.json"), "utf8");
    const dirs = ["--config-dir", join(home, ".claude-bts"), "--config-dir", join(home, ".claude-wv")];
    const r = cli(["adopt", "--target", "claude", ...dirs, "--servers-only", "--yes"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Undo with: autorouter restore --target claude --config-dir");
    expect((await readJsonFile(".claude-wv/.claude.json")).mcpServers).toEqual({});
    expect(Object.keys((await readJsonFile(".claude-bts/.claude.json")).mcpServers)).toEqual(["autorouter"]);
    // Not named, not touched.
    expect(Object.keys((await readJsonFile(".claude.json")).mcpServers).sort()).toEqual(["autorouter", "railway"]);

    const back = cli(["restore", "--target", "claude", ...dirs]);
    expect(back.code).toBe(0);
    expect(await readFile(join(home, ".claude-wv/.claude.json"), "utf8")).toBe(before);
    expect(Object.keys((await readJsonFile(".claude-bts/.claude.json")).mcpServers).sort()).toEqual(["autorouter", "linear"]);
  });

  test("--config-dir is refused for other harnesses and for missing dirs", () => {
    expect(cli(["adopt", "--target", "codex", "--config-dir", join(home, ".claude-bts")]).code).toBe(1);
    const r = cli(["adopt", "--target", "claude", "--config-dir", join(home, ".claude-nope"), "--dry-run"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("no such directory");
  });
});

describe("doctor", () => {
  test("reports every install and what each still loads", async () => {
    await twoInstalls();
    await write(".claude-bts/.claude.json", { mcpServers: { linear: { command: "linear-mcp" } } });
    await write(".config/autorouter/config.json", { import: [] });
    const out = await runDoctor(work);
    expect(out).toContain("## Claude Code installs (2)");
    expect(out).toContain("~/.claude  (active)");
    expect(out).toContain("~/.claude-bts");
    expect(out).toMatch(/~\/\.claude-bts\n\s+state: .*\.claude-bts\/\.claude\.json\n\s+router: NOT registered/);
    expect(out).toContain("claude ~/.claude-bts");
    expect(out).toContain("→ autorouter adopt --target claude --config-dir ~/.claude-bts");
    expect(out).toContain("port-mainstage");
  });
});
