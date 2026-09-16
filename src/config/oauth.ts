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
  /**
   * Whether `clientInformation` was registered with the device grant in its
   * grant_types. A client registered for the browser flow alone is refused at
   * the device endpoint by any provider that enforces the field, and the
   * refusal (`unauthorized_client`) says nothing about the cause — so the
   * device flow re-registers rather than reusing a client that predates it.
   */
  deviceClient?: boolean;
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

/** RFC 8628 §3.4. Spelled out because it appears in two unrelated requests. */
export const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

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
   * Registration metadata for an RFC 8628 login: the browser client plus the
   * device grant.
   *
   * The device grant never redirects, so dropping `redirect_uris` here is
   * tempting — but RFC 7591 requires them for `authorization_code`, and a
   * provider that validates the pair rejects the registration outright. Keeping
   * both means the one client is valid for either flow, which also makes this a
   * strict superset: a device login on a box that later grows a browser does
   * not need registering again.
   */
  get deviceClientMetadata(): OAuthClientMetadata {
    return {
      ...this.clientMetadata,
      grant_types: [...CLIENT_METADATA.grant_types!, DEVICE_GRANT_TYPE],
    };
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

/** An `insufficient_scope` challenge: the grant is valid, just too narrow. */
export type ScopeChallenge = { required: string[]; description?: string };

/**
 * The most recent `insufficient_scope` challenge seen per server.
 *
 * A 403 never reaches the auth provider the way a 401 does. The transport
 * handles it inline: it re-runs auth() hoping to widen the grant, and auth()
 * takes the refresh path, which does not forward the new scope — so the same
 * token comes back, the replay draws a byte-identical 403, and the transport
 * gives up with `Server returned 403 after trying upscoping`, a message with
 * every useful detail stripped out of it. Refreshing cannot widen a grant, so
 * that retry can never succeed for a provider that binds scopes at issue time.
 * Recording the challenge as it goes past is what lets authHint() name the
 * missing scope instead of repeating the transport's dead end.
 */
const scopeChallenges = new Map<string, ScopeChallenge>();

/** Parses the auth-params of an RFC 6750 `WWW-Authenticate` challenge. */
function authParams(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of header.matchAll(/([A-Za-z_]+)\s*=\s*"([^"]*)"/g)) {
    out[m[1]!.toLowerCase()] = m[2]!;
  }
  return out;
}

export function recordScopeChallenge(server: string, header: string | null | undefined): void {
  if (!header) return;
  const params = authParams(header);
  if (params.error !== "insufficient_scope") return;
  scopeChallenges.set(server, {
    required: params.scope?.split(/\s+/).filter(Boolean) ?? [],
    description: params.error_description,
  });
}

/** Forgets a challenge once the server answers normally again. */
export function clearScopeChallenge(server: string): void {
  scopeChallenges.delete(server);
}

export function scopeChallenge(server: string): ScopeChallenge | undefined {
  return scopeChallenges.get(server);
}

/**
 * Rewrites an authorization failure into the command that fixes it.
 *
 * A 401 from an MCP server is not a broken server, it is a missing grant, and
 * the two want very different responses from the user. This runs on both the
 * indexing path and the call path — a token can expire between a reindex and a
 * tool call, and "Error POSTing to endpoint" is not an actionable thing to show
 * a model mid-task.
 *
 * A 403 is the same idea one step along: the grant exists but was narrowed
 * past what the capability needs, and the fix is a different command.
 */
export function authHint(server: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const challenge = scopeChallenges.get(server);
  if (challenge && /\b403\b|insufficient_scope|upscoping/i.test(message)) {
    const missing = challenge.required.length
      ? `the ${challenge.required.join(", ")} scope${challenge.required.length > 1 ? "s" : ""}`
      : "a scope";
    return (
      `grant is too narrow — this needs ${missing}, which the stored grant does not have.\n` +
      `  Scopes are fixed when a grant is issued and refreshing cannot widen one, so this\n` +
      `  will keep failing until the grant is replaced:\n` +
      `    autorouter login ${server} --force --all-scopes` +
      (challenge.description ? `\n  Server said: ${challenge.description}` : "")
    );
  }
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
