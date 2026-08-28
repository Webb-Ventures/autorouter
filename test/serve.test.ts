import { test, expect, describe } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { tokensOf } from "../src/util/compact.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const FIXTURE = join(import.meta.dir, "fixtures", "fake-mcp-server.ts");

/**
 * These spawn the real binary over a real stdio pipe. An in-process test cannot
 * catch the failure mode this guards against: `serve()` used to resolve as soon
 * as the transport connected, and the CLI's `.then(process.exit)` then killed
 * the process before it could answer `initialize` — the server printed "ready"
 * and died, so it worked in no harness at all.
 */
async function connect(clientName: string, clientVersion: string) {
  const dir = await mkdtemp(join(tmpdir(), "autorouter-serve-"));
  const config = join(dir, "autorouter.json");
  await writeFile(
    config,
    JSON.stringify({ import: [], skillPaths: [], selector: { mode: "off" }, servers: { fake: { command: "bun", args: [FIXTURE] } } }),
  );
  const client = new Client({ name: clientName, version: clientVersion }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: "bun",
    args: ["run", CLI, "serve"],
    env: { ...process.env, AUTOROUTER_CONFIG: config, AUTOROUTER_CACHE_DIR: join(dir, "cache"), AUTOROUTER_HOME: dir },
    stderr: "ignore",
  });
  await client.connect(transport);
  return { client, cleanup: async () => { await client.close(); await rm(dir, { recursive: true, force: true }); } };
}

describe("serve over stdio", () => {
  test("answers initialize and stays alive for later requests", async () => {
    const { client, cleanup } = await connect("claude-code", "2.1.240");
    try {
      expect(client.getServerVersion()?.name).toBe("autorouter");
      // The second round trip is the actual regression check: a server that
      // exits after initialize would fail here, not above.
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("find_capabilities");
      const res: any = await client.callTool({ name: "find_capabilities", arguments: { query: "run a database query" } });
      expect(res.content[0].text).toContain("mcp:fake/run_sql_query");
    } finally {
      await cleanup();
    }
  }, 30_000);

  test("advertises the dynamic tools only to clients that honour listChanged", async () => {
    const dynamic = await connect("claude-code", "2.1.240");
    const proxyOnly = await connect("codex-mcp-client", "0.50.0");
    try {
      const a = (await dynamic.client.listTools()).tools.map((t) => t.name);
      const b = (await proxyOnly.client.listTools()).tools.map((t) => t.name);
      expect(a).toContain("activate_capabilities");
      // Codex ignores tools/list_changed, so offering to activate a tool there
      // would advertise something the model could never call.
      expect(b).not.toContain("activate_capabilities");
      expect(b).toContain("call_capability");
    } finally {
      await dynamic.cleanup();
      await proxyOnly.cleanup();
    }
  }, 30_000);

  test("the whole exposed surface stays under 1k tokens", async () => {
    const { client, cleanup } = await connect("claude-code", "2.1.240");
    try {
      const { tools } = await client.listTools();
      const approx =
        tools.reduce((n, t) => n + JSON.stringify(t).length, 0) + (client.getInstructions() ?? "").length;
      expect(Math.ceil(approx / 4)).toBeLessThan(1000);
    } finally {
      await cleanup();
    }
  }, 30_000);
});

describe("catalog staleness tracks OAuth grants", () => {
  /**
   * The bug this guards: a `serve` process that started before `autorouter
   * login` kept answering from a catalog the server was missing from, so the
   * model was told the tool did not exist. The grant file has to count as a
   * catalog input, or nothing ever triggers the rebuild.
   */
  async function scratch() {
    const dir = await mkdtemp(join(tmpdir(), "autorouter-stale-"));
    const config = join(dir, "autorouter.json");
    await writeFile(
      config,
      JSON.stringify({
        import: [],
        skillPaths: [],
        selector: { mode: "off" },
        // Nothing listens here, so enumeration fails fast and the catalog is
        // the empty one a pre-login process would have built.
        servers: { remote: { url: "http://127.0.0.1:9/mcp" } },
      }),
    );
    process.env.AUTOROUTER_CONFIG = config;
    process.env.AUTOROUTER_HOME = dir;
    process.env.AUTOROUTER_CACHE_DIR = join(dir, "cache");
    return { dir, grant: join(dir, ".autorouter", "oauth", "remote.json") };
  }

  test("a new token invalidates it; discovery writes and refreshes do not", async () => {
    const saved = { ...process.env };
    const { dir, grant } = await scratch();
    try {
      const { buildCatalog, isStale } = await import("../src/catalog/build.ts");
      const { resolveConfig } = await import("../src/config/resolve.ts");
      const resolved = await resolveConfig(dir);
      const catalog = await buildCatalog(resolved);

      expect(Object.keys(catalog.sources)).toContain(`auth:${grant}`);
      expect(catalog.sources[`auth:${grant}`]).toBe("none");
      expect(await isStale(catalog, 3600)).toBe(false);

      // The SDK writes discovery and client registration into this file while
      // *failing* to connect, so mere existence must not read as authorized —
      // that is what made an earlier presence check never fire.
      await mkdir(join(dir, ".autorouter", "oauth"), { recursive: true });
      await writeFile(grant, JSON.stringify({ clientInformation: { client_id: "x" } }));
      expect(await isStale(catalog, 3600)).toBe(false);

      await writeFile(grant, JSON.stringify({ tokens: { access_token: "a" } }));
      expect(await isStale(catalog, 3600)).toBe(true);

      // Rebuilt with the grant in place, a silent token refresh rewrites the
      // file constantly; treating that as a change would re-enumerate every
      // server about once an hour for nothing.
      const withGrant = await buildCatalog(resolved);
      expect(withGrant.sources[`auth:${grant}`]).toBe("granted");
      await writeFile(grant, JSON.stringify({ tokens: { access_token: "b-refreshed" } }));
      expect(await isStale(withGrant, 3600)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
      process.env = saved;
    }
  }, 30_000);
});

describe("search promotes tools to first-class", () => {
  /**
   * The reliability requirement: after a search, the model should be able to
   * make an ordinary tool call. Not a proxied one described in prose — a real
   * one the host validates against the real schema.
   */
  test("a matched tool becomes natively callable on a list_changed client", async () => {
    const { client, cleanup } = await connect("claude-code", "2.1.240");
    try {
      const before = (await client.listTools()).tools.map((t) => t.name);
      expect(before).not.toContain("fake__run_sql_query");

      const res: any = await client.callTool({
        name: "find_capabilities",
        arguments: { query: "run a database query" },
      });
      expect(res.content[0].text).toContain("fake__run_sql_query");

      const after = (await client.listTools()).tools;
      const promoted = after.find((t) => t.name === "fake__run_sql_query");
      expect(promoted).toBeDefined();
      // The schema has to be the real one — a promoted tool the host cannot
      // validate arguments against is no better than the proxy.
      expect(Object.keys(promoted!.inputSchema.properties ?? {})).toContain("sql");

      const direct: any = await client.callTool({
        name: "fake__run_sql_query",
        arguments: { sql: "select 1" },
      });
      expect(direct.isError).toBeFalsy();
    } finally {
      await cleanup();
    }
  }, 30_000);

  test("a proxy-only client gets inline schemas instead", async () => {
    const { client, cleanup } = await connect("codex-mcp-client", "0.50.0");
    try {
      const res: any = await client.callTool({
        name: "find_capabilities",
        arguments: { query: "run a database query" },
      });
      const text = res.content[0].text as string;
      // Codex ignores list_changed, so the tool can never appear in its list.
      // The schema must therefore travel in the search result itself, or the
      // model is left guessing argument names off a truncated description.
      expect(text).toContain("arguments:");
      expect(text).toContain('"sql"');
      expect((await client.listTools()).tools.map((t) => t.name)).not.toContain("fake__run_sql_query");
    } finally {
      await cleanup();
    }
  }, 30_000);

  /**
   * The failure this guards against is the router quietly becoming the thing it
   * replaced. Capping the promoted list by *count* looks like a bound and is
   * not one: tool definitions differ by an order of magnitude in size, so N
   * tools is anywhere from a few hundred to tens of thousands of tokens
   * depending only on which ones the model searched for.
   */
  test("the promoted tool list stays inside its token budget", async () => {
    const { client, cleanup } = await connect("claude-code", "2.1.240");
    try {
      for (const query of [
        "build a wide analytics report",
        "run a database query",
        "render a bar chart",
        "restart a container",
        "list database backups",
      ]) {
        await client.callTool({ name: "find_capabilities", arguments: { query } });
      }

      const tools = (await client.listTools()).tools;
      const promoted = tools.filter((t) => t.name.startsWith("fake__"));
      const cost = promoted.reduce((sum, t) => sum + tokensOf(t), 0);
      expect(promoted.length).toBeGreaterThan(0);
      // The 400-property fixture alone busts the budget uncompacted, so passing
      // means eviction actually ran rather than the corpus being too small.
      expect(cost).toBeLessThanOrEqual(3000);
    } finally {
      await cleanup();
    }
  }, 30_000);

  test("a promoted tool keeps every property the host validates against", async () => {
    const { client, cleanup } = await connect("claude-code", "2.1.240");
    try {
      await client.callTool({
        name: "find_capabilities",
        arguments: { query: "build a wide analytics report" },
      });
      const tool = (await client.listTools()).tools.find((t) => t.name === "fake__bloated_report");
      expect(tool).toBeDefined();
      // Compaction may shorten prose; dropping a property would turn a valid
      // call into a rejected one.
      expect(Object.keys(tool!.inputSchema.properties ?? {}).length).toBe(400);
    } finally {
      await cleanup();
    }
  }, 30_000);
});

describe("slash commands via MCP prompts", () => {
  /**
   * A plugin adopted into the router loses its commands/*.md to the native
   * loader — Claude Code only reads those off disk. Republishing them as MCP
   * prompts is what keeps /mcp__autorouter__<name> working, so adoption is not
   * a silent downgrade.
   */
  async function withCommand() {
    const dir = await mkdtemp(join(tmpdir(), "autorouter-prompt-"));
    const skills = join(dir, "skills", "deploy-check");
    await mkdir(skills, { recursive: true });
    await writeFile(
      join(skills, "SKILL.md"),
      "---\nname: deploy-check\ndescription: Verify a deploy is healthy\nargument-hint: [service]\n---\n\nCheck the health of $1, then summarise.\n",
    );
    const config = join(dir, "autorouter.json");
    await writeFile(
      config,
      JSON.stringify({
        import: [],
        skillPaths: [join(dir, "skills")],
        selector: { mode: "off" },
        servers: { fake: { command: "bun", args: [FIXTURE] } },
      }),
    );
    const client = new Client({ name: "claude-code", version: "2.1.240" }, { capabilities: {} });
    await client.connect(
      new StdioClientTransport({
        command: "bun",
        args: ["run", CLI, "serve"],
        env: { ...process.env, AUTOROUTER_CONFIG: config, AUTOROUTER_CACHE_DIR: join(dir, "cache"), AUTOROUTER_HOME: dir },
        stderr: "ignore",
      }),
    );
    return { client, cleanup: async () => { await client.close(); await rm(dir, { recursive: true, force: true }); } };
  }

  test("publishes skills as prompts and substitutes arguments", async () => {
    const { client, cleanup } = await withCommand();
    try {
      const { prompts } = await client.listPrompts();
      const names = prompts.map((p) => p.name);
      expect(names).toContain("deploy-check");
      expect(names).toContain("find");

      const got = await client.getPrompt({ name: "deploy-check", arguments: { arguments: "api" } });
      const text = (got.messages[0]!.content as any).text as string;
      // $1 has to expand the way the native command loader expands it, or a body
      // written for Claude Code reads as a literal "$1" here.
      expect(text).toContain("Check the health of api");
      expect(text).not.toContain("$1");
    } finally {
      await cleanup();
    }
  }, 30_000);

  test("does not publish tools as prompts", async () => {
    const { client, cleanup } = await withCommand();
    try {
      const names = (await client.listPrompts()).prompts.map((p) => p.name);
      // A prompt returns text, never a tool result. A slash command for
      // run_sql_query would look callable and do nothing.
      expect(names.some((n) => n.includes("run_sql_query"))).toBe(false);
    } finally {
      await cleanup();
    }
  }, 30_000);

  test("the find prompt is a working search entry point", async () => {
    const { client, cleanup } = await withCommand();
    try {
      const got = await client.getPrompt({ name: "find", arguments: { query: "run a database query" } });
      expect((got.messages[0]!.content as any).text).toContain("mcp:fake/run_sql_query");
    } finally {
      await cleanup();
    }
  }, 30_000);
});
