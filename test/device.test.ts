import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OAuthMetadataSchema } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthServerInfo } from "@modelcontextprotocol/sdk/client/auth.js";
import { deviceEndpoint, looksHeadless, runDeviceFlow } from "../src/cli/device.ts";
import { parsePastedRedirect } from "../src/cli/login.ts";
import { DEVICE_GRANT_TYPE, FileTokenStore, readAuth, writeAuth } from "../src/config/oauth.ts";

let home: string;
const prevHome = process.env.AUTOROUTER_HOME;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "autorouter-device-"));
  process.env.AUTOROUTER_HOME = home;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.AUTOROUTER_HOME;
  else process.env.AUTOROUTER_HOME = prevHome;
  await rm(home, { recursive: true, force: true });
});

const AS = "https://auth.example.com";
const TOKEN = `${AS}/token`;
const DEVICE = `${AS}/device`;

function serverInfo(overrides: Record<string, unknown> = {}): OAuthServerInfo {
  return {
    authorizationServerUrl: AS,
    authorizationServerMetadata: {
      issuer: AS,
      authorization_endpoint: `${AS}/authorize`,
      token_endpoint: TOKEN,
      response_types_supported: ["code"],
      device_authorization_endpoint: DEVICE,
      ...overrides,
    } as any,
  };
}

/** A fetch stub that answers a scripted sequence of token-endpoint replies. */
function stubFetch(script: { device?: unknown; token: Array<[number, unknown]> }) {
  const calls: Array<{ url: string; body: URLSearchParams; auth: string | null }> = [];
  let tokenCall = 0;
  const fn = (async (url: any, init: any) => {
    const href = String(url);
    const body = new URLSearchParams(init?.body?.toString() ?? "");
    const headers = new Headers(init?.headers);
    calls.push({ url: href, body, auth: headers.get("authorization") });
    if (href === DEVICE) {
      return new Response(JSON.stringify(script.device ?? {}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const [status, payload] = script.token[Math.min(tokenCall++, script.token.length - 1)]!;
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const GRANT = {
  device_code: "dev-123",
  user_code: "WDJB-MJHT",
  verification_uri: "https://example.com/activate",
  expires_in: 900,
  interval: 5,
};

describe("device endpoint discovery", () => {
  test("survives the SDK's metadata schema, which does not name the key", () => {
    // The whole flow depends on z.looseObject keeping an RFC 8628 key the SDK's
    // own type never declares. If that ever tightens, this is the canary.
    const parsed = OAuthMetadataSchema.parse({
      issuer: AS,
      authorization_endpoint: `${AS}/authorize`,
      token_endpoint: TOKEN,
      response_types_supported: ["code"],
      device_authorization_endpoint: DEVICE,
    });
    expect(deviceEndpoint(parsed as any)).toBe(DEVICE);
  });

  test("absent, empty, or non-string endpoints all read as unsupported", () => {
    expect(deviceEndpoint(undefined)).toBeUndefined();
    expect(deviceEndpoint({ token_endpoint: TOKEN } as any)).toBeUndefined();
    expect(deviceEndpoint({ device_authorization_endpoint: "" } as any)).toBeUndefined();
    expect(deviceEndpoint({ device_authorization_endpoint: 42 } as any)).toBeUndefined();
  });
});

describe("headless detection", () => {
  test("a linux box with no display reads as headless", () => {
    if (process.platform === "darwin" || process.platform === "win32") {
      // The real signal is platform-gated, so assert the escape hatch instead.
      expect(looksHeadless({} as NodeJS.ProcessEnv)).toBe(false);
      expect(looksHeadless({ AUTOROUTER_ASSUME_HEADLESS: "1" } as NodeJS.ProcessEnv)).toBe(true);
      return;
    }
    expect(looksHeadless({} as NodeJS.ProcessEnv)).toBe(true);
    expect(looksHeadless({ DISPLAY: ":0" } as NodeJS.ProcessEnv)).toBe(false);
    expect(looksHeadless({ WAYLAND_DISPLAY: "wayland-0" } as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe("device client registration metadata", () => {
  test("is the browser client plus the device grant, redirect included", () => {
    const store = new FileTokenStore("acme", 33418, () => {});
    const meta = store.deviceClientMetadata;
    expect(meta.grant_types).toContain(DEVICE_GRANT_TYPE);
    // Kept alongside, so one registration still serves a later browser login.
    expect(meta.grant_types).toContain("authorization_code");
    // RFC 7591 requires a redirect for authorization_code even though the
    // device grant never uses one; dropping it gets the registration refused.
    expect(meta.redirect_uris).toEqual(["http://localhost:33418/callback"]);
    expect(meta.response_types).toEqual(["code"]);
    // The browser metadata must stay untouched by the device variant.
    expect(store.clientMetadata.grant_types).not.toContain(DEVICE_GRANT_TYPE);
  });
});

describe("runDeviceFlow", () => {
  /** Skips registration by pre-seeding a client already marked device-capable. */
  async function seedClient(server: string, secret?: string) {
    await writeAuth(server, {
      clientInformation: { client_id: "cid", ...(secret ? { client_secret: secret } : {}) },
      deviceClient: true,
    });
  }

  test("refuses up front when the provider has no device endpoint", async () => {
    const result = await runDeviceFlow({
      server: "acme",
      url: "https://mcp.example.com",
      info: serverInfo({ device_authorization_endpoint: undefined }),
      fetchFn: (() => {
        throw new Error("must not be called");
      }) as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("does not advertise a device authorization endpoint");
    // The fallback has to be named, or the user is left with nothing to try.
    expect(result.message).toContain("--manual");
  });

  test("polls through authorization_pending and slow_down, then stores the grant", async () => {
    await seedClient("acme");
    const lines: string[] = [];
    const { fn, calls } = stubFetch({
      device: GRANT,
      token: [
        [400, { error: "authorization_pending" }],
        [400, { error: "slow_down" }],
        [200, { access_token: "at-1", token_type: "Bearer", refresh_token: "rt-1", scope: "read:x" }],
      ],
    });

    const result = await runDeviceFlow({
      server: "acme",
      url: "https://mcp.example.com",
      scope: "read:x",
      info: serverInfo(),
      fetchFn: fn,
      pollIntervalMs: 1,
      log: (l) => lines.push(l),
    });

    expect(result.ok).toBe(true);
    expect(result.grantedScope).toBe("read:x");
    // The user code and the URL are the entire point of the flow; both must be
    // shown, and a pending poll must not be mistaken for a failure.
    expect(lines.join("\n")).toContain("WDJB-MJHT");
    expect(lines.join("\n")).toContain("https://example.com/activate");

    const stored = await readAuth("acme");
    expect(stored.tokens?.access_token).toBe("at-1");
    expect(stored.tokens?.refresh_token).toBe("rt-1");
    // Recorded so a later --force login repeats the narrowing.
    expect(stored.requestedScope).toBe("read:x");

    const tokenCalls = calls.filter((c) => c.url === TOKEN);
    expect(tokenCalls).toHaveLength(3);
    expect(tokenCalls[0]!.body.get("grant_type")).toBe(DEVICE_GRANT_TYPE);
    expect(tokenCalls[0]!.body.get("device_code")).toBe("dev-123");
    expect(calls[0]!.body.get("scope")).toBe("read:x");
  });

  test("prefers verification_uri_complete but still prints the plain URL", async () => {
    await seedClient("acme");
    const lines: string[] = [];
    const { fn } = stubFetch({
      device: { ...GRANT, verification_uri_complete: "https://example.com/activate?user_code=WDJB-MJHT" },
      token: [[200, { access_token: "at", token_type: "Bearer" }]],
    });
    await runDeviceFlow({
      server: "acme",
      url: "https://mcp.example.com",
      info: serverInfo(),
      fetchFn: fn,
      pollIntervalMs: 1,
      log: (l) => lines.push(l),
    });
    const out = lines.join("\n");
    expect(out).toContain("https://example.com/activate?user_code=WDJB-MJHT");
    expect(out).toContain("https://example.com/activate");
  });

  test("stops on access_denied and expired_token rather than polling on", async () => {
    await seedClient("acme");
    for (const [error, expected] of [
      ["access_denied", "denied"],
      ["expired_token", "expired"],
    ] as const) {
      const { fn, calls } = stubFetch({ device: GRANT, token: [[400, { error }]] });
      const result = await runDeviceFlow({
        server: "acme",
        url: "https://mcp.example.com",
        info: serverInfo(),
        fetchFn: fn,
        pollIntervalMs: 1,
        log: () => {},
      });
      expect(result.ok).toBe(false);
      expect(result.message).toContain(expected);
      expect(calls.filter((c) => c.url === TOKEN)).toHaveLength(1);
    }
  });

  test("sends a client secret as Basic auth, not in the body", async () => {
    await seedClient("acme", "shh");
    const { fn, calls } = stubFetch({
      device: GRANT,
      token: [[200, { access_token: "at", token_type: "Bearer" }]],
    });
    await runDeviceFlow({
      server: "acme",
      url: "https://mcp.example.com",
      info: serverInfo({ token_endpoint_auth_methods_supported: ["client_secret_basic"] }),
      fetchFn: fn,
      pollIntervalMs: 1,
      log: () => {},
    });
    expect(calls[0]!.auth).toBe(`Basic ${btoa("cid:shh")}`);
    expect(calls[0]!.body.get("client_secret")).toBeNull();
  });

  test("reports a refused device request with the provider's error code", async () => {
    await seedClient("acme");
    const fn = (async (url: any) =>
      String(url) === DEVICE
        ? new Response(JSON.stringify({ error: "unauthorized_client" }), { status: 400 })
        : new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const result = await runDeviceFlow({
      server: "acme",
      url: "https://mcp.example.com",
      info: serverInfo(),
      fetchFn: fn,
      pollIntervalMs: 1,
      log: () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("unauthorized_client");
    expect(result.message).toContain("--manual");
  });
});

describe("parsePastedRedirect", () => {
  test("takes the code out of a full redirect URL", () => {
    const r = parsePastedRedirect("http://localhost:33418/callback?code=abc&state=s1", "s1");
    expect(r).toEqual({ code: "abc" });
  });

  test("rejects a URL whose state is not the one we issued", () => {
    // The paste flow has no listener to hijack, but a user can still be handed
    // a crafted URL, and exchanging its code would bind the router to someone
    // else's account.
    const r = parsePastedRedirect("http://localhost:33418/callback?code=abc&state=evil", "s1");
    expect(r).toHaveProperty("error");
    expect((r as { error: string }).error).toContain("state mismatch");
  });

  test("accepts a bare code, which carries no state to check", () => {
    expect(parsePastedRedirect("  abc123  ", "s1")).toEqual({ code: "abc123" });
  });

  test("surfaces an error redirect instead of treating it as a code", () => {
    const r = parsePastedRedirect(
      "http://localhost:33418/callback?error=access_denied&error_description=nope&state=s1",
      "s1",
    );
    expect((r as { error: string }).error).toContain("access_denied");
  });

  test("rejects a mangled paste rather than exchanging it", () => {
    expect(parsePastedRedirect("code=abc&state=s1", "s1")).toHaveProperty("error");
  });
});
