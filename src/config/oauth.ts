import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { homeDir } from "../util/paths.ts";

/**
 * Many of the most expensive MCP servers — Datadog, Supabase, Linear — carry no
 * credentials in their config at all. Their headers expand to empty strings and
 * the real token is an OAuth grant the *harness* obtained and keeps in its own
 * credential store. That is why they were the two servers the router could not
 * reach: not misconfiguration, just a token it was never given.
 *
 * Reading another harness's keychain entry would be both fragile and a
 * credential-scope violation — Claude Code's token was issued to Claude Code.
 * The router therefore runs its own OAuth flow and holds its own grant, which
 * also means it works identically under Codex and Cursor, neither of which has
 * a token to borrow.
 *
 * Tokens live in ~/.autorouter/oauth/<server>.json at 0600. They are refreshed
 * automatically via the SDK; `autorouter login` runs the interactive flow.
 */
export type StoredAuth = {
  tokens?: OAuthTokens;
  clientInformation?: OAuthClientInformationMixed;
  codeVerifier?: string;
  /** CSRF state for the in-flight authorization request. */
  state?: string;
  /** Cached RFC 9728/8414 discovery, so a reconnect is one request not four. */
  discovery?: OAuthDiscoveryState;
  /**
   * The scopes this grant was deliberately narrowed to, kept so `login --force`
   * and any re-authorization repeat the choice instead of silently widening
   * back to everything the provider advertises.
   */
  requestedScope?: string;
};

export function oauthDir(): string {
  return join(homeDir(), ".autorouter", "oauth");
}

export function authPath(server: string): string {
  // Server names are free-form and may contain "/" or ":" (plugin namespacing).
  return join(oauthDir(), `${server.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
}

export async function readAuth(server: string): Promise<StoredAuth> {
  try {
    return JSON.parse(await readFile(authPath(server), "utf8")) as StoredAuth;
  } catch {
    return {};
  }
}

export async function writeAuth(
  server: string,
  patch: Partial<StoredAuth>,
  /** Replaces the on-disk base instead of merging onto it (used for deletes). */
  base?: StoredAuth,
): Promise<void> {
  const path = authPath(server);
  await mkdir(oauthDir(), { recursive: true, mode: 0o700 });
  const merged = { ...(base ?? (await readAuth(server))), ...patch };
  await writeFile(path, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  // writeFile's mode is only applied on create, so an existing file keeps
  // whatever permissions it had. These are bearer tokens; be explicit.
  await chmod(path, 0o600);
}

export async function clearAuth(server: string): Promise<void> {
  await rm(authPath(server), { force: true });
}

export async function hasAuth(server: string): Promise<boolean> {
  return Boolean((await readAuth(server)).tokens?.access_token);
}

const CLIENT_METADATA: OAuthClientMetadata = {
  client_name: "autorouter",
  client_uri: "https://github.com/rileywebb/autorouter",
  // Dynamic client registration (RFC 7591) is what lets this work without the
  // user pre-registering an app with every provider. Not every server offers
  // it — GitHub's MCP, for one, has no registration_endpoint — so a
  // pre-registered client can be supplied instead via `login --client-id`.
  redirect_uris: [],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  // Only a hint. selectClientAuthMethod() upgrades this to client_secret_basic
  // or _post when a secret is present, which is what Supabase's DCR returns.
  token_endpoint_auth_method: "none",
};

/**
 * Records a client the user registered by hand, for the servers that do not
 * support RFC 7591. Stored in the same file so `logout` clears it too.
 */
export async function setClientInformation(
  server: string,
  info: OAuthClientInformationMixed,
): Promise<void> {
  await writeAuth(server, { clientInformation: info });
}

/**
 * The SDK-facing provider. `onRedirect` is what distinguishes the two modes:
 * during `autorouter login` it opens a browser, and during a normal connection
 * it throws, because a background reindex must never silently hang waiting for
 * a human to click something.
 */
export class FileTokenStore implements OAuthClientProvider {
  constructor(
    private readonly server: string,
    private readonly redirectPort: number,
    private readonly onRedirect: (url: URL) => void | Promise<void>,
  ) {}

  get redirectUrl(): string {
    return `http://localhost:${this.redirectPort}/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return { ...CLIENT_METADATA, redirect_uris: [this.redirectUrl] };
  }

  /**
   * RFC 6749 §10.12. Without a state parameter the loopback callback will
   * accept any code delivered to it, so a page the user visits during the flow
   * could inject its own and bind the router to an attacker's account. The
   * value is persisted because the callback arrives in a different async
   * context than the one that generated it.
   */
  async state(): Promise<string> {
    const value = randomUUID();
    await writeAuth(this.server, { state: value });
    return value;
  }

  /**
   * Discovery is four network round-trips (RFC 9728 probe, then RFC 8414 with
   * an OIDC fallback). Caching it means a reconnect with a valid token does not
   * repeat them; the SDK invalidates this itself on an auth failure.
   */
  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return (await readAuth(this.server)).discovery;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    await writeAuth(this.server, { discovery: state });
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return (await readAuth(this.server)).clientInformation;
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    await writeAuth(this.server, { clientInformation: info });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await readAuth(this.server)).tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await writeAuth(this.server, { tokens });
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    await writeAuth(this.server, { codeVerifier: verifier });
  }

  async codeVerifier(): Promise<string> {
    const v = (await readAuth(this.server)).codeVerifier;
    if (!v) throw new Error(`No PKCE verifier stored for ${this.server}; run: autorouter login ${this.server}`);
    return v;
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    await this.onRedirect(url);
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    if (scope === "all") return clearAuth(this.server);
    const current = await readAuth(this.server);
    if (scope === "tokens") delete current.tokens;
    if (scope === "client") delete current.clientInformation;
    if (scope === "verifier") {
      delete current.codeVerifier;
      // The state belongs to the same in-flight request as the verifier;
      // leaving it behind would let a stale value validate a later callback.
      delete current.state;
    }
    // The SDK asks for this when a cached endpoint stops working — usually a
    // provider that moved its authorization server. Dropping the cache is the
    // whole recovery path, so it must not be a silent no-op.
    if (scope === "discovery") delete current.discovery;
    // Goes through writeAuth so the explicit chmod applies; writeFile's mode is
    // ignored for a file that already exists.
    await writeAuth(this.server, {}, current);
  }
}

/**
 * The loopback port used for the OAuth redirect.
 *
 * It is fixed rather than ephemeral on purpose: the redirect_uri is baked into
 * the dynamic client registration a provider stores, so a grant obtained on one
 * port cannot be refreshed from another. Overridable for the rare machine where
 * something else already owns it, but it must stay stable once used.
 */
export const CALLBACK_PORT = Number(process.env.AUTOROUTER_OAUTH_PORT) || 33418;

/** Raised when a connection needs a grant the store does not hold. */
export class NeedsLoginError extends Error {
  constructor(readonly server: string) {
    super(`${server} requires authorization: autorouter login ${server}`);
    this.name = "NeedsLoginError";
  }
}

/**
 * Rewrites an authorization failure into the command that fixes it.
 *
 * A 401 from an MCP server is not a broken server, it is a missing grant, and
 * the two want very different responses from the user. This runs on both the
 * indexing path and the call path — a token can expire between a reindex and a
 * tool call, and "Error POSTing to endpoint" is not an actionable thing to show
 * a model mid-task.
 */
export function authHint(server: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const unauthorized =
    err instanceof NeedsLoginError ||
    err instanceof UnauthorizedError ||
    /\b401\b|unauthoriz|invalid_token|invalid_grant|requires authorization/i.test(message);
  return unauthorized ? `needs authorization — run: autorouter login ${server}` : message;
}

/**
 * A provider for ordinary (non-interactive) connections. It will happily use
 * and refresh a stored token, but refuses to start a browser flow — the router
 * is usually running as a background stdio server with nobody watching.
 */
export function backgroundAuth(server: string, port: number = CALLBACK_PORT): FileTokenStore {
  return new FileTokenStore(server, port, () => {
    throw new NeedsLoginError(server);
  });
}
