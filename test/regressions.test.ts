import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability } from "../src/catalog/types.ts";
import { estimateTokens } from "../src/catalog/types.ts";
import { catalogPath } from "../src/catalog/build.ts";
import { parseFrontmatter } from "../src/catalog/frontmatter.ts";
import { loadPluginServers, readPluginServers } from "../src/config/adapters/plugins.ts";
import { normalizeServer } from "../src/config/adapters/shared.ts";
import { dedupeServers } from "../src/config/resolve.ts";
import { DEFAULT_CONFIG } from "../src/config/types.ts";
import { Bm25Index } from "../src/index/bm25.ts";
import { HybridIndex } from "../src/index/search.ts";
import { stem } from "../src/index/tokenize.ts";
import { isEmptySelection } from "../src/selector/prompt.ts";
import { promptMessages } from "../src/server/prompts.ts";
import { classify } from "../src/server/spill.ts";
import { compactSchema } from "../src/util/compact.ts";
import { writeText } from "../src/util/fs.ts";
import { run } from "../src/util/proc.ts";

function cap(id: string, name: string, description: string): Capability {
  return {
    id,
    kind: "tool",
    name,
    server: id.split(":")[1]?.split("/")[0],
    description,
    keywords: [],
    approxTokens: estimateTokens(name, description),
  };
}

describe("schema compaction keeps parameters", () => {
  test("a property named like a dropped keyword survives", () => {
    const out = compactSchema({
      type: "object",
      title: "CreateIssue",
      properties: {
        title: { type: "string", title: "Title", description: "Issue title" },
        example: { type: "string" },
        additionalProperties: { type: "boolean" },
      },
      required: ["title"],
    }) as any;
    expect(Object.keys(out.properties)).toEqual(["title", "example", "additionalProperties"]);
    // The keyword of the same name is still dropped, at both levels.
    expect(out.title).toBeUndefined();
    expect(out.properties.title).toEqual({ type: "string", description: "Issue title" });
  });
});

describe("search scoring", () => {
  test("the weaker of two lexical matches is still returned", async () => {
    const index = new HybridIndex(
      [
        cap("mcp:acme/list_widgets", "list_widgets", "List widgets."),
        cap("mcp:acme/search_widgets", "search_widgets", "Search widgets by name."),
        cap("mcp:acme/send_email", "send_email", "Send an email."),
      ],
      DEFAULT_CONFIG,
    );
    const ids = (await index.search("list widgets")).map((s) => s.capability.id);
    expect(ids).toEqual(["mcp:acme/list_widgets", "mcp:acme/search_widgets"]);
  });

  test("an exact tool name typed without its separator matches", () => {
    const index = new Bm25Index([
      { ...cap("mcp:supabase/execute_sql", "execute_sql", "Runs a statement."), title: "Execute SQL" },
    ]);
    expect(index.score("executesql").size).toBe(1);
  });
});

describe("stemmer", () => {
  test("inflections share a stem with their base form", () => {
    for (const [base, ...forms] of [
      ["issue", "issues"],
      ["file", "files"],
      ["table", "tables"],
      ["message", "messages"],
      ["database", "databases"],
      ["create", "created", "creates", "creating"],
      ["search", "searches", "searched", "searching"],
      ["query", "queries"],
      ["dashboard", "dashboards"],
    ] as string[][]) {
      for (const form of forms) expect(`${form}:${stem(form)}`).toBe(`${form}:${stem(base!)}`);
    }
  });

  test("words that only look plural are left alone", () => {
    expect(stem("status")).toBe("status");
    expect(stem("analysis")).toBe("analysis");
    expect(stem("address")).toBe("address");
  });
});

describe("prompt arguments", () => {
  const skill: Capability = { ...cap("skill:explain", "explain", "Explain something."), kind: "skill" };
  const text = (body: string, args: string) =>
    (promptMessages(skill, body, { arguments: args })[0]!.content as { text: string }).text;

  test("dollar signs in the arguments are not substituted again", () => {
    expect(text("Explain: $ARGUMENTS", "awk {print $1}")).toContain("Explain: awk {print $1}");
    expect(text("Explain: $ARGUMENTS", "cost is $$5 and $& more")).toContain("Explain: cost is $$5 and $& more");
  });

  test("positional arguments still resolve", () => {
    expect(text("First $1, second $2, all $ARGUMENTS", "a b")).toContain("First a, second b, all a b");
  });
});

describe("run timeout", () => {
  test("is enforced when a descendant keeps the pipes open", async () => {
    const started = Date.now();
    await expect(run("sh", ["-c", "sleep 3 & wait"], { timeoutMs: 200 })).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

describe("catalog cache path", () => {
  test("directories that slug alike get different files", () => {
    expect(catalogPath("/a/foo-bar")).not.toBe(catalogPath("/a/foo/bar"));
    const tail = "x".repeat(120);
    expect(catalogPath(`/one/${tail}`)).not.toBe(catalogPath(`/two/${tail}`));
    expect(catalogPath("/a/foo")).toBe(catalogPath("/a/foo"));
  });
});

describe("frontmatter plain scalars", () => {
  test("a wrapped description keeps every line", () => {
    const { data } = parseFrontmatter(
      [
        "---",
        "name: deploy",
        "description: Deploys the service. Use when the user says:",
        "  ship it, or asks for a release",
        "  to production.",
        "model: fast",
        "---",
        "body",
      ].join("\n"),
    );
    expect(data.description).toBe(
      "Deploys the service. Use when the user says: ship it, or asks for a release to production.",
    );
    expect(data.model).toBe("fast");
    expect(Object.keys(data)).toEqual(["name", "description", "model"]);
  });
});

describe("server dedupe", () => {
  test("the same command with a different environment is a different server", () => {
    const out = dedupeServers([
      normalizeServer("pg-prod", { command: "pg-mcp", env: { DATABASE_URL: "postgres://prod" } }, "claude")!,
      normalizeServer("pg-dev", { command: "pg-mcp", env: { DATABASE_URL: "postgres://dev" } }, "claude")!,
    ]);
    expect(out.map((s) => s.name)).toEqual(["pg-prod", "pg-dev"]);
  });

  test("a sign-in command survives when a harness registers the same server", () => {
    for (const harnessName of ["railway", "rw", "railway-mcp-server"]) {
      const out = dedupeServers([
        normalizeServer(harnessName, { command: "railway-mcp" }, "claude")!,
        normalizeServer("railway", { command: "railway-mcp", login: ["railway", "login"] }, "config")!,
      ]);
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ login: ["railway", "login"] });
    }
  });

  test("renaming to the shorter name never produces two servers with one name", () => {
    const out = dedupeServers([
      normalizeServer("gh", { command: "other" }, "claude")!,
      normalizeServer("github", { command: "gh-mcp" }, "claude")!,
      normalizeServer("gh", { command: "gh-mcp" }, "cursor")!,
    ]);
    const names = out.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    expect(out).toHaveLength(2);
  });
});

describe("selector answers", () => {
  test("only a well-formed empty list counts as 'nothing fits'", () => {
    expect(isEmptySelection('{"selections":[]}')).toBe(true);
    expect(isEmptySelection("[]")).toBe(true);
    expect(isEmptySelection('{"selections":[{"id":"mcp:x/y"')).toBe(false);
    expect(isEmptySelection("I could not decide.")).toBe(false);
    expect(isEmptySelection('{"selections":[{"id":"made-up"}]}')).toBe(false);
  });
});

describe("spilled results", () => {
  test("a payload with 64-bit ids is kept verbatim", () => {
    const text = '[{"id":1234567890123456789,"name":"a"},{"id":1234567890123456790,"name":"b"}]';
    const shape = classify(text);
    expect(shape.kind).toBe("text");
    expect((shape as { text: string }).text).toBe(text);
    expect(classify('[{"id":1,"name":"a"},{"id":2,"name":"b"}]').kind).toBe("rows");
  });
});

describe("with a temp directory", () => {
  let dir: string;
  const saved = { ...process.env };
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "autorouter-regress-"));
  });
  afterEach(async () => {
    process.env = { ...saved };
    await rm(dir, { recursive: true, force: true });
  });

  test("writeText writes through a symlink and keeps permissions", async () => {
    const real = join(dir, "real.json");
    const link = join(dir, "link.json");
    await writeFile(real, "old");
    await chmod(real, 0o600);
    await symlink(real, link);

    await writeText(link, "new");

    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(real, "utf8")).toBe("new");
    expect((await stat(real)).mode & 0o777).toBe(0o600);
    // No temp file is left behind.
    expect((await readdir(dir)).sort()).toEqual(["link.json", "real.json"]);
  });

  test("writeText creates a missing file", async () => {
    await writeText(join(dir, "fresh.json"), "{}");
    expect(await readFile(join(dir, "fresh.json"), "utf8")).toBe("{}");
  });

  test("a plugin's root .mcp.json is read, and its root resolves in env", async () => {
    const root = join(dir, "plugins", "acme");
    await mkdir(join(root, ".claude-plugin"), { recursive: true });
    await writeFile(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "acme" }));
    await writeFile(
      join(root, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          tools: {
            command: "node",
            args: ["${CLAUDE_PLUGIN_ROOT}/server.js"],
            env: { DATA_DIR: "${CLAUDE_PLUGIN_ROOT}/data" },
          },
        },
      }),
    );
    await mkdir(join(dir, ".claude", "plugins"), { recursive: true });
    await writeFile(
      join(dir, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({ plugins: { "acme@market": [{ installPath: root }] } }),
    );
    process.env.AUTOROUTER_HOME = dir;
    // The router's own plugin root, as set when it runs as a plugin itself.
    process.env.CLAUDE_PLUGIN_ROOT = "/somewhere/else";

    expect(Object.keys(await readPluginServers(root))).toEqual(["tools"]);
    const [entry] = await loadPluginServers();
    expect(entry).toMatchObject({
      name: "acme:tools",
      transport: "stdio",
      args: [`${root}/server.js`],
      env: { DATA_DIR: `${root}/data` },
      cwd: root,
    });
  });
});
