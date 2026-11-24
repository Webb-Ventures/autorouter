import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  FileTokenStore,
  authHint,
  backgroundAuth,
  clearScopeChallenge,
  configuredServerInfo,
  readAuth,
  recordScopeChallenge,
  unsetOAuthVars,
  writeAuth,
} from "../src/config/oauth.ts";
import { normalizeServer, oauthSettings } from "../src/config/adapters/shared.ts";
import { dedupeServers } from "../src/config/resolve.ts";
import { chooseScopes, runLogin } from "../src/cli/login.ts";
import { runDeviceFlow } from "../src/cli/device.ts";
import type { ServerEntry } from "../src/config/types.ts";

let home: string;
const prev = { home: process.env.AUTOROUTER_HOME, config: process.env.AUTOROUTER_CONFIG };

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "autorouter-oauth-config-"));
  process.env.AUTOROUTER_HOME = home;
  delete process.env.AUTOROUTER_CONFIG;
});

afterEach(async () => {
  if (prev.home === undefined) delete process.env.AUTOROUTER_HOME;
  else process.env.AUTOROUTER_HOME = prev.home;
  if (prev.config !== undefined) process.env.AUTOROUTER_CONFIG = prev.config;
  await rm(home, { recursive: true, force: true });
});

const MCP = "https://mcp.example.com/mcp";
const AS = "https://auth.example.com";
const METADATA_URL = `${AS}/.well-known/openid-configuration`;
const METADATA = {
  issuer: AS,
  authorization_endpoint: `${AS}/authorize`,
  token_endpoint: `${AS}/token`,
  response_types_supported: ["code"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
  scopes_supported: ["mail.read", "mail.write", "offline_access"],
  device_authorization_endpoint: `${AS}/device`,
};

/** A fetch stub: answers the URLs it is given, 404s the rest, and records every call. */
function stubFetch(routes: Record<string, unknown | ((body: URLSearchParams) => [number, unknown])>) {
  const calls: Array<{ url: string; body: URLSearchParams; auth: string | null }> = [];
  const fn = (async (url: any, init: any) => {
    const href = String(url);
    const body = new URLSearchParams(init?.body?.toString() ?? "");
    calls.push({ url: href, body, auth: new Headers(init?.headers).get("authorization") });
    const route = routes[href];
    if (route === undefined) return new Response("not found", { status: 404 });
    const [status, payload] = typeof route === "function" ? (route as any)(body) : [200, route];
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function httpEntry(name: string, oauth: unknown, origin = "config"): Extract<ServerEntry, { transport: "http" }> {
  const entry = normalizeServer(name, { url: MCP, oauth: oauth as any }, origin);
  if (entry?.transport !== "http") throw new Error("expected an http entry");
  return entry;
}

describe("the oauth block of a server entry", () => {
  test("reads every field Claude Code documents, plus a client secret", () => {
    const entry = httpEntry("gmail", {
      clientId: "cid.apps.example.com",
      clientSecret: "shh",
      callbackPort: 8080,
      authServerMetadataUrl: METADATA_URL,
      scopes: "channels:read chat:write",
    });
    expect(entry.oauth).toEqual({
      clientId: "cid.apps.example.com",
      clientSecret: "shh",
      callbackPort: 8080,
      authServerMetadataUrl: METADATA_URL,
      scopes: "channels:read chat:write",
    });
  });

  test("is read wherever Claude Code would read it, not just from the router's config", () => {
    for (const origin of ["claude", "claude:mcp.json", "plugins", "cursor", "config:project"]) {
      expect(httpEntry("s", { clientId: "cid" }, origin).oauth).toEqual({ clientId: "cid" });
    }
  });

  test("expands ${VAR} so a secret can stay out of the file", () => {
    process.env.AUTOROUTER_TEST_SECRET = "from-env";
    try {
      const entry = httpEntry("s", { clientId: "cid", clientSecret: "${AUTOROUTER_TEST_SECRET}" });
      expect(entry.oauth?.clientSecret).toBe("from-env");
    } finally {
      delete process.env.AUTOROUTER_TEST_SECRET;
    }
  });

  test("accepts the obvious hand-written variants", () => {
    expect(oauthSettings({ callbackPort: "8080" })).toEqual({ callbackPort: 8080 });
    expect(oauthSettings({ scopes: ["a", "b"] })).toEqual({ scopes: "a b" });
    expect(oauthSettings({ scopes: "a, b  a" })).toEqual({ scopes: "a b" });
  });

  test("drops values that cannot be used, and the block when nothing is left", () => {
    expect(oauthSettings({ callbackPort: 0 })).toBeUndefined();
    expect(oauthSettings({ callbackPort: 70000 })).toBeUndefined();
    expect(oauthSettings({ callbackPort: "http" })).toBeUndefined();
    expect(oauthSettings({ clientId: "  ", scopes: "" })).toBeUndefined();
    expect(oauthSettings({ clientId: 42 })).toBeUndefined();
    expect(oauthSettings(undefined)).toBeUndefined();
    expect(httpEntry("s", {}).oauth).toBeUndefined();
  });

  test("does not apply to a stdio server", () => {
    const entry = normalizeServer("local", { command: "x", oauth: { clientId: "cid" } }, "config");
    expect((entry as any).oauth).toBeUndefined();
  });

  test("survives de-duplication, whichever registration keeps its name", () => {
    const bare = (name: string) => normalizeServer(name, { url: MCP }, "claude")!;
    const configured = (name: string) => httpEntry(name, { clientId: "cid" });
    // The kept (shorter-named) entry is the one without the block.
    const [a] = dedupeServers([configured("gmail-server"), bare("gmail")]);
    expect(a).toMatchObject({ name: "gmail", oauth: { clientId: "cid" } });
    // The kept entry came first and the later duplicate carries the block.
    const [b] = dedupeServers([bare("gmail"), configured("gmail-server")]);
    expect(b).toMatchObject({ name: "gmail", oauth: { clientId: "cid" } });
  });
});

describe("a configured client", () => {
  const noop = () => {};

  test("outranks a stored registration", async () => {
    await writeAuth("gmail", { clientInformation: { client_id: "registered-earlier", client_secret: "old" } });
    const store = new FileTokenStore("gmail", 33418, noop, { clientId: "cid", clientSecret: "shh" });
    expect(await store.clientInformation()).toEqual({ client_id: "cid", client_secret: "shh" });
  });

  test("uses a stored secret only when it was saved for the same client", async () => {
    await writeAuth("gmail", { clientInformation: { client_id: "cid", client_secret: "from-flag" } });
    const same = new FileTokenStore("gmail", 33418, noop, { clientId: "cid" });
    expect(await same.clientInformation()).toEqual({ client_id: "cid", client_secret: "from-flag" });
    const other = new FileTokenStore("gmail", 33418, noop, { clientId: "another" });
    expect(await other.clientInformation()).toEqual({ client_id: "another" });
  });

  test("without one, the stored registration is used as before", async () => {
    await writeAuth("linear", { clientInformation: { client_id: "dcr" } });
    expect(await new FileTokenStore("linear", 33418, noop).clientInformation()).toEqual({ client_id: "dcr" });
    expect(await new FileTokenStore("fresh", 33418, noop, { scopes: "a" }).clientInformation()).toBeUndefined();
  });

  test("callbackPort sets the redirect for background connections too", () => {
    expect(backgroundAuth("gmail", undefined, { callbackPort: 8080 }).redirectUrl).toBe(
      "http://localhost:8080/callback",
    );
    expect(backgroundAuth("gmail").redirectUrl).toMatch(/^http:\/\/localhost:\d+\/callback$/);
  });

  test("names ${VAR} references that never expanded", () => {
    expect(unsetOAuthVars({ clientId: "${A_ID}", clientSecret: "x${B_SECRET}y" })).toEqual(["A_ID", "B_SECRET"]);
    expect(unsetOAuthVars({ clientId: "cid", clientSecret: "shh" })).toEqual([]);
    expect(unsetOAuthVars(undefined)).toEqual([]);
  });
});

describe("authServerMetadataUrl", () => {
  test("is fetched in place of discovery", async () => {
    const { fn, calls } = stubFetch({ [METADATA_URL]: METADATA });
    const info = await configuredServerInfo({ authServerMetadataUrl: METADATA_URL }, fn);
    expect(info?.authorizationServerUrl).toBe(AS);
    expect(info?.authorizationServerMetadata?.token_endpoint).toBe(`${AS}/token`);
    // Unknown keys survive, which is what keeps the device flow detectable.
    expect((info?.authorizationServerMetadata as any).device_authorization_endpoint).toBe(`${AS}/device`);
    expect(calls.map((c) => c.url)).toEqual([METADATA_URL]);
  });

  test("is nothing when not configured", async () => {
    expect(await configuredServerInfo(undefined)).toBeUndefined();
    expect(await configuredServerInfo({ clientId: "cid" })).toBeUndefined();
  });

  test("must be https, and must be authorization server metadata", async () => {
    const { fn } = stubFetch({ "https://auth.example.com/wrong": { hello: "world" } });
    await expect(
      configuredServerInfo({ authServerMetadataUrl: "http://auth.example.com/meta" }, fn),
    ).rejects.toThrow(/must use https:\/\//);
    await expect(configuredServerInfo({ authServerMetadataUrl: "not a url" }, fn)).rejects.toThrow(/is not a URL/);
    await expect(
      configuredServerInfo({ authServerMetadataUrl: "https://auth.example.com/missing" }, fn),
    ).rejects.toThrow(/returned HTTP 404/);
    await expect(
      configuredServerInfo({ authServerMetadataUrl: "https://auth.example.com/wrong" }, fn),
    ).rejects.toThrow(/is not authorization server metadata/);
  });

  test("is cached per setting, so changing it discards the old discovery", async () => {
    const other = `${AS}/other-metadata`;
    const { fn, calls } = stubFetch({
      [METADATA_URL]: METADATA,
      [other]: { ...METADATA, token_endpoint: `${AS}/token-2` },
    });
    const store = (url?: string) =>
      new FileTokenStore("gmail", 33418, () => {}, url ? { authServerMetadataUrl: url } : undefined, fn);

    expect((await store(METADATA_URL).discoveryState())?.authorizationServerMetadata?.token_endpoint).toBe(`${AS}/token`);
    await store(METADATA_URL).discoveryState();
    expect(calls).toHaveLength(1);

    // A different URL is a different answer, not a cache hit.
    expect((await store(other).discoveryState())?.authorizationServerMetadata?.token_endpoint).toBe(`${AS}/token-2`);
    expect(calls).toHaveLength(2);

    // Removing the setting must not leave the router using what it fetched.
    expect(await store().discoveryState()).toBeUndefined();
  });

  test("ordinary cached discovery is still served to a server with no setting", async () => {
    const state = { authorizationServerUrl: AS, authorizationServerMetadata: METADATA as any };
    await writeAuth("linear", { discovery: state });
    expect(await new FileTokenStore("linear", 33418, () => {}).discoveryState()).toEqual(state);
  });
});

describe("authorizing with a configured oauth block", () => {
  test("the authorize request and the token exchange both come from the config", async () => {
    const settings = {
      clientId: "cid.apps.example.com",
      clientSecret: "shh",
      callbackPort: 8080,
      authServerMetadataUrl: METADATA_URL,
    };
    const { fn, calls } = stubFetch({
      [METADATA_URL]: METADATA,
      [`${AS}/token`]: () => [200, { access_token: "at", token_type: "Bearer", refresh_token: "rt" }],
    });
    const redirects: URL[] = [];
    const provider = new FileTokenStore("gmail", 8080, (url) => void redirects.push(url), settings, fn);

    expect(await auth(provider, { serverUrl: MCP, scope: "mail.read", fetchFn: fn })).toBe("REDIRECT");
    const redirect = redirects[0]!;
    expect(redirect.origin + redirect.pathname).toBe(`${AS}/authorize`);
    expect(redirect.searchParams.get("client_id")).toBe("cid.apps.example.com");
    expect(redirect.searchParams.get("redirect_uri")).toBe("http://localhost:8080/callback");
    expect(redirect.searchParams.get("scope")).toBe("mail.read");
    // No registration was attempted, and the authorization server was never
    // looked up at the standard well-known paths.
    expect(calls.some((c) => c.url.includes("/register"))).toBe(false);
    expect(calls.some((c) => c.url.includes("oauth-authorization-server"))).toBe(false);

    expect(await auth(provider, { serverUrl: MCP, authorizationCode: "the-code", fetchFn: fn })).toBe("AUTHORIZED");
    const exchange = calls.find((c) => c.url === `${AS}/token`)!;
    expect(exchange.body.get("code")).toBe("the-code");
    expect(exchange.body.get("client_id")).toBe("cid.apps.example.com");
    expect(exchange.body.get("client_secret")).toBe("shh");
    expect((await readAuth("gmail")).tokens?.access_token).toBe("at");
    // The secret came from the config and was not copied into the token file.
    expect((await readAuth("gmail")).clientInformation).toBeUndefined();
  });

  test("the device flow uses the configured client instead of registering one", async () => {
    const { fn, calls } = stubFetch({
      [METADATA_URL]: { ...METADATA, registration_endpoint: `${AS}/register` },
      [`${AS}/device`]: {
        device_code: "dev",
        user_code: "ABCD",
        verification_uri: "https://example.com/activate",
        expires_in: 900,
      },
      [`${AS}/token`]: () => [200, { access_token: "at", token_type: "Bearer", scope: "mail.read" }],
    });
    const result = await runDeviceFlow({
      server: "gmail",
      url: MCP,
      scope: "mail.read",
      settings: { clientId: "cid", clientSecret: "shh", authServerMetadataUrl: METADATA_URL, scopes: "mail.read" },
      fetchFn: fn,
      pollIntervalMs: 1,
      log: () => {},
    });
    expect(result.ok).toBe(true);
    expect(calls.some((c) => c.url === `${AS}/register`)).toBe(false);
    const device = calls.find((c) => c.url === `${AS}/device`)!;
    expect(device.body.get("client_id")).toBe("cid");
    expect(device.body.get("client_secret")).toBe("shh");
    const stored = await readAuth("gmail");
    expect(stored.clientInformation).toBeUndefined();
    // Recorded with the grant, so a later re-login knows which pin it was made under.
    expect(stored.pinnedScope).toBe("mail.read");
  });
});

describe("oauth.scopes", () => {
  const advertised = ["mail.read", "mail.write", "labels.read"];

  test("pins the request, whatever the server advertises", () => {
    expect(chooseScopes(advertised, { pinned: "mail.read labels.read" })).toEqual({
      scope: "mail.read labels.read",
    });
    // Also when the server advertises nothing at all.
    expect(chooseScopes([], { pinned: "mail.read" })).toEqual({ scope: "mail.read" });
  });

  test("appends offline_access when the server offers it, as Claude Code does", () => {
    expect(chooseScopes([...advertised, "offline_access"], { pinned: "mail.read" })).toEqual({
      scope: "mail.read offline_access",
    });
    expect(chooseScopes([...advertised, "offline_access"], { pinned: "offline_access mail.read" })).toEqual({
      scope: "offline_access mail.read",
    });
  });

  test("--scopes still wins for one run", () => {
    expect(chooseScopes(advertised, { pinned: "mail.read", scopes: "mail.write" })).toEqual({
      scope: "mail.write",
    });
  });

  test("--read-only narrows inside the pin", () => {
    expect(chooseScopes(advertised, { pinned: "mail.read mail.write", readOnly: true })).toEqual({
      scope: "mail.read",
    });
    const none = chooseScopes(advertised, { pinned: "mail.write", readOnly: true });
    expect("error" in none && none.error).toContain("no read-only scopes are in the pinned set");
  });

  test("--all-scopes cannot widen past the pin, and says so", () => {
    const result = chooseScopes(advertised, { pinned: "mail.read", allScopes: true });
    expect(result).toMatchObject({ scope: "mail.read" });
    expect("note" in result && result.note).toContain("Add a scope there to widen the grant");
  });

  test("a re-login keeps its narrowing only while the pin is unchanged", () => {
    const pinned = "mail.read mail.write";
    // Same pin as when the grant was narrowed: the narrowing holds.
    expect(chooseScopes(advertised, { pinned, previous: "mail.read", previousPin: pinned })).toEqual({
      scope: "mail.read",
    });
    // The pin was edited: the config is followed.
    expect(chooseScopes(advertised, { pinned, previous: "mail.read", previousPin: "mail.read" })).toEqual({
      scope: pinned,
    });
    // A pin was added to a server that had an unpinned grant.
    expect(chooseScopes(advertised, { pinned, previous: "labels.read" })).toEqual({ scope: pinned });
    // The pin was removed: back to what the server advertises.
    expect(chooseScopes(advertised, { previous: "mail.read", previousPin: "mail.read" })).toEqual({
      scope: advertised.join(" "),
    });
    // No pin before or now: unchanged behaviour.
    expect(chooseScopes(advertised, { previous: "mail.read" })).toEqual({ scope: "mail.read" });
  });

  test("an insufficient_scope failure points at the pin, not at --all-scopes", () => {
    recordScopeChallenge("gmail", 'Bearer error="insufficient_scope", scope="mail.write"');
    try {
      const hint = authHint("gmail", new Error("Server returned 403 after trying upscoping"), {
        scopes: "mail.read",
      });
      expect(hint).toContain("pinned by oauth.scopes");
      expect(hint).toContain("autorouter login gmail --force");
      expect(hint).not.toContain("--all-scopes");
      // An unpinned server keeps the original advice.
      expect(authHint("gmail", new Error("Server returned 403 after trying upscoping"))).toContain("--all-scopes");
    } finally {
      clearScopeChallenge("gmail");
    }
  });
});

describe("autorouter login with a configured oauth block", () => {
  async function configure(oauth: unknown): Promise<string> {
    const cwd = await mkdtemp(join(home, "cwd-"));
    await Bun.write(
      join(cwd, ".autorouter.json"),
      JSON.stringify({ import: [], servers: { gmail: { url: MCP, oauth } } }),
    );
    return cwd;
  }

  test("stops on a ${VAR} that is not set, naming it", async () => {
    delete process.env.AUTOROUTER_TEST_UNSET;
    const cwd = await configure({ clientId: "cid", clientSecret: "${AUTOROUTER_TEST_UNSET}" });
    const result = await runLogin({ server: "gmail", cwd });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("${AUTOROUTER_TEST_UNSET}");
    expect(result.message).toContain("not set in this shell");
  });

  test("refuses a --client-id that contradicts the config", async () => {
    const cwd = await configure({ clientId: "cid" });
    const result = await runLogin({ server: "gmail", cwd, clientId: "different" });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("--client-id differs from the oauth.clientId");
    // Nothing was written for a login that never started.
    expect((await readAuth("gmail")).clientInformation).toBeUndefined();
  });

  test("--client-secret alone needs a client id from somewhere", async () => {
    const cwd = await configure({ scopes: "mail.read" });
    const result = await runLogin({ server: "gmail", cwd, clientSecret: "shh" });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("--client-secret needs a client");
  });

  test("reports a bad authServerMetadataUrl instead of falling back to discovery", async () => {
    const cwd = await configure({ clientId: "cid", authServerMetadataUrl: "http://auth.example.com/meta" });
    // --manual so nothing is bound and no browser is opened on the way to the error.
    const result = await runLogin({ server: "gmail", cwd, manual: true });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("oauth.authServerMetadataUrl must use https://");
  });
});
