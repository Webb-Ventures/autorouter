import { test, expect, describe } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability } from "../src/catalog/types.ts";
import { DEFAULT_CONFIG } from "../src/config/types.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "fake-mcp-server.ts");

/**
 * A sandboxed home, cache and router config. Every path the code under test
 * derives from homeDir() lands in `dir`, so nothing here touches the real
 * ~/.claude.json or ~/.cache/autorouter.
 */
async function sandbox(config: Record<string, unknown>) {
  const saved = { ...process.env };
  const dir = await mkdtemp(join(tmpdir(), "autorouter-cache-"));
  const configPath = join(dir, "autorouter.json");
  await writeFile(configPath, JSON.stringify({ skillPaths: [], selector: { mode: "off" }, ...config }));
  process.env.AUTOROUTER_CONFIG = configPath;
  process.env.AUTOROUTER_HOME = dir;
  process.env.AUTOROUTER_CACHE_DIR = join(dir, "cache");
  return {
    dir,
    cleanup: async () => {
      process.env = saved;
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** Writes a file and moves its mtime, so a change can never hide inside one mtime tick. */
let tick = 0;
async function rewrite(path: string, contents: string): Promise<void> {
  await writeFile(path, contents);
  const t = new Date(Date.now() + 60_000 * ++tick);
  await utimes(path, t, t);
}

describe("~/.claude.json is fingerprinted by what the catalog reads from it", () => {
  /**
   * Claude Code rewrites this file every few minutes for its own bookkeeping.
   * With an mtime fingerprint each of those writes made the next search wait
   * for a rebuild that reconnected to every server.
   */
  test("an unrelated edit leaves the catalog fresh; server, trust and parse changes do not", async () => {
    const { dir, cleanup } = await sandbox({ import: ["claude"] });
    try {
      const { buildCatalog, isStale } = await import("../src/catalog/build.ts");
      const { resolveConfig } = await import("../src/config/resolve.ts");
      const project = join(dir, "proj");
      await mkdir(project, { recursive: true });
      const claudeJson = join(dir, ".claude.json");
      const doc: any = {
        numStartups: 1,
        tipsHistory: { a: 1 },
        mcpServers: {},
        projects: { [project]: { allowedTools: [], hasTrustDialogAccepted: false }, "/elsewhere": { lastCost: 1 } },
      };
      await rewrite(claudeJson, JSON.stringify(doc));
      const catalog = await buildCatalog(await resolveConfig(project));
      expect(catalog.sources[claudeJson]).toContain("#");
      expect(await isStale(catalog, 3600)).toBe(false);

      // Bookkeeping, another project's history, and a key reorder: none of it
      // is anything the importers or the trust check read.
      doc.numStartups = 2;
      doc.tipsHistory = { a: 2, b: 1 };
      doc.projects["/elsewhere"].lastCost = 9;
      doc.projects[project].allowedTools = ["Bash"];
      await rewrite(claudeJson, JSON.stringify({ projects: doc.projects, ...doc }, null, 2));
      expect(await isStale(catalog, 3600)).toBe(false);

      // A server registered globally.
      await rewrite(claudeJson, JSON.stringify({ ...doc, mcpServers: { remote: { url: "http://127.0.0.1:9/mcp" } } }));
      expect(await isStale(catalog, 3600)).toBe(true);

      // Trusting the folder changes which .mcp.json servers are launched.
      const trusted = structuredClone(doc);
      trusted.projects[project].hasTrustDialogAccepted = true;
      await rewrite(claudeJson, JSON.stringify(trusted));
      expect(await isStale(catalog, 3600)).toBe(true);

      // A file that cannot be parsed is a change, never "unchanged".
      await rewrite(claudeJson, "{ not json");
      expect(await isStale(catalog, 3600)).toBe(true);

      // Back to the original inputs: fresh again, whatever the stat says.
      await rewrite(claudeJson, JSON.stringify(doc));
      expect(await isStale(catalog, 3600)).toBe(false);
    } finally {
      await cleanup();
    }
  }, 30_000);

  test("a linked worktree follows the main checkout's trust flag", async () => {
    const { dir, cleanup } = await sandbox({ import: ["claude"] });
    try {
      const { buildCatalog, isStale } = await import("../src/catalog/build.ts");
      const { resolveConfig } = await import("../src/config/resolve.ts");
      const main = join(dir, "main");
      const tree = join(dir, "tree");
      await mkdir(join(main, ".git", "worktrees", "tree"), { recursive: true });
      await mkdir(tree, { recursive: true });
      await writeFile(join(tree, ".git"), `gitdir: ${join(main, ".git", "worktrees", "tree")}\n`);
      const claudeJson = join(dir, ".claude.json");
      await rewrite(claudeJson, JSON.stringify({ projects: { [main]: {} } }));
      const catalog = await buildCatalog(await resolveConfig(tree));

      await rewrite(claudeJson, JSON.stringify({ projects: { [main]: { hasTrustDialogAccepted: true } } }));
      expect(await isStale(catalog, 3600)).toBe(true);
    } finally {
      await cleanup();
    }
  }, 30_000);

  test("~/.claude/settings.json only counts for its .mcp.json approvals", async () => {
    const { dir, cleanup } = await sandbox({ import: ["claude"] });
    try {
      const { buildCatalog, isStale } = await import("../src/catalog/build.ts");
      const { resolveConfig } = await import("../src/config/resolve.ts");
      const settings = join(dir, ".claude", "settings.json");
      await mkdir(join(dir, ".claude"), { recursive: true });
      await rewrite(settings, JSON.stringify({ theme: "dark" }));
      const catalog = await buildCatalog(await resolveConfig(join(dir, "proj")));

      await rewrite(settings, JSON.stringify({ theme: "light", hooks: {} }));
      expect(await isStale(catalog, 3600)).toBe(false);
      await rewrite(settings, JSON.stringify({ theme: "light", enabledMcpjsonServers: ["db"] }));
      expect(await isStale(catalog, 3600)).toBe(true);
    } finally {
      await cleanup();
    }
  }, 30_000);

  test("an install under CLAUDE_CONFIG_DIR is fingerprinted the same way", async () => {
    const { dir, cleanup } = await sandbox({ import: ["claude"] });
    try {
      const { buildCatalog, isStale } = await import("../src/catalog/build.ts");
      const { resolveConfig } = await import("../src/config/resolve.ts");
      const alt = join(dir, ".claude-alt");
      await mkdir(alt, { recursive: true });
      process.env.CLAUDE_CONFIG_DIR = alt;
      // This install keeps its state file inside its own dir.
      const claudeJson = join(alt, ".claude.json");
      const settings = join(alt, "settings.json");
      await rewrite(claudeJson, JSON.stringify({ numStartups: 1, mcpServers: {} }));
      await rewrite(settings, JSON.stringify({ theme: "dark" }));
      const resolved = await resolveConfig(join(dir, "proj"));
      const catalog = await buildCatalog(resolved);
      expect(catalog.sources[claudeJson]).toContain("#");
      expect(catalog.sources[settings]).toContain("#");

      await rewrite(claudeJson, JSON.stringify({ numStartups: 2, mcpServers: {} }));
      await rewrite(settings, JSON.stringify({ theme: "light" }));
      expect(await isStale(catalog, 3600, resolved.install)).toBe(false);

      await rewrite(claudeJson, JSON.stringify({ numStartups: 2, mcpServers: { db: { command: "db" } } }));
      expect(await isStale(catalog, 3600, resolved.install)).toBe(true);
    } finally {
      await cleanup();
    }
  }, 30_000);

  test("a catalog written with the old stat-only value is stale exactly once", async () => {
    const { dir, cleanup } = await sandbox({ import: ["claude"] });
    try {
      const { buildCatalog, isStale } = await import("../src/catalog/build.ts");
      const { resolveConfig } = await import("../src/config/resolve.ts");
      const claudeJson = join(dir, ".claude.json");
      await rewrite(claudeJson, JSON.stringify({ mcpServers: {} }));
      const resolved = await resolveConfig(join(dir, "proj"));
      const fresh = await buildCatalog(resolved);
      const st = await stat(claudeJson);
      const old = { ...fresh, sources: { ...fresh.sources, [claudeJson]: `${st.mtimeMs}:${st.size}` } };
      expect(await isStale(old, 3600)).toBe(true);
      expect(await isStale(await buildCatalog(resolved), 3600)).toBe(false);
    } finally {
      await cleanup();
    }
  }, 30_000);
});

describe("a stale cached catalog is rebuilt once", () => {
  /**
   * getCatalog served the stale catalog and rebuilt in the background, but the
   * serving process never used that result: the first search found its
   * in-memory catalog stale and rebuilt again, launching every server twice.
   */
  test("the router adopts the background build instead of starting another", async () => {
    const { dir, cleanup } = await sandbox({ import: [] });
    const launches = join(dir, "launches.log");
    await writeFile(
      process.env.AUTOROUTER_CONFIG!,
      JSON.stringify({
        import: [],
        skillPaths: [],
        selector: { mode: "off" },
        servers: { fake: { command: "bun", args: [FIXTURE], env: { FAKE_MCP_LAUNCH_LOG: launches } } },
      }),
    );
    const count = async () => (await readFile(launches, "utf8").catch(() => "")).split("\n").filter(Boolean).length;
    try {
      const { Router } = await import("../src/router.ts");
      const { catalogPath, loadCatalog } = await import("../src/catalog/build.ts");
      const first = await Router.create({ cwd: dir, force: true });
      await first.close();
      expect(await count()).toBe(1);

      // Age the cached catalog past its TTL.
      const path = catalogPath(dir);
      const cached = JSON.parse(await readFile(path, "utf8"));
      await writeFile(path, JSON.stringify({ ...cached, builtAt: 0 }));

      const router = await Router.create({ cwd: dir });
      try {
        expect(router.catalog.builtAt).toBe(0);
        // What a search does: wait for a pending rebuild, reporting it was stale.
        expect(await router.refresh()).toBe(true);
        expect(router.catalog.builtAt).toBeGreaterThan(0);
        expect(router.catalog.capabilities.some((c) => c.id === "mcp:fake/run_sql_query")).toBe(true);
        // Fresh now, so a second search builds nothing.
        expect(await router.refresh()).toBe(false);
        expect(await count()).toBe(2);
        expect((await loadCatalog(dir))!.builtAt).toBeGreaterThan(0);
      } finally {
        await router.close();
      }
    } finally {
      await cleanup();
    }
  }, 60_000);
});

describe("add does not start the new server twice", () => {
  test("the catalog rebuild reuses what add just enumerated", async () => {
    const { dir, cleanup } = await sandbox({ import: [] });
    const launches = join(dir, "launches.log");
    try {
      const { runAdd } = await import("../src/cli/add.ts");
      const { loadCatalog } = await import("../src/catalog/build.ts");
      const res = await runAdd(
        { name: "fake", command: "bun", args: [FIXTURE], env: { FAKE_MCP_LAUNCH_LOG: launches } },
        dir,
      );
      expect(res.ok).toBe(true);
      expect((await readFile(launches, "utf8")).split("\n").filter(Boolean)).toHaveLength(1);
      const catalog = (await loadCatalog(dir))!;
      expect(res.capabilities).toBeGreaterThan(0);
      expect(catalog.capabilities.filter((c) => c.server === "fake")).toHaveLength(res.capabilities!);
    } finally {
      await cleanup();
    }
  }, 60_000);
});

describe("old catalogs are pruned", () => {
  test("only catalog-*.json files past the age limit go, never the one being kept", async () => {
    const { dir, cleanup } = await sandbox({ import: [] });
    try {
      const { pruneCatalogs } = await import("../src/catalog/build.ts");
      const cache = join(dir, "cache");
      await mkdir(cache, { recursive: true });
      const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
      for (const name of ["catalog-old-1.json", "catalog-kept-2.json", "catalog-recent-3.json", "vectors-x.json", "notes.json"]) {
        await writeFile(join(cache, name), "{}");
        if (name !== "catalog-recent-3.json") await utimes(join(cache, name), old, old);
      }
      await mkdir(join(cache, "results"));

      const removed = await pruneCatalogs(join(cache, "catalog-kept-2.json"));
      expect(removed).toEqual([join(cache, "catalog-old-1.json")]);
      expect((await readdir(cache)).sort()).toEqual(
        ["catalog-kept-2.json", "catalog-recent-3.json", "notes.json", "results", "vectors-x.json"],
      );
    } finally {
      await cleanup();
    }
  });

  test("a missing cache directory is not an error", async () => {
    const { cleanup } = await sandbox({ import: [] });
    try {
      const { pruneCatalogs } = await import("../src/catalog/build.ts");
      expect(await pruneCatalogs("/nowhere/catalog-x.json")).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});

describe("concurrent reads keep their order", () => {
  test("the first skill root to define a skill still wins", async () => {
    const { dir, cleanup } = await sandbox({ import: [] });
    try {
      const { collectSkills } = await import("../src/catalog/providers/skills.ts");
      const roots = ["a", "b"].map((r) => join(dir, r));
      for (const [i, root] of roots.entries()) {
        for (const name of ["shared", `only-${i}`]) {
          await mkdir(join(root, name), { recursive: true });
          await writeFile(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: from ${i}\n---\n`);
        }
      }
      const { capabilities } = await collectSkills(roots, dir, { includePlugins: false });
      expect(capabilities.find((c) => c.name === "shared")!.description).toBe("from 0");
      expect(capabilities.map((c) => c.name).filter((n) => n.startsWith("only"))).toEqual(["only-0", "only-1"]);
    } finally {
      await cleanup();
    }
  });
});

describe("spill paging reuses the file it just wrote", () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `cus_${i}`, plan: i % 2 ? "pro" : "free" }));

  test("a deleted or rewritten file is still noticed", async () => {
    const { dir, cleanup } = await sandbox({ import: [] });
    try {
      const { ResultStore } = await import("../src/server/spill.ts");
      const s = new ResultStore({ ...DEFAULT_CONFIG, resultsMode: "file", spillOverTokens: 100 }, join(dir, "proj"));
      const out = await s.process("mcp:db/q", "db/q", [{ type: "text", text: JSON.stringify(rows(500)) }]);
      const card = (out.content[0] as any).text as string;
      const handle = /result:([0-9a-f]{8})/.exec(card)![1]!;
      const file = /file:\s+(\S+)/.exec(card)![1]!;

      const page: any = await s.page(handle, { offset: 0 });
      expect(page.content[0].text).toContain('{"id":"cus_0"');

      await rewrite(file, '{"id":"replaced"}\n');
      const after: any = await s.page(handle, { offset: 0 });
      expect(after.content[0].text).toContain('{"id":"replaced"}');

      await unlink(file);
      const gone: any = await s.page(handle, { offset: 0 });
      expect(gone.isError).toBe(true);
      expect(gone.content[0].text).toContain("no longer on disk");
    } finally {
      await cleanup();
    }
  });

  test("an envelope is still recognised as rows", async () => {
    const { classifyValue } = await import("../src/server/spill.ts");
    const envelope = { object: "list", has_more: true, next: "c_9", data: rows(50) };
    const shape = classifyValue(envelope);
    expect(shape.kind).toBe("rows");
    // Mostly wrapper: not rows, as before.
    expect(classifyValue({ note: "x".repeat(5000), data: rows(2) }).kind).toBe("json");
  });
});

describe("embeddings", () => {
  function fakeCap(id: string, description: string): Capability {
    return { id, kind: "tool", name: id.split("/").pop()!, server: "a", description, keywords: [], approxTokens: 1 };
  }

  test("a stalled endpoint times out instead of hanging", async () => {
    const { createProvider } = await import("../src/index/embeddings.ts");
    const server = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) });
    try {
      const provider = createProvider({ provider: "openai-compatible", baseUrl: `http://127.0.0.1:${server.port}` })!;
      // Raced against a deadline of its own, so a regression fails here rather
      // than hanging the run on a request that never ends.
      const outcome = await Promise.race([
        provider.embed(["q"], { timeoutMs: 200 }).then(
          () => "resolved",
          () => "rejected",
        ),
        new Promise((r) => setTimeout(() => r("hung"), 3_000)),
      ]);
      expect(outcome).toBe("rejected");
    } finally {
      server.stop(true);
    }
  });

  test("superseded vectors are pruned; other catalogs' are kept", async () => {
    const { dir, cleanup } = await sandbox({ import: [] });
    try {
      const { embedCatalog } = await import("../src/index/embeddings.ts");
      let calls = 0;
      const provider = {
        id: "fake:1",
        async embed(texts: string[]) {
          calls++;
          return texts.map(() => Float32Array.from([1, 0]));
        },
      };
      await embedCatalog(provider, [fakeCap("mcp:a/x", "first"), fakeCap("mcp:b/y", "other project")]);
      // The description of x changes; y belongs to a catalog not loaded now.
      const vectors = await embedCatalog(provider, [fakeCap("mcp:a/x", "second")]);
      expect(vectors?.size).toBe(1);
      expect(calls).toBe(2);

      const cacheFile = (await readdir(join(dir, "cache"))).find((f) => f.startsWith("vectors-"))!;
      const keys = Object.keys(JSON.parse(await readFile(join(dir, "cache", cacheFile), "utf8")).entries);
      expect(keys.filter((k) => k.startsWith("mcp:a/x#"))).toHaveLength(1);
      expect(keys.some((k) => k.startsWith("mcp:b/y#"))).toBe(true);
    } finally {
      await cleanup();
    }
  });
});
