import { test, expect, describe } from "bun:test";
import { tokenize } from "../src/index/tokenize.ts";
import { Bm25Index } from "../src/index/bm25.ts";
import { parseFrontmatter, keywordsFrom } from "../src/catalog/frontmatter.ts";
import { matchesPattern, estimateTokens } from "../src/catalog/types.ts";
import { parseSelections } from "../src/selector/prompt.ts";
import { compareVersions, profileClient } from "../src/server/clientProfile.ts";
import { dedupeServers } from "../src/config/resolve.ts";
import { normalizeServer, isSelfReference } from "../src/config/adapters/shared.ts";
import { stripJsonComments } from "../src/util/paths.ts";
import { findByName } from "../src/util/fs.ts";
import { join } from "node:path";
import type { Capability } from "../src/catalog/types.ts";
import { capabilityForPrompt, promptList, promptName } from "../src/server/prompts.ts";
import { clamp, compactSchema, tokensOf } from "../src/util/compact.ts";

const CAPS: Capability[] = [
  cap("mcp:supabase/execute_sql", "execute_sql", "Executes raw SQL in the Postgres database.", ["supabase"]),
  cap("mcp:railway/get_logs", "get_logs", "Fetch deployment logs for a Railway service.", ["railway"]),
  cap("skill:dataviz", "dataviz", "Create charts, graphs, plots and dashboards with a consistent palette.", ["chart", "graph"]),
  cap("mcp:datadog/listDashboards", "listDashboards", "List Datadog dashboards and their widgets.", ["datadog"]),
];

function cap(id: string, name: string, description: string, keywords: string[]): Capability {
  return {
    id,
    kind: id.startsWith("skill") ? "skill" : "tool",
    name,
    server: id.split(":")[1]?.split("/")[0],
    description,
    keywords,
    approxTokens: estimateTokens(name, description),
  };
}

describe("tokenize", () => {
  test("splits snake_case and camelCase into words", () => {
    expect(tokenize("execute_sql")).toContain("execute");
    expect(tokenize("execute_sql")).toContain("sql");
    expect(tokenize("listDashboards")).toContain("list");
    expect(tokenize("listDashboards")).toContain("dashboard");
  });

  test("keeps the joined form so exact tool names still match", () => {
    expect(tokenize("execute_sql")).toContain("executesql");
  });

  test("drops stopwords", () => {
    expect(tokenize("how do I use the thing")).not.toContain("the");
  });
});

describe("bm25", () => {
  const index = new Bm25Index(CAPS);

  test("ranks the matching tool first", () => {
    const scores = index.score("run a sql query on postgres");
    const top = [...scores.entries()].sort((a, b) => b[1] - a[1])[0];
    expect(top?.[0]).toBe("mcp:supabase/execute_sql");
  });

  test("matches a camelCase tool name from spaced words", () => {
    const scores = index.score("list dashboards");
    expect(scores.has("mcp:datadog/listDashboards")).toBe(true);
  });

  test("returns nothing for an unrelated query", () => {
    expect(index.score("xyzzy plugh").size).toBe(0);
  });
});

describe("frontmatter", () => {
  test("parses nested metadata and body", () => {
    const { data, body } = parseFrontmatter(
      `---\nname: demo\ndescription: A demo skill\nmetadata:\n  author: Someone\n  hermes-tags: alpha, beta\n---\n# Heading\ntext`,
    );
    expect(data.name).toBe("demo");
    expect(data.metadata.author).toBe("Someone");
    expect(body.trim().startsWith("# Heading")).toBe(true);
  });

  test("extracts keywords from tag-ish fields", () => {
    const { data } = parseFrontmatter(`---\nname: x\nmetadata:\n  hermes-tags: html, review\n---\nbody`);
    expect(keywordsFrom(data)).toEqual(expect.arrayContaining(["html", "review"]));
  });

  test("parses dashed lists", () => {
    const { data } = parseFrontmatter(`---\nname: x\nkeywords:\n  - one\n  - two\n---\nbody`);
    expect(data.keywords).toEqual(["one", "two"]);
  });

  test("passes through a file with no frontmatter", () => {
    expect(parseFrontmatter("# just markdown").data).toEqual({});
  });
});

describe("id patterns", () => {
  test("matches a bare dotted tool reference", () => {
    expect(matchesPattern("mcp:supabase/execute_sql", "supabase.execute_sql")).toBe(true);
  });

  test("matches a server wildcard", () => {
    expect(matchesPattern("mcp:supabase/execute_sql", "mcp:supabase/*")).toBe(true);
    expect(matchesPattern("mcp:railway/get_logs", "mcp:supabase/*")).toBe(false);
  });
});

describe("selector parsing", () => {
  const valid = new Set(CAPS.map((c) => c.id));

  test("parses a clean response", () => {
    const out = parseSelections('{"selections":[{"id":"skill:dataviz","reason":"charts"}]}', valid);
    expect(out).toEqual([{ id: "skill:dataviz", reason: "charts", confidence: undefined }]);
  });

  test("survives a code fence and surrounding prose", () => {
    const raw = 'Here you go:\n```json\n{"selections":[{"id":"mcp:railway/get_logs","reason":"logs"}]}\n```';
    expect(parseSelections(raw, valid)[0]?.id).toBe("mcp:railway/get_logs");
  });

  test("recovers an id the model shortened", () => {
    expect(parseSelections('{"selections":[{"id":"supabase/execute_sql"}]}', valid)[0]?.id).toBe(
      "mcp:supabase/execute_sql",
    );
  });

  test("drops hallucinated ids", () => {
    expect(parseSelections('{"selections":[{"id":"mcp:nope/does_not_exist"}]}', valid)).toEqual([]);
  });

  test("returns empty for unparseable output rather than throwing", () => {
    expect(parseSelections("I could not decide.", valid)).toEqual([]);
  });
});

describe("client profile", () => {
  test("orders versions numerically, not lexically", () => {
    expect(compareVersions("2.1.232", "2.1.99")).toBe(1);
    expect(compareVersions("2.1.0", "2.1.232")).toBe(-1);
  });

  test("enables dynamic tools only for new enough Claude Code", () => {
    expect(profileClient({ name: "claude-code", version: "2.2.0" }, {}).supportsListChanged).toBe(true);
    expect(profileClient({ name: "claude-code", version: "2.0.0" }, {}).supportsListChanged).toBe(false);
  });

  test("defaults to proxy-only for unknown and known-bad clients", () => {
    expect(profileClient({ name: "codex", version: "1.0.0" }, {}).supportsListChanged).toBe(false);
    expect(profileClient({ name: "some-new-agent", version: "9.9.9" }, {}).supportsListChanged).toBe(false);
  });

  test("detects sampling from declared capabilities", () => {
    expect(profileClient({ name: "x", version: "1" }, { sampling: {} }).supportsSampling).toBe(true);
  });
});

describe("server config normalization", () => {
  test("normalizes a stdio entry", () => {
    const e = normalizeServer("semble", { command: "uvx", args: ["semble"] }, "cursor");
    expect(e?.transport).toBe("stdio");
    expect(e?.origin).toBe("cursor");
  });

  test("normalizes an http entry", () => {
    expect(normalizeServer("x", { url: "https://example.com/mcp" }, "claude")?.transport).toBe("http");
  });

  test("rejects an entry with neither command nor url", () => {
    expect(normalizeServer("x", { args: ["y"] }, "claude")).toBeNull();
  });

  test("recognizes the router itself so it cannot recurse", () => {
    const self = normalizeServer("autorouter", { command: "bun", args: ["/x/autorouter/src/cli.ts"] }, "claude")!;
    expect(isSelfReference(self)).toBe(true);
  });
});

describe("dedupe", () => {
  test("collapses the same server registered in two harnesses", () => {
    const entries = [
      normalizeServer("semble", { command: "uvx", args: ["semble"] }, "claude")!,
      normalizeServer("semble-mcp", { command: "uvx", args: ["semble"] }, "cursor")!,
    ];
    const out = dedupeServers(entries);
    expect(out).toHaveLength(1);
    expect(out[0]!.origin).toContain("claude");
    expect(out[0]!.origin).toContain("cursor");
  });

  test("keeps distinct servers and disambiguates name collisions", () => {
    const out = dedupeServers([
      normalizeServer("db", { command: "a" }, "claude")!,
      normalizeServer("db", { command: "b" }, "cursor")!,
    ]);
    expect(out).toHaveLength(2);
    expect(out[1]!.name).toBe("db-2");
  });

  test("drops self-references and disabled entries", () => {
    const out = dedupeServers([
      normalizeServer("autorouter", { command: "npx", args: ["autorouter", "serve"] }, "claude")!,
      normalizeServer("off", { command: "x", disabled: true }, "claude")!,
    ]);
    expect(out).toHaveLength(0);
  });
});

describe("json with comments", () => {
  test("strips line and block comments outside strings", () => {
    const src = `{\n // note\n "a": 1, /* b */ "url": "http://x//y"\n}`;
    expect(JSON.parse(stripJsonComments(src))).toEqual({ a: 1, url: "http://x//y" });
  });
});

describe("frontmatter block scalars", () => {
  test("folds a > scalar into one line", () => {
    const { data } = parseFrontmatter(
      "---\nname: use-railway\ndescription: >\n  Operate Railway infrastructure: sign up,\n  create projects, deploy code.\n---\n\nbody\n",
    );
    // Without this the value parses as the literal ">" and the skill is
    // effectively unsearchable, since description is the main ranked field.
    expect(data.description).toBe("Operate Railway infrastructure: sign up, create projects, deploy code.");
  });

  test("keeps newlines in a | scalar", () => {
    const { data } = parseFrontmatter("---\ndescription: |\n  line one\n  line two\n---\nbody\n");
    expect(data.description).toBe("line one\nline two");
  });

  test("a block scalar does not swallow the following key", () => {
    const { data } = parseFrontmatter(
      "---\ndescription: >\n  wrapped text\n  more text\nversion: 1.0.0\n---\nbody\n",
    );
    expect(data.description).toBe("wrapped text more text");
    expect(data.version).toBe("1.0.0");
  });
});

describe("findByName", () => {
  test("follows symlinked directories", async () => {
    const { mkdtemp, mkdir, writeFile, symlink, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "autorouter-walk-"));
    try {
      // Skill managers install by symlinking into ~/.claude/skills, and a
      // Dirent for a symlink reports isDirectory() === false regardless of
      // target — so a non-following walk silently misses real skills.
      await mkdir(join(dir, "real", "my-skill"), { recursive: true });
      await writeFile(join(dir, "real", "my-skill", "SKILL.md"), "---\nname: my-skill\n---\n");
      await mkdir(join(dir, "skills"), { recursive: true });
      await symlink(join(dir, "real", "my-skill"), join(dir, "skills", "my-skill"));

      const found = await findByName(join(dir, "skills"), "SKILL.md");
      expect(found.length).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("survives a symlink cycle", async () => {
    const { mkdtemp, mkdir, writeFile, symlink, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "autorouter-cycle-"));
    try {
      await mkdir(join(dir, "a"), { recursive: true });
      await writeFile(join(dir, "a", "SKILL.md"), "---\nname: a\n---\n");
      await symlink(dir, join(dir, "a", "loop"));
      const found = await findByName(dir, "SKILL.md");
      expect(found.length).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("prompt naming", () => {
  const cap = (id: string, name: string, server?: string) => ({
    id, kind: "command" as const, name, server, description: "d", keywords: [], approxTokens: 1,
  });

  test("two plugins shipping the same command name both stay reachable", () => {
    const prompts = promptList([
      cap("command:alpha:setup", "setup", "alpha"),
      cap("command:beta:setup", "setup", "beta"),
    ]);
    const names = prompts.map((p) => p.name);
    // Shadowing would make one plugin's slash command silently unreachable.
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("alpha_setup");
    expect(names).toContain("beta_setup");
  });

  test("round-trips a name back to its capability", () => {
    const caps = [cap("command:alpha:setup", "setup", "alpha"), cap("command:beta:setup", "setup", "beta")];
    expect(capabilityForPrompt(caps, "beta_setup")?.id).toBe("command:beta:setup");
    expect(capabilityForPrompt(caps, "nope")).toBeUndefined();
  });

  test("strips characters MCP prompt names disallow", () => {
    expect(promptName(cap("command:a:b/c", "b/c", "plug:in"))).toBe("plug_in_b_c");
  });
});

describe("schema compaction", () => {
  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Ignored",
    type: "object",
    properties: {
      sql: {
        type: "string",
        description: `The query to run. ${"Long prose about syntax. ".repeat(40)}`,
      },
      mode: { type: "string", enum: ["read", "write"], description: "Access mode." },
      opts: {
        type: "object",
        properties: {
          deep: {
            type: "object",
            properties: {
              deeper: { type: "number", description: "A value nobody sets." },
            },
          },
        },
      },
    },
    required: ["sql"],
    additionalProperties: false,
  };

  test("keeps every field needed to build a valid call", () => {
    const out = compactSchema(schema) as any;
    // Structure is what makes a call valid; none of it may be inferred away.
    expect(Object.keys(out.properties)).toEqual(["sql", "mode", "opts"]);
    expect(out.required).toEqual(["sql"]);
    expect(out.properties.mode.enum).toEqual(["read", "write"]);
    expect(out.properties.sql.type).toBe("string");
    expect(out.properties.opts.properties.deep.properties.deeper.type).toBe("number");
    // `false` is a real constraint the downstream server enforces, unlike the
    // `true` default, so it survives.
    expect(out.additionalProperties).toBe(false);
  });

  test("drops metadata and trims prose", () => {
    const out = compactSchema(schema) as any;
    expect(out.$schema).toBeUndefined();
    expect(out.title).toBeUndefined();
    expect(out.properties.sql.description.length).toBeLessThan(200);
    expect(out.properties.sql.description).toContain("The query to run");
    expect(tokensOf(out)).toBeLessThan(tokensOf(schema) / 2);
  });

  test("drops descriptions past the depth cut", () => {
    const out = compactSchema(schema, { maxDepth: 1 }) as any;
    expect(out.properties.opts.properties.deep.properties.deeper.description).toBeUndefined();
    // The name and type still reach the model, which is what it needs to pass one.
    expect(out.properties.opts.properties.deep.properties.deeper.type).toBe("number");
  });

  test("clamp breaks on a word boundary", () => {
    expect(clamp("alpha beta gamma delta", 14)).toBe("alpha beta…");
    expect(clamp("short", 40)).toBe("short");
  });
});

describe("prompt list stays cheap", () => {
  test("clamps descriptions written for humans", () => {
    const long = "A skill that does something. " + "Extra detail for a reader. ".repeat(30);
    const [prompt] = promptList([
      { id: "skill:x", kind: "skill", name: "x", description: long, keywords: [], approxTokens: 1 },
    ] as any).filter((p) => p.name === "x");
    expect(prompt!.description!.length).toBeLessThan(200);
    expect(prompt!.description).toContain("A skill that does something");
  });
});
