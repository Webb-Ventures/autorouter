import { describe, test, expect } from "bun:test";
import {
  compareVersions,
  detectInstall,
  latestVersion,
  runUpdate,
  updateCommand,
  type Install,
} from "../src/cli/update.ts";

/**
 * Builds an `exists` probe from a list of paths that are present. Detection is
 * pure path reasoning plus these probes, so a whole install layout is just a
 * set of strings — no temp directories needed.
 */
function fs(...present: string[]): (p: string) => boolean {
  const set = new Set(present);
  return (p) => set.has(p);
}

const PKG = "autorouter-mcp";

describe("detectInstall", () => {
  test("npm global: node_modules with no project package.json above it", () => {
    const entry = "/usr/local/lib/node_modules/autorouter-mcp/dist/cli.js";
    const got = detectInstall(entry, fs("/usr/local/lib/node_modules/autorouter-mcp/package.json"));
    expect(got).toEqual({
      kind: "global",
      manager: "npm",
      dir: "/usr/local/lib/node_modules/autorouter-mcp",
    });
  });

  test("bun, pnpm and yarn globals are told apart by their layout", () => {
    const cases: Array<[string, string]> = [
      ["/home/u/.bun/install/global/node_modules/autorouter-mcp", "bun"],
      ["/home/u/Library/pnpm/global/5/node_modules/autorouter-mcp", "pnpm"],
      ["/home/u/.config/yarn/global/node_modules/autorouter-mcp", "yarn"],
    ];
    for (const [root, manager] of cases) {
      const got = detectInstall(`${root}/dist/cli.js`, fs(`${root}/package.json`));
      expect(got).toEqual({ kind: "global", manager: manager as any, dir: root });
    }
  });

  test("a project dependency is distinguished by the package.json above node_modules", () => {
    const root = "/work/app/node_modules/autorouter-mcp";
    const got = detectInstall(
      `${root}/dist/cli.js`,
      fs(`${root}/package.json`, "/work/app/package.json", "/work/app/pnpm-lock.yaml"),
    );
    expect(got).toEqual({
      kind: "project",
      manager: "pnpm",
      dir: root,
      projectDir: "/work/app",
    });
  });

  test("the project's lockfile picks the manager", () => {
    const root = "/work/app/node_modules/autorouter-mcp";
    const lockfiles: Array<[string, string]> = [
      ["bun.lock", "bun"],
      ["bun.lockb", "bun"],
      ["yarn.lock", "yarn"],
      ["package-lock.json", "npm"],
    ];
    for (const [lock, manager] of lockfiles) {
      const got = detectInstall(
        `${root}/dist/cli.js`,
        fs(`${root}/package.json`, "/work/app/package.json", `/work/app/${lock}`),
      );
      expect((got as any).manager).toBe(manager);
    }
    // No lockfile at all still has to resolve to something runnable.
    const bare = detectInstall(`${root}/dist/cli.js`, fs(`${root}/package.json`, "/work/app/package.json"));
    expect((bare as any).manager).toBe("npm");
  });

  test("npx, pnpm dlx and bunx caches are transient, not installs", () => {
    const cases: Array<[string, string]> = [
      ["/home/u/.npm/_npx/a1b2c3/node_modules/autorouter-mcp", "npx"],
      ["/home/u/.local/share/pnpm/store/v3/dlx/9f8e/node_modules/autorouter-mcp", "pnpm dlx"],
      ["/home/u/.bun/install/cache/autorouter-mcp@0.1.0", "bunx"],
    ];
    for (const [root, runner] of cases) {
      const got = detectInstall(`${root}/dist/cli.js`, fs(`${root}/package.json`));
      expect(got.kind).toBe("transient");
      expect((got as any).runner).toBe(runner);
    }
  });

  test("a bunx cache entry is not mistaken for the bun global install", () => {
    // Both live under ~/.bun/install; only the segment after it differs, and
    // getting this backwards would run `bun add -g` on every npx-style run.
    const cache = "/home/u/.bun/install/cache/autorouter-mcp@0.1.0";
    const global = "/home/u/.bun/install/global/node_modules/autorouter-mcp";
    expect(detectInstall(`${cache}/dist/cli.js`, fs(`${cache}/package.json`)).kind).toBe("transient");
    expect(detectInstall(`${global}/dist/cli.js`, fs(`${global}/package.json`)).kind).toBe("global");
  });

  test("a checkout with a .git directory is source, even inside a project tree", () => {
    const root = "/work/app/node_modules/autorouter-mcp";
    const got = detectInstall(
      `${root}/dist/cli.js`,
      fs(`${root}/package.json`, `${root}/.git`, "/work/app/package.json"),
    );
    expect(got).toEqual({ kind: "source", dir: root });
  });

  test("no package.json anywhere above is unknown rather than a wrong guess", () => {
    expect(detectInstall("/opt/weird/cli.js", fs()).kind).toBe("unknown");
  });
});

describe("updateCommand", () => {
  test("each global manager gets its own upgrade syntax", () => {
    const of = (manager: string) =>
      updateCommand({ kind: "global", manager: manager as any, dir: "/x" }, PKG, "1.2.3")!.join(" ");
    expect(of("npm")).toBe(`npm install -g ${PKG}@1.2.3`);
    expect(of("pnpm")).toBe(`pnpm add -g ${PKG}@1.2.3`);
    expect(of("yarn")).toBe(`yarn global add ${PKG}@1.2.3`);
    expect(of("bun")).toBe(`bun add -g ${PKG}@1.2.3`);
  });

  test("a project install upgrades without -g", () => {
    const cmd = updateCommand(
      { kind: "project", manager: "bun", dir: "/x", projectDir: "/work/app" },
      PKG,
      "1.2.3",
    );
    expect(cmd).toEqual(["bun", "add", `${PKG}@1.2.3`]);
  });

  test("the kinds with nothing to upgrade return no command", () => {
    const kinds: Install[] = [
      { kind: "transient", runner: "npx", dir: "/x" },
      { kind: "source", dir: "/x" },
      { kind: "unknown", dir: "/x" },
    ];
    for (const k of kinds) expect(updateCommand(k, PKG)).toBeNull();
  });
});

describe("compareVersions", () => {
  test("orders by numeric precedence, not string order", () => {
    // "0.10.0" < "0.9.0" as strings; this is the bug the comparator exists for.
    expect(compareVersions("0.9.0", "0.10.0")).toBe(-1);
    expect(compareVersions("1.0.0", "0.99.99")).toBe(1);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
  });

  test("a prerelease sorts below its own release", () => {
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBe(1);
    expect(compareVersions("1.0.0-rc.1", "1.0.0-rc.2")).toBe(-1);
  });
});

describe("latestVersion", () => {
  test("reads the version off the registry document", async () => {
    const stub = (async () =>
      new Response(JSON.stringify({ version: "9.9.9" }), { status: 200 })) as unknown as typeof fetch;
    expect(await latestVersion(PKG, stub)).toEqual({ version: "9.9.9" });
  });

  test("a registry failure is reported, not thrown", async () => {
    const stub = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    expect(await latestVersion(PKG, stub)).toEqual({ error: "registry returned 500" });
    const boom = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await latestVersion(PKG, boom)).toEqual({ error: "offline" });
  });
});

describe("runUpdate", () => {
  const registry = (version: string) =>
    (async () => new Response(JSON.stringify({ version }), { status: 200 })) as unknown as typeof fetch;

  const globalInstall = {
    entry: "/usr/local/lib/node_modules/autorouter-mcp/dist/cli.js",
    exists: fs("/usr/local/lib/node_modules/autorouter-mcp/package.json"),
  };

  test("--check reports the command without installing", async () => {
    const r = await runUpdate({ current: "0.1.0", check: true, fetchFn: registry("0.2.0"), ...globalInstall });
    expect(r.ok).toBe(true);
    expect(r.message).toContain("0.1.0 → 0.2.0");
    expect(r.message).toContain(`npm install -g ${PKG}@0.2.0`);
  });

  test("--dry-run names the exact command it would have run", async () => {
    const r = await runUpdate({ current: "0.1.0", dryRun: true, fetchFn: registry("0.2.0"), ...globalInstall });
    expect(r.ok).toBe(true);
    expect(r.message).toContain(`Would run: npm install -g ${PKG}@0.2.0`);
  });

  test("an up-to-date install does nothing and still exits ok", async () => {
    const r = await runUpdate({ current: "0.2.0", fetchFn: registry("0.2.0"), ...globalInstall });
    expect(r.ok).toBe(true);
    expect(r.message).toContain("up to date");
    expect(r.message).toContain("--force");
  });

  test("a newer local build than the registry is still up to date, not a downgrade", async () => {
    // The release workflow publishes after the version bump lands, so a
    // freshly built checkout is routinely ahead. Offering a "update" that
    // installs an older version would be worse than silence.
    const r = await runUpdate({ current: "0.3.0", fetchFn: registry("0.2.0"), ...globalInstall });
    expect(r.ok).toBe(true);
    expect(r.message).toContain("up to date");
  });

  test("a transient copy explains itself instead of running a package manager", async () => {
    const root = "/home/u/.npm/_npx/abc/node_modules/autorouter-mcp";
    const r = await runUpdate({
      current: "0.1.0",
      fetchFn: registry("0.2.0"),
      entry: `${root}/dist/cli.js`,
      exists: fs(`${root}/package.json`),
    });
    expect(r.message).toContain("npx");
    expect(r.message).toContain("fetches the package fresh on every run");
    // It still says a newer version exists — that is why the user asked.
    expect(r.message).toContain("0.1.0 → 0.2.0");
  });

  test("a source checkout is pointed at git, not at npm", async () => {
    const root = "/work/autorouter";
    const r = await runUpdate({
      current: "0.1.0",
      fetchFn: registry("0.2.0"),
      entry: `${root}/dist/cli.js`,
      exists: fs(`${root}/package.json`, `${root}/.git`),
    });
    expect(r.message).toContain("git -C /work/autorouter pull");
    expect(r.message).not.toContain("npm install -g");
  });

  test("an unreachable registry fails loudly rather than installing blind", async () => {
    const boom = (async () => {
      throw new Error("ENOTFOUND");
    }) as unknown as typeof fetch;
    const r = await runUpdate({ current: "0.1.0", fetchFn: boom, ...globalInstall });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("Could not reach the registry");
  });
});
