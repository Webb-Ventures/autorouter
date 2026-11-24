import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLogin } from "../src/cli/login.ts";
import { runLocalLogin } from "../src/cli/loginLocal.ts";
import { normalizeServer } from "../src/config/adapters/shared.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "fake-mcp-server.ts");

let dir: string;
const prev = { home: process.env.AUTOROUTER_HOME, config: process.env.AUTOROUTER_CONFIG };

/** Writes a router config holding exactly these servers and nothing imported. */
async function configure(servers: Record<string, unknown>): Promise<void> {
  await Bun.write(join(dir, ".autorouter.json"), JSON.stringify({ import: [], servers }));
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "autorouter-login-local-"));
  process.env.AUTOROUTER_HOME = dir;
  delete process.env.AUTOROUTER_CONFIG;
});

afterEach(async () => {
  if (prev.home === undefined) delete process.env.AUTOROUTER_HOME;
  else process.env.AUTOROUTER_HOME = prev.home;
  if (prev.config !== undefined) process.env.AUTOROUTER_CONFIG = prev.config;
  await rm(dir, { recursive: true, force: true });
});

describe("login key on a server entry", () => {
  test("is read from the router's own config, as an argv or one string", () => {
    const argv = normalizeServer("r", { command: "railway", args: ["mcp"], login: ["railway", "login"] }, "config");
    const text = normalizeServer("r", { command: "railway", args: ["mcp"], login: " railway  login " }, "config:project");
    expect(argv).toMatchObject({ transport: "stdio", login: ["railway", "login"] });
    expect(text).toMatchObject({ transport: "stdio", login: ["railway", "login"] });
  });

  test("is ignored anywhere a repository could have written it", () => {
    // .mcp.json approval pins command + args only, so a login key there is
    // outside what the user approved.
    for (const origin of ["claude:mcp.json", "claude", "cursor", "plugins"]) {
      const entry = normalizeServer("r", { command: "railway", args: ["mcp"], login: ["sh", "-c", "evil"] }, origin);
      expect((entry as any).login).toBeUndefined();
    }
  });

  test("an empty value means no sign-in command", () => {
    expect((normalizeServer("r", { command: "x", login: "  " }, "config") as any).login).toBeUndefined();
    expect((normalizeServer("r", { command: "x", login: [] }, "config") as any).login).toBeUndefined();
  });
});

describe("autorouter login <stdio server>", () => {
  test("with no sign-in command, starts the server and reports what answered", async () => {
    await configure({ fake: { command: "bun", args: [FIXTURE] } });
    const result = await runLogin({ server: "fake", cwd: dir });
    expect(result.ok).toBe(true);
    // New reach, so the CLI follows it with a reindex.
    expect(result.authorized).toBe(true);
    expect(result.message).toMatch(/fake: started — it answers with \d+ capabilities/);
    expect(result.message).toContain("autorouter login fake -- <command>");
  });

  test("runs the command after --, with the server's env, before starting it", async () => {
    const marker = join(dir, "signed-in");
    await configure({ fake: { command: "bun", args: [FIXTURE], env: { FAKE_PROFILE: "work" } } });
    const result = await runLogin({
      server: "fake",
      cwd: dir,
      loginCommand: ["bun", "-e", `await Bun.write(${JSON.stringify(marker)}, process.env.FAKE_PROFILE ?? "unset")`],
    });
    expect(result.ok).toBe(true);
    expect(result.authorized).toBe(true);
    expect(result.message).toContain("fake: signed in");
    expect(await Bun.file(marker).text()).toBe("work");
  });

  test("falls back to the configured login command", async () => {
    const marker = join(dir, "configured");
    await configure({
      fake: {
        command: "bun",
        args: [FIXTURE],
        login: ["bun", "-e", `await Bun.write(${JSON.stringify(marker)}, "ran")`],
      },
    });
    const result = await runLogin({ server: "fake", cwd: dir });
    expect(result.ok).toBe(true);
    expect(await Bun.file(marker).text()).toBe("ran");
  });

  test("a failed sign-in command is a failed login, and the server is not started", async () => {
    await configure({ fake: { command: "bun", args: [FIXTURE] } });
    const result = await runLogin({
      server: "fake",
      cwd: dir,
      loginCommand: ["bun", "-e", "process.exit(3)"],
    });
    expect(result.ok).toBe(false);
    expect(result.authorized).toBeUndefined();
    expect(result.message).toContain("exited with code 3");
  });

  test("names a sign-in command that is not installed", async () => {
    await configure({ fake: { command: "bun", args: [FIXTURE] } });
    const result = await runLogin({
      server: "fake",
      cwd: dir,
      loginCommand: ["autorouter-no-such-binary", "login"],
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("autorouter-no-such-binary was not found on PATH");
  });

  test("a server that exits instead of starting is reported, with the next step", async () => {
    await configure({ broken: { command: "bun", args: ["-e", "process.exit(1)"] } });
    const result = await runLogin({ server: "broken", cwd: dir });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("broken: the server did not start");
    expect(result.message).toContain("autorouter login broken -- <command>");
  });

  test("gives up on a server that never answers", async () => {
    const entry = normalizeServer("hung", { command: "bun", args: ["-e", "setTimeout(() => {}, 60000)"] }, "config");
    if (entry?.transport !== "stdio") throw new Error("expected a stdio entry");
    const started = Date.now();
    const result = await runLocalLogin(entry, { timeoutMs: 300 });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("timed out");
    // Returned on the timeout, not when the child's own 60s timer ran out.
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  test("refuses each OAuth-only flag by name", async () => {
    await configure({ fake: { command: "bun", args: [FIXTURE] } });
    const result = await runLogin({ server: "fake", cwd: dir, device: true, scopes: "a,b" });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("--scopes, --device do not apply");
  });
});

describe("autorouter login <http server> -- <command>", () => {
  test("is refused: an http server is authorized over OAuth", async () => {
    await configure({ remote: { url: "https://example.com/mcp" } });
    const result = await runLogin({ server: "remote", cwd: dir, loginCommand: ["some", "login"] });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("http server");
  });
});
