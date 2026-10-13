import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeServer } from "../src/config/adapters/shared.ts";
import { dedupeServers } from "../src/config/resolve.ts";
import { regularAppFor } from "../src/util/macApp.ts";
import { connect } from "../src/catalog/providers/mcp.ts";
import { loadCmux } from "../src/config/adapters/cmux.ts";
import { serializeRefresh } from "../src/config/refresh.ts";
import { readAuth, writeAuth } from "../src/config/oauth.ts";

let dir: string;
const saved = { ...process.env };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "autorouter-launch-"));
  process.env.AUTOROUTER_HOME = dir;
});

afterEach(async () => {
  for (const k of ["AUTOROUTER_HOME", "CMUX_CUA_SOCKET_PATH", "CMUX_BUNDLED_CLI_PATH", "CMUX_SURFACE_ID"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await rm(dir, { recursive: true, force: true });
});

describe("switched-off servers", () => {
  test("Codex's enabled = false is honoured", () => {
    const off = normalizeServer("cua_repl", { command: "/bin/echo", enabled: false } as any, "config");
    const on = normalizeServer("node_repl", { command: "/bin/cat", enabled: true } as any, "config");
    expect(off?.disabled).toBe(true);
    expect(on?.disabled).toBe(false);
    expect(dedupeServers([off!, on!]).map((e) => e.name)).toEqual(["node_repl"]);
  });
});

async function fakeApp(name: string, exe: string, extra = ""): Promise<string> {
  const contents = join(dir, `${name}.app`, "Contents");
  await mkdir(join(contents, "MacOS"), { recursive: true });
  await writeFile(
    join(contents, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>${exe}</string>${extra}</dict></plist>`,
  );
  const bin = join(contents, "MacOS", exe);
  await writeFile(bin, "#!/bin/sh\nexit 0\n");
  await chmod(bin, 0o755);
  return bin;
}

describe.skipIf(process.platform !== "darwin")("desktop app guard", () => {
  test("a regular app's main executable is recognised", async () => {
    expect(await regularAppFor(await fakeApp("ChatGPT", "ChatGPT"))).toBe("ChatGPT");
  });

  test("agent helpers that serve MCP from a bundle are allowed", async () => {
    const helper = await fakeApp("Helper", "helper", "<key>LSUIElement</key><true/>");
    expect(await regularAppFor(helper)).toBeNull();
    const app = await fakeApp("Tool", "Tool");
    const sidecar = join(dir, "Tool.app", "Contents", "MacOS", "tool-mcp");
    await writeFile(sidecar, "#!/bin/sh\n");
    expect(await regularAppFor(sidecar)).toBeNull();
    expect(await regularAppFor("node")).toBeNull();
    expect(app).toBeTruthy();
  });

  test("connect refuses to launch it", async () => {
    const bin = await fakeApp("ChatGPT", "ChatGPT");
    const entry = normalizeServer("cua_repl", { command: bin }, "config")!;
    await expect(connect(entry)).rejects.toThrow(/opens the ChatGPT app/);
  });
});

describe.skipIf(process.platform !== "darwin")("cmux importer", () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  test("absent while cmux is not running", async () => {
    process.env.CMUX_CUA_SOCKET_PATH = join(dir, "missing.sock");
    expect(await loadCmux()).toEqual([]);
  });

  test("rebuilds the injected entry from the live socket", async () => {
    const socket = join(dir, "cua.sock");
    server = createServer();
    await new Promise<void>((r) => server!.listen(socket, r));
    await mkdir(join(dir, "bin"));
    await writeFile(join(dir, "bin", "cmux-cua"), "");
    Object.assign(process.env, {
      CMUX_CUA_SOCKET_PATH: socket,
      CMUX_BUNDLED_CLI_PATH: join(dir, "bin", "cmux"),
      CMUX_SURFACE_ID: "ABC",
    });
    const [entry] = await loadCmux();
    expect(entry).toMatchObject({
      name: "cmux-cua",
      transport: "stdio",
      command: join(dir, "bin", "cmux-cua"),
      args: ["mcp", "--socket", socket],
    });
    expect((entry as any).env.CMUX_CUA_DEFAULT_SESSION).toBe("cmux-ABC");
  });
});

describe("refresh serialization", () => {
  const refreshBody = (token: string) =>
    new URLSearchParams({ grant_type: "refresh_token", refresh_token: token });

  test("a spent refresh token gets the rotated grant, not a revoking request", async () => {
    await writeAuth("stripe", { tokens: { access_token: "a1", token_type: "Bearer", refresh_token: "r1" } });
    let calls = 0;
    // Rotates like Stripe: r1 is single-use.
    const provider = async (_url: any, init?: RequestInit) => {
      calls++;
      await new Promise((r) => setTimeout(r, 50));
      const presented = new URLSearchParams(init!.body as URLSearchParams).get("refresh_token");
      if (presented !== "r1") return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      return Response.json({ access_token: "a2", token_type: "Bearer", refresh_token: "r2" });
    };
    // Two routers holding the same stale token refresh at once.
    const [a, b] = await Promise.all(
      [0, 1].map(() =>
        serializeRefresh("stripe", provider)("https://x/token", { method: "POST", body: refreshBody("r1") }),
      ),
    );
    expect(calls).toBe(1);
    expect([a!.status, b!.status]).toEqual([200, 200]);
    expect(((await b!.json()) as { refresh_token: string }).refresh_token).toBe("r2");
    expect((await readAuth("stripe")).tokens?.refresh_token).toBe("r2");
  });

  test("keeps the refresh token when the provider does not rotate", async () => {
    await writeAuth("linear", { tokens: { access_token: "a1", token_type: "Bearer", refresh_token: "r1" } });
    const provider = async () => Response.json({ access_token: "a2", token_type: "Bearer" });
    await serializeRefresh("linear", provider)("https://x/token", { method: "POST", body: refreshBody("r1") });
    expect((await readAuth("linear")).tokens).toMatchObject({ access_token: "a2", refresh_token: "r1" });
  });

  test("other requests pass straight through", async () => {
    let seen = 0;
    const provider = async () => (seen++, new Response("ok"));
    await serializeRefresh("x", provider)("https://x/mcp", { method: "POST", body: "{}" });
    expect(seen).toBe(1);
  });
});
