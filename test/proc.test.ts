import { test, expect, describe } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { run, which } from "../src/util/proc.ts";

describe("which", () => {
  test("resolves a command on PATH to its full path", () => {
    expect(which("sh")).toMatch(/\/sh$/);
  });

  test("returns null for a command that is not installed", () => {
    expect(which("definitely-not-a-real-binary-xyz")).toBeNull();
  });

  test("accepts an explicit path, since cliCommand may be one", () => {
    expect(which("/bin/sh")).toBe("/bin/sh");
  });

  test("rejects a path that exists but is not executable", async () => {
    expect(which("/etc/hosts")).toBeNull();
  });
});

describe("run", () => {
  test("passes input on stdin and captures stdout", async () => {
    const res = await run("cat", [], { input: "candidate list" });
    expect(res.stdout).toBe("candidate list");
    expect(res.code).toBe(0);
  });

  test("reports a non-zero exit with its stderr rather than throwing", async () => {
    const res = await run("sh", ["-c", "echo boom >&2; exit 3"]);
    expect(res.code).toBe(3);
    expect(res.stderr.trim()).toBe("boom");
  });

  test("kills the child once the timeout elapses", async () => {
    const started = Date.now();
    await expect(run("sleep", ["10"], { timeoutMs: 300 })).rejects.toThrow(/timed out/);
    // The point of the timeout is that we do not wait out the full sleep.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("rejects when the command does not exist", async () => {
    await expect(run("no-such-binary-xyz", [])).rejects.toThrow();
  });

  test("does not crash when the child exits without reading stdin", async () => {
    const res = await run("sh", ["-c", "exit 0"], { input: "x".repeat(100_000) });
    expect(res.code).toBe(0);
  });

  test("passes env through to the child", async () => {
    const res = await run("sh", ["-c", "echo $MAX_THINKING_TOKENS"], {
      env: { ...process.env, MAX_THINKING_TOKENS: "0" },
    });
    expect(res.stdout.trim()).toBe("0");
  });
});

// The router is bundled for the Node target so harnesses without Bun can launch
// it with npx. A Bun global anywhere in src/ compiles and tests green under Bun,
// then throws "Bun is not defined" for exactly the users who need the Node
// build — so the rule is asserted here rather than left to a comment.
describe("the Node build", () => {
  test("no source file references a Bun global", async () => {
    const offenders: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(path);
          continue;
        }
        if (!entry.name.endsWith(".ts")) continue;
        const source = await readFile(path, "utf8");
        source.split("\n").forEach((line, i) => {
          const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
          if (/\bBun\s*\./.test(code)) offenders.push(`${path}:${i + 1}`);
        });
      }
    };
    await walk("src");
    expect(offenders).toEqual([]);
  });
});
