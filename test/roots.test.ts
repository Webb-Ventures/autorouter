import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

async function skill(root: string, name: string) {
  const dir = join(root, ".claude", "skills", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Deploys the ${name} app.\n---\nbody\n`);
}

async function findText(client: Client, query: string): Promise<string> {
  const res: any = await client.callTool({ name: "find_capabilities", arguments: { query } });
  return res.content.map((c: any) => c.text ?? "").join("\n");
}

async function eventually(check: () => Promise<boolean>, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await Bun.sleep(150);
  }
  return false;
}

/**
 * The router follows the host's workspace: Claude Code's roots/list names the
 * project, which is often not the directory the server process was spawned in.
 * That project's skills join the catalog and are hidden from the harness via
 * the repo's own settings.local.json; a roots change moves the router along.
 */
test("serve follows roots/list and adopts that repo's skills", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "autorouter-roots-")));
  const spawnDir = join(base, "spawned-here");
  const repoA = join(base, "repo-a");
  const repoB = join(base, "repo-b");
  await mkdir(spawnDir, { recursive: true });
  await mkdir(join(repoA, ".git"), { recursive: true });
  await mkdir(join(repoB, ".git"), { recursive: true });
  await skill(repoA, "alpha-deployer");
  await skill(repoB, "bravo-deployer");
  const config = join(base, "autorouter.json");
  await writeFile(config, JSON.stringify({ import: [], skillPaths: [".claude/skills"], selector: { mode: "off" } }));

  let roots = [{ uri: pathToFileURL(repoA).href, name: "a" }];
  const client = new Client({ name: "claude-code", version: "2.1.300" }, { capabilities: { roots: { listChanged: true } } });
  client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots }));
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    AUTOROUTER_CONFIG: config,
    AUTOROUTER_CACHE_DIR: join(base, "cache"),
    AUTOROUTER_HOME: base,
  };
  delete env.CLAUDE_PROJECT_DIR;
  await client.connect(
    new StdioClientTransport({ command: "bun", args: ["run", CLI, "serve"], env, cwd: spawnDir, stderr: "ignore" }),
  );
  try {
    expect(await eventually(async () => (await findText(client, "deploy alpha app")).includes("skill:alpha-deployer"))).toBe(true);
    expect(
      await eventually(async () => {
        const text = await readFile(join(repoA, ".claude", "settings.local.json"), "utf8").catch(() => "");
        return text.includes('"alpha-deployer": "name-only"');
      }),
    ).toBe(true);

    roots = [{ uri: pathToFileURL(repoB).href, name: "b" }];
    await client.sendRootsListChanged();
    expect(await eventually(async () => (await findText(client, "deploy bravo app")).includes("skill:bravo-deployer"))).toBe(true);
    expect(await findText(client, "deploy alpha app")).not.toContain("skill:alpha-deployer");
  } finally {
    await client.close();
    await rm(base, { recursive: true, force: true });
  }
}, 40_000);
