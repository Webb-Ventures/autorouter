import { test, expect, describe } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
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
async function connect(
  clientName: string,
  clientVersion: string,
  overrides: Record<string, unknown> = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "autorouter-serve-"));
  const config = join(dir, "autorouter.json");
  await writeFile(
    config,
    JSON.stringify({
      import: [],
      skillPaths: [],
      selector: { mode: "off" },
      servers: { fake: { command: "bun", args: [FIXTURE] } },
      ...overrides,
    }),
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

/** Same, but hands back the config path so a test can assert what was written. */
async function connectWithConfig(clientName: string, clientVersion: string) {
  const dir = await mkdtemp(join(tmpdir(), "autorouter-add-"));
  const configPath = join(dir, "autorouter.json");
  await writeFile(
    configPath,
    JSON.stringify({
      import: [],
      skillPaths: [],
      selector: { mode: "off" },
      servers: { fake: { command: "bun", args: [FIXTURE] } },
    }),
  );
  const client = new Client({ name: clientName, version: clientVersion }, { capabilities: {} });
  await client.connect(
    new StdioClientTransport({
      command: "bun",
      args: ["run", CLI, "serve"],
      env: { ...process.env, AUTOROUTER_CONFIG: configPath, AUTOROUTER_CACHE_DIR: join(dir, "cache"), AUTOROUTER_HOME: dir },
      stderr: "ignore",
    }),
  );
  return {
    client,
    configPath,
    cleanup: async () => { await client.close(); await rm(dir, { recursive: true, force: true }); },
  };
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

describe("use promotes tools to first-class", () => {
  /**
   * The reliability requirement, and where the cost of meeting it is paid.
   *
   * A tool definition in the host's list is permanent context for the session,
   * so it is spent on evidence of need rather than evidence of interest: a
   * search hit only means the model looked at something, a completed call means
   * it used it. So the first call goes through the proxy with the schema the
   * search inlined, and the tool is native from the second call on.
   */
  test("a called tool becomes natively callable on a list_changed client", async () => {
    const { client, cleanup } = await connect("claude-code", "2.1.240");
    try {
      const res: any = await client.callTool({
        name: "find_capabilities",
        arguments: { query: "run a database query" },
      });
      expect(res.content[0].text).toContain("mcp:fake/run_sql_query");
      // Searching is not using. Promoting here would spend the budget on the
      // four hits the model is about to ignore.
      expect((await client.listTools()).tools.map((t) => t.name)).not.toContain(
        "fake__run_sql_query",
      );

      const proxied: any = await client.callTool({
        name: "call_capability",
        arguments: { id: "mcp:fake/run_sql_query", arguments: { sql: "select 1" } },
      });
      expect(proxied.isError).toBeFalsy();

      const promoted = (await client.listTools()).tools.find(
        (t) => t.name === "fake__run_sql_query",
      );
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

  /**
   * A failed call is as likely to mean the model picked the wrong capability as
   * that it needs this one again — and the context a promotion occupies is
   * permanent either way.
   */
  test("a failed call does not promote", async () => {
    const { client, cleanup } = await connect("claude-code", "2.1.240");
    try {
      const res: any = await client.callTool({
        name: "call_capability",
        arguments: { id: "mcp:fake/explode", arguments: {} },
      });
      expect(res.isError).toBeTruthy();
      expect((await client.listTools()).tools.map((t) => t.name)).not.toContain("fake__explode");
    } finally {
      await cleanup();
    }
  }, 30_000);

  /**
   * Deferring promotion is only affordable if the search result carries enough
   * to make that first call. It has to, on every client — not just the ones
   * that cannot promote at all.
   */
  test("a list_changed client still gets inline schemas from search", async () => {
    const { client, cleanup } = await connect("claude-code", "2.1.240");
    try {
      const res: any = await client.callTool({
        name: "find_capabilities",
        arguments: { query: "run a database query" },
      });
      const text = res.content[0].text as string;
      expect(text).toContain("arguments:");
      expect(text).toContain('"sql"');
    } finally {
      await cleanup();
    }
  }, 30_000);

  /**
   * "off" is the setting for anyone who would rather every downstream call show
   * up as call_capability than carry any tool definitions at all. It has to
   * withdraw the activate/deactivate pair too, or the model is holding two tool
   * definitions for something the server will refuse to do.
   */
  test("activation: off never promotes and withdraws the activate tools", async () => {
    const { client, cleanup } = await connect("claude-code", "2.1.240", { activation: "off" });
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).not.toContain("activate_capabilities");
      expect(names).not.toContain("deactivate_capabilities");

      const res: any = await client.callTool({
        name: "call_capability",
        arguments: { id: "mcp:fake/run_sql_query", arguments: { sql: "select 1" } },
      });
      expect(res.isError).toBeFalsy();
      expect((await client.listTools()).tools.map((t) => t.name)).not.toContain(
        "fake__run_sql_query",
      );
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
      // bloated_report first and list_backups last: the tool promoted by the
      // call in flight is never evicted, so the order is what proves eviction
      // ran rather than the corpus simply fitting.
      for (const [id, args] of [
        ["mcp:fake/bloated_report", {}],
        ["mcp:fake/run_sql_query", { sql: "select 1" }],
        ["mcp:fake/render_bar_chart", { labels: [], values: [] }],
        ["mcp:fake/restart_container", { name: "api" }],
        ["mcp:fake/list_backups", {}],
      ] as const) {
        await client.callTool({ name: "call_capability", arguments: { id, arguments: args } });
      }

      const tools = (await client.listTools()).tools;
      const promoted = tools.filter((t) => t.name.startsWith("fake__"));
      const cost = promoted.reduce((sum, t) => sum + tokensOf(t), 0);
      expect(promoted.length).toBeGreaterThan(0);
      // The 400-property fixture alone busts the budget, so passing means
      // eviction actually ran rather than the corpus being too small.
      expect(promoted.map((t) => t.name)).not.toContain("fake__bloated_report");
      expect(cost).toBeLessThanOrEqual(3000);
    } finally {
      await cleanup();
    }
  }, 30_000);

  test("a promoted tool keeps every property the host validates against", async () => {
    const { client, cleanup } = await connect("claude-code", "2.1.240");
    try {
      await client.callTool({
        name: "call_capability",
        arguments: { id: "mcp:fake/bloated_report", arguments: {} },
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
  async function withCommand(overrides: Record<string, unknown> = {}) {
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
        ...overrides,
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

  /**
   * Skills are off the prompt list by default because it is permanent context
   * and they are the bulk of it — a single plugin shipping 141 of them costs
   * ~11.5k tokens on every turn. They stay searchable, and a local skill keeps
   * its native /name, so what "commands" drops is the alias, not the skill.
   */
  test("skills are not published as prompts by default, but stay searchable", async () => {
    const { client, cleanup } = await withCommand();
    try {
      expect((await client.listPrompts()).prompts.map((p) => p.name)).toEqual(["find"]);
      const res: any = await client.callTool({
        name: "find_capabilities",
        arguments: { query: "verify a deploy is healthy" },
      });
      expect(res.content[0].text).toContain("skill:deploy-check");
    } finally {
      await cleanup();
    }
  }, 30_000);

  test("publishes skills as prompts and substitutes arguments under promptMode: all", async () => {
    const { client, cleanup } = await withCommand({ promptMode: "all" });
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

describe("adding a server from inside a session", () => {
  /**
   * A stdio entry is a command this machine will run on every launch from here
   * on. Letting one tool call write that is the same mistake as letting one tool
   * call run a shell command — so the first call reports and writes nothing.
   */
  test("add_server refuses to write without confirm", async () => {
    const { client, cleanup, configPath } = await connectWithConfig("claude-code", "2.1.240");
    try {
      const res: any = await client.callTool({
        name: "add_server",
        arguments: { name: "second", command: "bun", args: [FIXTURE] },
      });
      const text = res.content[0].text as string;
      expect(text).toContain("Confirmation required");
      // The resolved command has to be in the message, not just the name — the
      // whole point is that the user sees what will run.
      expect(text).toContain(FIXTURE);

      const written = JSON.parse(await readFile(configPath, "utf8"));
      expect(written.servers.second).toBeUndefined();
    } finally {
      await cleanup();
    }
  }, 30_000);

  test("add_server registers and the new tools are immediately findable", async () => {
    const { client, cleanup, configPath } = await connectWithConfig("claude-code", "2.1.240");
    try {
      const res: any = await client.callTool({
        name: "add_server",
        arguments: { name: "second", command: "bun", args: [FIXTURE, "--second"], confirm: true },
      });
      expect(res.isError).toBeFalsy();

      const written = JSON.parse(await readFile(configPath, "utf8"));
      expect(written.servers.second).toEqual({ command: "bun", args: [FIXTURE, "--second"] });

      const found: any = await client.callTool({
        name: "find_capabilities",
        arguments: { query: "restart a container", server: "second" },
      });
      expect(found.content[0].text).toContain("mcp:second/restart_container");
    } finally {
      await cleanup();
    }
  }, 30_000);

  test("add_server rejects an entry that would launch the router again", async () => {
    const { client, cleanup } = await connectWithConfig("claude-code", "2.1.240");
    try {
      const res: any = await client.callTool({
        name: "add_server",
        arguments: { name: "loop", command: "npx", args: ["autorouter", "serve"], confirm: true },
      });
      expect(res.isError).toBeTruthy();
      expect(res.content[0].text).toContain("recurse");
    } finally {
      await cleanup();
    }
  }, 30_000);
});

describe("auto-adopt inside a running server", () => {
  /**
   * The whole point of the flow: `claude mcp add foo` is still the front door,
   * and the router closes it behind you. A running serve process notices the
   * harness config changed, moves the entry into its own config, and the server
   * is searchable — without the user ever running `autorouter adopt`.
   */
  test("a server added to the harness is moved behind the router", async () => {
    const dir = await mkdtemp(join(tmpdir(), "autorouter-auto-"));
    const configPath = join(dir, "autorouter.json");
    const claudeConfig = join(dir, ".claude.json");
    await writeFile(configPath, JSON.stringify({ import: ["claude"], skillPaths: [], selector: { mode: "off" } }));
    await writeFile(claudeConfig, JSON.stringify({ mcpServers: {} }));

    const client = new Client({ name: "claude-code", version: "2.1.240" }, { capabilities: {} });
    await client.connect(
      new StdioClientTransport({
        command: "bun",
        args: ["run", CLI, "serve"],
        env: { ...process.env, AUTOROUTER_CONFIG: configPath, AUTOROUTER_CACHE_DIR: join(dir, "cache"), AUTOROUTER_HOME: dir },
        stderr: "ignore",
      }),
    );

    try {
      // What `claude mcp add` does, with nothing else involved.
      await writeFile(
        claudeConfig,
        JSON.stringify({ mcpServers: { late: { command: "bun", args: [FIXTURE] } } }),
      );

      // Two searches: the first observes the config change and triggers the
      // move, the second sees the rebuilt catalog.
      await client.callTool({ name: "find_capabilities", arguments: { query: "anything" } });
      const res: any = await client.callTool({
        name: "find_capabilities",
        arguments: { query: "run a database query" },
      });
      expect(res.content[0].text).toContain("mcp:late/run_sql_query");

      const harness = JSON.parse(await readFile(claudeConfig, "utf8"));
      expect(harness.mcpServers).toEqual({});
      const router = JSON.parse(await readFile(configPath, "utf8"));
      expect(router.servers.late).toEqual({ command: "bun", args: [FIXTURE] });
    } finally {
      await client.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 40_000);
});
