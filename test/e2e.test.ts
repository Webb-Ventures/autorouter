import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Router } from "../src/router.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "fake-mcp-server.ts");

let dir: string;
let router: Router;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "autorouter-e2e-"));
  await mkdir(join(dir, "skills", "charts"), { recursive: true });
  await writeFile(
    join(dir, "skills", "charts", "SKILL.md"),
    `---\nname: charts\ndescription: Turn a CSV into a bar or line chart image.\nmetadata:\n  keywords: chart, graph, plot\n---\n# Charts\nRun the plotting script.\n`,
  );
  await writeFile(
    join(dir, "autorouter.json"),
    JSON.stringify({
      // No harness imports: the test must see exactly what it configured.
      import: [],
      servers: { fake: { command: "bun", args: [FIXTURE] } },
      skillPaths: [join(dir, "skills")],
      selector: { mode: "off" },
    }),
  );
  process.env.AUTOROUTER_CONFIG = join(dir, "autorouter.json");
  process.env.AUTOROUTER_CACHE_DIR = join(dir, "cache");
  router = await Router.create({ cwd: dir, force: true });
});

afterAll(async () => {
  await router?.close();
  await rm(dir, { recursive: true, force: true });
  delete process.env.AUTOROUTER_CONFIG;
  delete process.env.AUTOROUTER_CACHE_DIR;
});

describe("catalog", () => {
  test("follows tools/list pagination to the last page", () => {
    const tools = router.catalog.capabilities.filter((c) => c.kind === "tool");
    expect(tools.map((t) => t.name).sort()).toEqual([
      "bloated_report",
      "list_backups",
      "render_bar_chart",
      "restart_container",
      "run_sql_query",
    ]);
  });

  test("indexes prompts and skills alongside tools", () => {
    const kinds = new Set(router.catalog.capabilities.map((c) => c.kind));
    expect(kinds).toContain("prompt");
    expect(kinds).toContain("skill");
  });

  test("connects nothing at index time beyond enumeration", () => {
    expect(router.catalog.errors).toEqual({});
  });
});

describe("search", () => {
  test("finds a tool from a paraphrase of what it does", async () => {
    const hits = await router.rawSearch("run a select against the database", { limit: 3 });
    expect(hits[0]?.capability.id).toBe("mcp:fake/run_sql_query");
  });

  test("finds a skill, not just MCP tools", async () => {
    const hits = await router.rawSearch("plot a graph", { limit: 3 });
    expect(hits.map((h) => h.capability.id)).toContain("skill:charts");
  });

  test("filters by kind", async () => {
    const hits = await router.rawSearch("chart", { kind: "skill", limit: 5 });
    expect(hits.every((h) => h.capability.kind === "skill")).toBe(true);
  });
});

describe("describe and call", () => {
  test("describe returns the input schema", async () => {
    const found = await router.describe("mcp:fake/run_sql_query");
    const schema = found!.capability.inputSchema as { properties?: Record<string, unknown> };
    expect(Object.keys(schema.properties ?? {})).toContain("sql");
  });

  test("describe returns the skill body, since reading it is how it runs", async () => {
    const found = await router.describe("skill:charts");
    expect(found!.body).toContain("Run the plotting script.");
  });

  test("call proxies to the downstream server and labels the source", async () => {
    const result = await router.call("mcp:fake/run_sql_query", { sql: "select 1" });
    const text = JSON.stringify(result);
    expect(text).toContain("select 1");
    expect(text).toContain("fake/run_sql_query");
  });

  test("an unknown id fails with a usable message rather than throwing raw", async () => {
    await expect(router.call("mcp:fake/nope", {})).rejects.toThrow(/nope/);
  });
});
