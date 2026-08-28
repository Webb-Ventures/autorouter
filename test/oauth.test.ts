import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileTokenStore,
  NeedsLoginError,
  authHint,
  backgroundAuth,
  clearAuth,
  hasAuth,
  oauthDir,
  readAuth,
  setClientInformation,
  writeAuth,
} from "../src/config/oauth.ts";
import { normalizeServer } from "../src/config/adapters/shared.ts";
import { chooseScopes, summarizeScopes } from "../src/cli/login.ts";
import { isReadOnlyScope } from "../src/config/scopes.ts";

let home: string;
const prevHome = process.env.AUTOROUTER_HOME;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "autorouter-oauth-"));
  process.env.AUTOROUTER_HOME = home;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.AUTOROUTER_HOME;
  else process.env.AUTOROUTER_HOME = prevHome;
  await rm(home, { recursive: true, force: true });
});

describe("oauth token store", () => {
  test("round-trips tokens and reports auth state", async () => {
    expect(await hasAuth("datadog")).toBe(false);
    await writeAuth("datadog", { tokens: { access_token: "abc", token_type: "Bearer" } });
    expect(await hasAuth("datadog")).toBe(true);
    expect((await readAuth("datadog")).tokens?.access_token).toBe("abc");
    await clearAuth("datadog");
    expect(await hasAuth("datadog")).toBe(false);
  });

  test("merges patches rather than replacing the file", async () => {
    await writeAuth("supabase", { codeVerifier: "v1" });
    await writeAuth("supabase", { tokens: { access_token: "t", token_type: "Bearer" } });
    const stored = await readAuth("supabase");
    expect(stored.codeVerifier).toBe("v1");
    expect(stored.tokens?.access_token).toBe("t");
  });

  test("keeps 0600 on rewrite, not just on create", async () => {
    // writeFile's mode argument is ignored for an existing file, so a second
    // write could silently widen permissions on a bearer token.
    await writeAuth("linear", { codeVerifier: "v" });
    await writeAuth("linear", { tokens: { access_token: "t", token_type: "Bearer" } });
    const files = await Bun.$`ls ${oauthDir()}`.text();
    const path = join(oauthDir(), files.trim().split("\n")[0]!);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("sanitises namespaced server names into one path segment", async () => {
    await writeAuth("plugin:datadog:mcp", { tokens: { access_token: "t", token_type: "Bearer" } });
    const listing = (await Bun.$`ls ${oauthDir()}`.text()).trim();
    expect(listing).not.toContain("/");
    expect(await hasAuth("plugin:datadog:mcp")).toBe(true);
  });

  test("background provider refuses to open a browser", async () => {
    const provider = backgroundAuth("datadog", 33418);
    expect(provider.redirectUrl).toBe("http://localhost:33418/callback");
    await expect(provider.redirectToAuthorization(new URL("https://example.com/authorize"))).rejects.toThrow(
      NeedsLoginError,
    );
  });

  test("registers its own redirect_uri in client metadata", async () => {
    const provider = new FileTokenStore("datadog", 40000, () => {});
    expect(provider.clientMetadata.redirect_uris).toEqual(["http://localhost:40000/callback"]);
    expect(provider.clientMetadata.token_endpoint_auth_method).toBe("none");
  });

  test("missing PKCE verifier names the command that fixes it", async () => {
    const provider = new FileTokenStore("datadog", 33418, () => {});
    await expect(provider.codeVerifier()).rejects.toThrow(/autorouter login datadog/);
  });

  test("invalidateCredentials('tokens') keeps the client registration", async () => {
    await writeAuth("datadog", {
      tokens: { access_token: "t", token_type: "Bearer" },
      clientInformation: { client_id: "cid" } as any,
    });
    const provider = new FileTokenStore("datadog", 33418, () => {});
    await provider.invalidateCredentials("tokens");
    const stored = await readAuth("datadog");
    expect(stored.tokens).toBeUndefined();
    // Re-registering on every 401 would churn a client record per refresh.
    expect(stored.clientInformation?.client_id).toBe("cid");
  });

  test("invalidateCredentials('all') removes the file entirely", async () => {
    await writeAuth("datadog", { tokens: { access_token: "t", token_type: "Bearer" } });
    await new FileTokenStore("datadog", 33418, () => {}).invalidateCredentials("all");
    expect(await hasAuth("datadog")).toBe(false);
    expect(await readAuth("datadog")).toEqual({});
  });

  test("readAuth tolerates a corrupt file instead of throwing", async () => {
    await writeAuth("datadog", { codeVerifier: "v" });
    const files = (await Bun.$`ls ${oauthDir()}`.text()).trim();
    await Bun.write(join(oauthDir(), files), "{ not json");
    expect(await readAuth("datadog")).toEqual({});
  });
});

describe("autorouter login", () => {
  test("rejects an unknown server by name, listing the real ones", async () => {
    const { runLogin } = await import("../src/cli/login.ts");
    const cwd = await mkdtemp(join(tmpdir(), "autorouter-cwd-"));
    await Bun.write(
      join(cwd, ".autorouter.json"),
      JSON.stringify({ import: [], servers: { real: { url: "https://example.com/mcp" } } }),
    );
    const prevCfg = process.env.AUTOROUTER_CONFIG;
    delete process.env.AUTOROUTER_CONFIG;
    try {
      const result = await runLogin({ server: "nope", cwd });
      expect(result.ok).toBe(false);
      expect(result.message).toContain("real");
    } finally {
      if (prevCfg !== undefined) process.env.AUTOROUTER_CONFIG = prevCfg;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("refuses stdio servers, where OAuth does not apply", async () => {
    const { runLogin } = await import("../src/cli/login.ts");
    const cwd = await mkdtemp(join(tmpdir(), "autorouter-cwd-"));
    await Bun.write(
      join(cwd, ".autorouter.json"),
      JSON.stringify({ import: [], servers: { local: { command: "echo", args: ["hi"] } } }),
    );
    const prevCfg = process.env.AUTOROUTER_CONFIG;
    delete process.env.AUTOROUTER_CONFIG;
    try {
      const result = await runLogin({ server: "local", cwd });
      expect(result.ok).toBe(false);
      expect(result.message).toContain("stdio");
    } finally {
      if (prevCfg !== undefined) process.env.AUTOROUTER_CONFIG = prevCfg;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("does not clobber an existing grant without --force", async () => {
    const { runLogin } = await import("../src/cli/login.ts");
    const cwd = await mkdtemp(join(tmpdir(), "autorouter-cwd-"));
    await Bun.write(
      join(cwd, ".autorouter.json"),
      JSON.stringify({ import: [], servers: { remote: { url: "https://example.com/mcp" } } }),
    );
    await writeAuth("remote", { tokens: { access_token: "t", token_type: "Bearer" } });
    const prevCfg = process.env.AUTOROUTER_CONFIG;
    delete process.env.AUTOROUTER_CONFIG;
    try {
      const result = await runLogin({ server: "remote", cwd });
      expect(result.ok).toBe(true);
      expect(result.message).toContain("--force");
      expect(await hasAuth("remote")).toBe(true);
    } finally {
      if (prevCfg !== undefined) process.env.AUTOROUTER_CONFIG = prevCfg;
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("oauth: state, discovery and pre-registered clients", () => {
  test("issues a fresh CSRF state each time and persists it", async () => {
    const provider = new FileTokenStore("datadog", 33418, () => {});
    const a = await provider.state!();
    expect((await readAuth("datadog")).state).toBe(a);
    const b = await provider.state!();
    // A reused state would let a callback from an abandoned attempt validate.
    expect(b).not.toBe(a);
    expect((await readAuth("datadog")).state).toBe(b);
  });

  test("caches and returns discovery state", async () => {
    const provider = new FileTokenStore("datadog", 33418, () => {});
    expect(await provider.discoveryState!()).toBeUndefined();
    await provider.saveDiscoveryState!({ authorizationServerUrl: "https://as.example.com" } as any);
    expect((await provider.discoveryState!())?.authorizationServerUrl).toBe("https://as.example.com");
  });

  test("invalidateCredentials('discovery') actually clears the cache", async () => {
    const provider = new FileTokenStore("datadog", 33418, () => {});
    await provider.saveDiscoveryState!({ authorizationServerUrl: "https://stale.example.com" } as any);
    await writeAuth("datadog", { tokens: { access_token: "t", token_type: "Bearer" } });
    await provider.invalidateCredentials("discovery");
    // Dropping the cache is the whole recovery path when a provider moves its
    // authorization server; a no-op here strands the user on a dead endpoint.
    expect(await provider.discoveryState!()).toBeUndefined();
    expect((await readAuth("datadog")).tokens?.access_token).toBe("t");
  });

  test("invalidateCredentials('verifier') drops the state with it", async () => {
    const provider = new FileTokenStore("datadog", 33418, () => {});
    await provider.saveCodeVerifier("v");
    await provider.state!();
    await provider.invalidateCredentials("verifier");
    const stored = await readAuth("datadog");
    expect(stored.codeVerifier).toBeUndefined();
    expect(stored.state).toBeUndefined();
  });

  test("invalidateCredentials keeps the file at 0600", async () => {
    await writeAuth("datadog", {
      tokens: { access_token: "t", token_type: "Bearer" },
      clientInformation: { client_id: "cid" } as any,
    });
    await new FileTokenStore("datadog", 33418, () => {}).invalidateCredentials("tokens");
    const file = (await Bun.$`ls ${oauthDir()}`.text()).trim();
    expect((await stat(join(oauthDir(), file))).mode & 0o777).toBe(0o600);
  });

  test("accepts a hand-registered client for servers without RFC 7591", async () => {
    await setClientInformation("github", { client_id: "Iv1.abc", client_secret: "s" } as any);
    const provider = new FileTokenStore("github", 33418, () => {});
    const info = await provider.clientInformation();
    expect(info?.client_id).toBe("Iv1.abc");
    // logout must clear a hand-registered client too, or a stale one survives.
    await clearAuth("github");
    expect(await new FileTokenStore("github", 33418, () => {}).clientInformation()).toBeUndefined();
  });
});

describe("authHint", () => {
  test("rewrites authorization failures into the fixing command", () => {
    for (const err of [
      new Error("HTTP 401 Unauthorized"),
      new Error("Error POSTing to endpoint: invalid_token"),
      new NeedsLoginError("datadog"),
      new Error("invalid_grant: refresh token expired"),
    ]) {
      expect(authHint("datadog", err)).toBe("needs authorization — run: autorouter login datadog");
    }
  });

  test("leaves unrelated failures verbatim", () => {
    // Rewriting a DNS or crash error into "run login" would send the user
    // chasing a credential problem that does not exist.
    expect(authHint("datadog", new Error("getaddrinfo ENOTFOUND"))).toBe("getaddrinfo ENOTFOUND");
    expect(authHint("datadog", new Error("connect ECONNREFUSED"))).toContain("ECONNREFUSED");
  });
});

describe("credential headers", () => {
  test("drops headers that expanded to empty", () => {
    // Datadog ships "${DD_API_KEY:-}". Sending DD_API_KEY:"" makes a server that
    // branches on header presence take the API-key path with an empty key,
    // instead of falling through to the bearer token we do hold.
    delete process.env.DD_API_KEY;
    const entry = normalizeServer(
      "mcp",
      {
        url: "https://mcp.datadoghq.com/v1/mcp",
        headers: { DD_API_KEY: "${DD_API_KEY:-}", "X-Real": "keep" },
      },
      "plugins",
    );
    expect(entry?.transport).toBe("http");
    expect((entry as any).headers).toEqual({ "X-Real": "keep" });
  });

  test("omits the header map entirely when nothing survives", () => {
    delete process.env.DD_API_KEY;
    const entry = normalizeServer(
      "mcp",
      { url: "https://x.example.com/mcp", headers: { DD_API_KEY: "${DD_API_KEY:-}" } },
      "plugins",
    );
    expect((entry as any).headers).toBeUndefined();
  });

  test("keeps a header whose variable is actually set", () => {
    process.env.DD_API_KEY = "real-key";
    try {
      const entry = normalizeServer(
        "mcp",
        { url: "https://x.example.com/mcp", headers: { DD_API_KEY: "${DD_API_KEY:-}" } },
        "plugins",
      );
      expect((entry as any).headers).toEqual({ DD_API_KEY: "real-key" });
    } finally {
      delete process.env.DD_API_KEY;
    }
  });
});

describe("oauth callback validation", () => {
  const evaluate = async (query: string, expected?: string) => {
    const { evaluateCallback } = await import("../src/cli/login.ts");
    return evaluateCallback(new URLSearchParams(query), expected);
  };

  test("accepts a code carrying the state we issued", async () => {
    expect(await evaluate("code=abc&state=s1", "s1")).toEqual({ code: "abc", failure: null });
  });

  test("rejects a code with the wrong state", async () => {
    // Any page the user has open can reach a loopback listener. Exchanging an
    // injected code would bind the router to the attacker's account.
    const r = await evaluate("code=attacker&state=other", "s1");
    expect(r.code).toBeUndefined();
    expect(r.failure).toContain("state mismatch");
  });

  test("rejects a code with no state at all", async () => {
    const r = await evaluate("code=attacker", "s1");
    expect(r.failure).toContain("state mismatch");
  });

  test("surfaces the provider's error_description, not just the code", async () => {
    const r = await evaluate(
      "error=invalid_scope&error_description=mcp_all+is+not+granted&state=s1",
      "s1",
    );
    expect(r.failure).toBe("invalid_scope: mcp_all is not granted");
  });

  test("reports a bare error when no description is given", async () => {
    expect((await evaluate("error=access_denied&state=s1", "s1")).failure).toBe("access_denied");
  });

  test("reports an empty callback rather than hanging", async () => {
    expect((await evaluate("state=s1", "s1")).failure).toBe("no code returned");
  });
});

describe("scope selection", () => {
  const SUPABASE = [
    "organizations:read", "projects:read", "projects:write",
    "database:read", "database:write", "storage:read", "storage:write",
  ];

  test("classifies read and write scopes", () => {
    expect(isReadOnlyScope("database:read")).toBe(true);
    expect(isReadOnlyScope("database:write")).toBe(false);
    expect(isReadOnlyScope("write:issues")).toBe(false);
    expect(isReadOnlyScope("admin.all")).toBe(false);
    // Datadog's single scope: "all" means everything, so it must not pass as
    // read-only just because the word "write" is absent.
    expect(isReadOnlyScope("mcp_all")).toBe(false);
    expect(isReadOnlyScope("mcp_read")).toBe(true);
  });

  test("--read-only keeps only the non-mutating scopes", () => {
    const r = chooseScopes(SUPABASE, { readOnly: true });
    expect(r).toEqual({ scope: "organizations:read projects:read database:read storage:read" });
  });

  test("--read-only refuses rather than silently requesting nothing", () => {
    // Requesting an empty scope is treated by most providers as "give the
    // default", which is the opposite of what was asked for.
    const r = chooseScopes(["mcp_all"], { readOnly: true });
    expect("error" in r && r.error).toContain("no read-only scopes");
  });

  test("--read-only needs advertised scopes to work from", () => {
    const r = chooseScopes([], { readOnly: true });
    expect("error" in r && r.error).toContain("advertises none");
  });

  test("--scopes accepts commas or spaces and wins over --read-only", () => {
    expect(chooseScopes(SUPABASE, { scopes: "database:read, projects:write", readOnly: true }))
      .toEqual({ scope: "database:read projects:write" });
  });

  test("--scopes warns about unadvertised names but still requests them", () => {
    // Datadog advertises only mcp_all yet issues mcp_read; an incomplete
    // discovery document must not block a name the provider accepts.
    const r = chooseScopes(["mcp_all"], { scopes: "mcp_read" });
    expect(r).toEqual({ scope: "mcp_read", warn: ["mcp_read"] });
  });

  test("an empty --scopes is an error, not a full grant", () => {
    expect("error" in chooseScopes(SUPABASE, { scopes: "  " })).toBe(true);
  });

  test("a re-login inherits the previous narrowing", () => {
    expect(chooseScopes(SUPABASE, { previous: "database:read" })).toEqual({ scope: "database:read" });
    // An explicit choice still overrides it.
    expect(chooseScopes(SUPABASE, { previous: "database:read", readOnly: true }))
      .toEqual({ scope: "organizations:read projects:read database:read storage:read" });
  });

  test("with no preference, everything advertised is requested", () => {
    expect(chooseScopes(SUPABASE, {})).toEqual({ scope: SUPABASE.join(" ") });
    expect(chooseScopes([], {})).toEqual({ scope: undefined });
  });

  test("summarizes a short grant in full and a long one by write count", () => {
    expect(summarizeScopes("a:read b:read")).toBe("scope: a:read, b:read  (read-only)");
    const many = Array.from({ length: 20 }, (_, i) => `s${i}:read`).concat("db:write");
    const line = summarizeScopes(many.join(" "));
    expect(line).toContain("21 granted, 1 of them write");
    expect(line).toContain("db:write");
  });
});
