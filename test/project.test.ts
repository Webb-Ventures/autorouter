import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, mkdir, rm, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { homeDir } from "../src/util/paths.ts";
import { loadClaude, loadMcpjson } from "../src/config/adapters/claude.ts";
import { resolveConfig } from "../src/config/resolve.ts";
import { collectSkills } from "../src/catalog/providers/skills.ts";
import { approveServers, mcpjsonApproval } from "../src/workspace/trust.ts";
import { planProjectAdopt, applyProjectAdopt, restoreProject, runProjectAdopt } from "../src/workspace/project.ts";
import { planExtras } from "../src/cli/adoptExtras.ts";
import { applyRepair, planRepair } from "../src/cli/repair.ts";
import { workspaceRoot, rootToPath } from "../src/workspace/root.ts";

let base: string;
let home: string;
let repo: string;

const write = async (path: string, body: string | object) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof body === "string" ? body : JSON.stringify(body, null, 2));
};
const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const skill = (dir: string, name: string) =>
  write(join(dir, ".claude", "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill.\n---\nbody\n`);

const MCPJSON = {
  mcpServers: {
    remote: { type: "http", url: "https://mcp.example.com/mcp" },
    local: { type: "stdio", command: "npx", args: ["some-mcp"] },
  },
};

async function trust(root: string, extra: object = {}) {
  await write(join(home, ".claude.json"), { projects: { [root]: { hasTrustDialogAccepted: true, ...extra } } });
}

beforeEach(async () => {
  // realpath: macOS tmpdir is a symlink, and roots are compared as resolved paths.
  base = await realpath(await mkdtemp(join(tmpdir(), "autorouter-project-")));
  home = join(base, "home");
  repo = join(base, "repo");
  await mkdir(home, { recursive: true });
  await mkdir(join(repo, ".git"), { recursive: true });
  process.env.AUTOROUTER_HOME = home;
  process.env.AUTOROUTER_CACHE_DIR = join(base, "cache");
  process.env.AUTOROUTER_CONFIG = join(base, "autorouter.json");
  await write(join(base, "autorouter.json"), { import: ["claude"] });
  if (homeDir() !== home) throw new Error(`sandbox not in effect: homeDir() = ${homeDir()}`);
});

afterEach(async () => {
  delete process.env.AUTOROUTER_HOME;
  delete process.env.AUTOROUTER_CACHE_DIR;
  delete process.env.AUTOROUTER_CONFIG;
  delete process.env.CLAUDE_PROJECT_DIR;
  await rm(base, { recursive: true, force: true });
});

describe("workspace root", () => {
  test("prefers the host's roots, then CLAUDE_PROJECT_DIR, then cwd", () => {
    expect(workspaceRoot([`file://${repo}`])).toBe(repo);
    process.env.CLAUDE_PROJECT_DIR = repo;
    expect(workspaceRoot([])).toBe(repo);
    expect(rootToPath("https://example.com")).toBeNull();
  });
});

describe(".mcp.json trust", () => {
  test("an untrusted folder's servers are never launched by the router", async () => {
    await write(join(repo, ".mcp.json"), MCPJSON);
    expect(await loadClaude(repo)).toEqual([]);
  });

  test("in a trusted folder, http servers are allowed and stdio ones need approval", async () => {
    await write(join(repo, ".mcp.json"), MCPJSON);
    await trust(repo);
    expect((await loadClaude(repo)).map((s) => s.name)).toEqual(["remote"]);
  });

  test("Claude Code's own approval counts", async () => {
    await write(join(repo, ".mcp.json"), MCPJSON);
    await trust(repo, { enabledMcpjsonServers: ["local"] });
    expect((await loadClaude(repo)).map((s) => s.name).sort()).toEqual(["local", "remote"]);
  });

  test("a committed settings file cannot approve its own repo's servers until trusted", async () => {
    await write(join(repo, ".mcp.json"), MCPJSON);
    await write(join(repo, ".claude", "settings.json"), { enableAllProjectMcpServers: true });
    expect(await loadClaude(repo)).toEqual([]);
  });

  test("autorouter approve pins the exact command", async () => {
    await write(join(repo, ".mcp.json"), MCPJSON);
    await trust(repo);
    const local = (await loadMcpjson(repo)).find((e) => e.entry.name === "local")!.entry;
    await approveServers(repo, [local]);
    expect((await mcpjsonApproval(repo)).approved(local)).toBe(true);

    // Editing the command in the repo invalidates the approval.
    await write(join(repo, ".mcp.json"), { mcpServers: { local: { command: "npx", args: ["evil"] } } });
    const edited = (await loadMcpjson(repo))[0]!;
    expect(edited.approved).toBe(false);
  });
});

describe("project skills", () => {
  test("found from cwd up to the git root and in nested subdirectories, tagged as project", async () => {
    await skill(repo, "root-skill");
    await skill(join(repo, "apps", "web"), "web-skill");
    await skill(join(repo, "node_modules", "pkg"), "vendored");
    await skill(home, "user-skill");
    const sub = join(repo, "apps", "web", "src");
    await mkdir(sub, { recursive: true });

    const { capabilities, sources } = await collectSkills(["~/.claude/skills", ".claude/skills"], sub, {
      includePlugins: false,
    });
    const byName = Object.fromEntries(capabilities.map((c) => [c.name, c.origin]));
    expect(byName).toEqual({ "user-skill": "user", "web-skill": "project", "root-skill": "project" });
    // Skill directories are fingerprinted, so adding a skill re-indexes.
    expect(sources).toContain(join(repo, ".claude", "skills"));
  });

  test("in the home directory, .claude/skills is user scope", async () => {
    await skill(home, "user-skill");
    const { capabilities } = await collectSkills([".claude/skills"], home, { includePlugins: false });
    expect(capabilities.map((c) => c.origin)).toEqual([]);
  });

  test("user-level adopt never hides a project skill", async () => {
    await skill(repo, "proj");
    await skill(home, "mine");
    const plan = await planExtras({
      cwd: repo,
      skillPaths: ["~/.claude/skills", ".claude/skills"],
      keepSkills: [],
      keepPlugins: [],
      mode: "name-only",
      routedServers: new Set(),
    });
    expect(plan.skills.map((s) => s.name)).toEqual(["mine"]);
  });
});

describe("project adoption", () => {
  test("hides routed servers and project skills through settings.local.json only", async () => {
    await write(join(repo, ".mcp.json"), MCPJSON);
    const mcpBefore = await readFile(join(repo, ".mcp.json"), "utf8");
    await trust(repo);
    await skill(repo, "deploy");

    const plan = (await planProjectAdopt(repo))!;
    expect(plan.servers).toEqual(["remote"]);
    expect(plan.unapproved).toEqual(["local"]);
    expect(plan.skills).toEqual(["deploy"]);

    await applyProjectAdopt(plan);
    const local = await readJson(join(repo, ".claude", "settings.local.json"));
    expect(local.disabledMcpjsonServers).toEqual(["remote"]);
    expect(local.skillOverrides).toEqual({ deploy: "name-only" });
    expect(await readFile(join(repo, ".mcp.json"), "utf8")).toBe(mcpBefore);

    // Idempotent: a second pass finds nothing to do.
    const again = await runProjectAdopt(repo, { auto: true });
    expect(again.notes).toEqual([]);
  });

  test("keeps the user's own settings and explicit overrides", async () => {
    await skill(repo, "deploy");
    await skill(repo, "pinned");
    await write(join(repo, ".claude", "settings.local.json"), {
      permissions: { allow: ["Bash(ls)"] },
      skillOverrides: { pinned: "on" },
    });
    await runProjectAdopt(repo);
    const local = await readJson(join(repo, ".claude", "settings.local.json"));
    expect(local.permissions).toEqual({ allow: ["Bash(ls)"] });
    expect(local.skillOverrides).toEqual({ pinned: "on", deploy: "name-only" });
  });

  test("moves skills it hid as user-invocable-only to name-only, leaving the user's own alone", async () => {
    await skill(repo, "deploy");
    await skill(repo, "mine");
    await runProjectAdopt(repo);
    // What an earlier version wrote: Claude cannot invoke either skill.
    await write(join(repo, ".claude", "settings.local.json"), {
      skillOverrides: { deploy: "user-invocable-only", mine: "user-invocable-only" },
    });
    // Only "deploy" was autorouter's; "mine" the user set by hand.
    await write(join(home, ".autorouter", "projects.json"), { [repo]: { servers: [], skills: ["deploy"] } });

    const plan = (await planProjectAdopt(repo))!;
    expect(plan.migrated).toEqual(["deploy"]);
    expect(plan.skills).toEqual([]);
    await applyProjectAdopt(plan);
    const local = await readJson(join(repo, ".claude", "settings.local.json"));
    expect(local.skillOverrides).toEqual({ deploy: "name-only", mine: "user-invocable-only" });
    expect((await runProjectAdopt(repo)).notes).toEqual([]);

    await restoreProject(repo);
    const back = await readJson(join(repo, ".claude", "settings.local.json"));
    expect(back.skillOverrides).toEqual({ mine: "user-invocable-only" });
  });

  test("restore removes exactly what was added", async () => {
    await skill(repo, "deploy");
    await write(join(repo, ".claude", "settings.local.json"), { skillOverrides: { other: "off" } });
    await runProjectAdopt(repo);
    await restoreProject(repo);
    const local = await readJson(join(repo, ".claude", "settings.local.json"));
    expect(local.skillOverrides).toEqual({ other: "off" });
  });

  test("leaves an unparseable settings file alone", async () => {
    await skill(repo, "deploy");
    await write(join(repo, ".claude", "settings.local.json"), "{ not json");
    const { notes } = await runProjectAdopt(repo);
    expect(notes).toEqual([]);
    expect(await readFile(join(repo, ".claude", "settings.local.json"), "utf8")).toBe("{ not json");
  });

  test("respects autoAdoptProject: false", async () => {
    await skill(repo, "deploy");
    await write(join(base, "autorouter.json"), { import: ["claude"], autoAdoptProject: false });
    expect((await runProjectAdopt(repo, { auto: true })).notes).toEqual([]);
  });

  test("a created settings.local.json is kept out of git", async () => {
    await rm(join(repo, ".git"), { recursive: true });
    const init = Bun.spawnSync(["git", "init", "-q", repo]);
    if (init.exitCode !== 0) return; // no git on this machine
    await skill(repo, "deploy");
    // Hermetic git: a developer's global excludes (Claude Code adds
    // settings.local.json there) would make this pass without the router's help.
    const saved = { g: process.env.GIT_CONFIG_GLOBAL, x: process.env.XDG_CONFIG_HOME };
    await write(join(base, "gitconfig"), "");
    process.env.GIT_CONFIG_GLOBAL = join(base, "gitconfig");
    process.env.XDG_CONFIG_HOME = join(base, "xdg");
    try {
      await runProjectAdopt(repo);
      const exclude = await readFile(join(repo, ".git", "info", "exclude"), "utf8");
      expect(exclude).toContain("/.claude/settings.local.json");
      const check = Bun.spawnSync(["git", "-C", repo, "check-ignore", "-q", ".claude/settings.local.json"]);
      expect(check.exitCode).toBe(0);
    } finally {
      if (saved.g === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = saved.g;
      if (saved.x === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = saved.x;
    }
  });
});

describe("project-scoped router servers", () => {
  test("config.projects[root] servers resolve only in that root", async () => {
    await write(join(base, "autorouter.json"), {
      import: [],
      projects: { [repo]: { servers: { scoped: { url: "https://scoped.example.com/mcp" } } } },
    });
    expect((await resolveConfig(repo)).servers.map((s) => s.name)).toEqual(["scoped"]);
    expect((await resolveConfig(base)).servers.map((s) => s.name)).toEqual([]);
  });
});

describe("repair", () => {
  test("puts back what the old adopt moved out of a committed .mcp.json", async () => {
    const original = `{\n  "mcpServers": {\n    "remote": { "type": "http", "url": "https://mcp.example.com/mcp" },\n    "local": { "type": "stdio", "command": "npx", "args": ["some-mcp"] }\n  }\n}\n`;
    await write(join(repo, ".mcp.json"), `{\n  "mcpServers": {}\n}\n`);
    await trust(repo);
    // What the old adopt left behind: a backup, and the servers in the global config.
    await write(join(home, ".autorouter", "adopted", "claude-2026-09-30T08-34-14-937Z.json"), {
      harness: "claude",
      files: { [join(repo, ".mcp.json")]: original, [join(home, ".claude.json")]: JSON.stringify({ mcpServers: { keepme: { command: "k" } } }) },
    });
    await write(join(base, "autorouter.json"), {
      import: ["claude"],
      servers: {
        remote: { type: "http", url: "https://mcp.example.com/mcp" },
        local: { type: "stdio", command: "npx", args: ["some-mcp"] },
        keepme: { command: "k" },
      },
    });

    const plan = await planRepair();
    expect(plan.files).toEqual([{ file: join(repo, ".mcp.json"), root: repo, restore: ["local", "remote"], verbatim: true }]);
    expect(plan.unglobal).toEqual(["local", "remote"]);

    await applyRepair(plan);
    expect(await readFile(join(repo, ".mcp.json"), "utf8")).toBe(original);
    const cfg = await readJson(join(base, "autorouter.json"));
    expect(Object.keys(cfg.servers)).toEqual(["keepme"]);
    // Both were in use through the router, so both keep working — and are now
    // hidden from Claude Code through settings.local.json, not by editing .mcp.json.
    expect((await loadClaude(repo)).map((s) => s.name).sort()).toEqual(["local", "remote"]);
    const local = await readJson(join(repo, ".claude", "settings.local.json"));
    expect(local.disabledMcpjsonServers.sort()).toEqual(["local", "remote"]);

    expect((await planRepair()).files).toEqual([]);
  });

  test("leaves servers the user removed themselves", async () => {
    await write(join(repo, ".mcp.json"), { mcpServers: {} });
    await write(join(home, ".autorouter", "adopted", "claude-x.json"), {
      harness: "claude",
      files: { [join(repo, ".mcp.json")]: JSON.stringify(MCPJSON) },
    });
    // Not in the router config: removed on purpose, not moved.
    expect((await planRepair()).files).toEqual([]);
  });
});

test("repair skips repos that no longer exist", async () => {
  const gone = join(base, "deleted-worktree");
  await write(join(home, ".autorouter", "adopted", "claude-y.json"), {
    harness: "claude",
    files: { [join(gone, ".mcp.json")]: JSON.stringify(MCPJSON) },
  });
  await write(join(base, "autorouter.json"), { import: ["claude"], servers: MCPJSON.mcpServers });
  const plan = await planRepair();
  expect(plan.files).toEqual([]);
  // Still global: nothing was restored anywhere, so nothing may be dropped.
  expect(plan.unglobal).toEqual([]);
});

test("trust and approvals carry over to a linked worktree of the repo", async () => {
  const wt = join(base, "wt");
  await mkdir(join(repo, ".git", "worktrees", "wt"), { recursive: true });
  await write(join(wt, ".git"), `gitdir: ${join(repo, ".git", "worktrees", "wt")}\n`);
  await write(join(wt, ".mcp.json"), MCPJSON);
  await trust(repo);
  const local = (await loadMcpjson(wt)).find((e) => e.entry.name === "local")!;
  expect(local.approved).toBe(false);
  await approveServers(wt, [local.entry]);
  expect((await loadClaude(wt)).map((s) => s.name).sort()).toEqual(["local", "remote"]);
  // Stored against the repository, so the main checkout benefits too.
  await write(join(repo, ".mcp.json"), MCPJSON);
  expect((await loadClaude(repo)).map((s) => s.name).sort()).toEqual(["local", "remote"]);
});
