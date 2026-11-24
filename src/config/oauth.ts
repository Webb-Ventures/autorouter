import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
  OAuthServerInfo,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { UnauthorizedError, discoverOAuthServerInfo } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  OAuthMetadataSchema,
  OpenIdProviderDiscoveryMetadataSchema,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { homeDir } from "../util/paths.ts";
import { describeNetworkError } from "../util/net.ts";
import type { OAuthSettings } from "./types.ts";

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
   * The configured `oauth.authServerMetadataUrl` the cached discovery came
   * from; absent when it came from the ordinary discovery chain. A cache built
   * one way is not an answer for the other, so a changed setting discards it.
   */
  discoverySource?: string;
  /**
   * The scopes this grant was deliberately narrowed to, kept so `login --force`
   * and any re-authorization repeat the choice instead of silently widening
   * back to everything the provider advertises.
   */
  requestedScope?: string;
  /**
   * The configured `oauth.scopes` in force when `requestedScope` was chosen. A
   * re-login only inherits the old narrowing while this still matches: an
   * edited pin is an instruction, and repeating the previous request would
   * ignore it.
   */
  pinnedScope?: string;
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
 * Names the `${VAR}` references still unexpanded in a server's OAuth client.
 *
 * Config expansion leaves an unset variable intact so the failure is legible,
 * but for a client id or secret that means sending the literal text
 * `${GMAIL_CLIENT_SECRET}` to the provider and getting back `invalid_client`,
 * which points at the provider rather than at the shell that never exported it.
 */
export function unsetOAuthVars(settings: OAuthSettings | undefined): string[] {
  const names = new Set<string>();
  for (const value of [settings?.clientId, settings?.clientSecret]) {
    for (const m of value?.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g) ?? []) names.add(m[1]!);
  }
  return [...names];
}

/**
 * Fetches the authorization server metadata named by `oauth.authServerMetadataUrl`.
 *
 * This replaces the discovery chain rather than seeding it: the setting exists
 * for servers whose standard endpoints error, so falling back to them on a
 * failure here would hide the misconfiguration behind a second, unrelated
 * error. Returns undefined when nothing is configured.
 */
export async function configuredServerInfo(
  settings: OAuthSettings | undefined,
  fetchFn: FetchLike = fetch,
): Promise<OAuthServerInfo | undefined> {
  const configured = settings?.authServerMetadataUrl;
  if (!configured) return undefined;
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error(`oauth.authServerMetadataUrl is not a URL: ${configured}`);
  }
  // Same rule as Claude Code. The document names the endpoints the client
  // secret and the authorization code are sent to, so it must not be something
  // a network attacker can rewrite.
  if (url.protocol !== "https:") {
    throw new Error(`oauth.authServerMetadataUrl must use https://, got ${configured}`);
  }

  let res: Response;
  try {
    res = await fetchFn(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new Error(
      `could not fetch oauth.authServerMetadataUrl (${configured}): ${describeNetworkError(err) ?? (err instanceof Error ? err.message : String(err))}`,
    );
  }
  if (!res.ok) throw new Error(`oauth.authServerMetadataUrl (${configured}) returned HTTP ${res.status}`);
  const body: unknown = await res.json().catch(() => undefined);
  // RFC 8414 first: its schema keeps unknown keys, and the device endpoint is
  // one of them. The OIDC schema is the fallback for a provider whose document
  // only validates as OpenID discovery.
  const parsed = OAuthMetadataSchema.safeParse(body);
  const metadata = parsed.success ? parsed.data : OpenIdProviderDiscoveryMetadataSchema.safeParse(body).data;
  if (!metadata) {
    throw new Error(
      `oauth.authServerMetadataUrl (${configured}) is not authorization server metadata — ` +
        `it needs at least issuer, authorization_endpoint and token_endpoint`,
    );
  }
  return { authorizationServerUrl: metadata.issuer, authorizationServerMetadata: metadata };
}

/**
 * Discovery for a server, honouring a configured metadata URL.
 *
 * Every place that asks "what does this server's authorization server offer"
 * goes through here, so a server with `authServerMetadataUrl` is never probed
 * at the standard endpoints it was configured to avoid.
 */
export async function discoverServerInfo(
  url: string,
  settings: OAuthSettings | undefined,
  fetchFn: FetchLike = fetch,
): Promise<OAuthServerInfo> {
  return (await configuredServerInfo(settings, fetchFn)) ?? (await discoverOAuthServerInfo(url, { fetchFn }));
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
    /** The server entry's `oauth` block, when it has one. */
    private readonly settings?: OAuthSettings,
    private readonly fetchFn: FetchLike = fetch,
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
    const stored = await readAuth(this.server);
    const source = this.settings?.authServerMetadataUrl;
    if (stored.discovery && stored.discoverySource === source) return stored.discovery;
    // Nothing cached for this setting. With a configured metadata URL the
    // answer comes from there, and returning it is what stops the SDK running
    // the discovery chain — including after it drops the cache on an auth
    // failure, when a background reconnect would otherwise probe the very
    // endpoints this server was configured to bypass.
    const configured = await configuredServerInfo(this.settings, this.fetchFn);
    // Saved here because the SDK only re-saves a state it added something to,
    // and one fetched from a metadata URL may come back from it unchanged.
    if (configured) await this.saveDiscoveryState(configured);
    return configured;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    await writeAuth(this.server, {
      discovery: state,
      discoverySource: this.settings?.authServerMetadataUrl,
    });
  }

  /**
   * A client named in the server's config outranks a stored one: the config is
   * where the user says which app this server uses, and a registration left
   * over from before they said so belongs to a different client. The stored
   * secret is still used when it was saved for the same id, which is how
   * `login --client-secret` supplies one that is deliberately not in the file.
   */
  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const stored = (await readAuth(this.server)).clientInformation;
    const id = this.settings?.clientId;
    if (!id) return stored;
    const secret =
      this.settings?.clientSecret ??
      (stored?.client_id === id && "client_secret" in stored ? stored.client_secret : undefined);
    return { client_id: id, ...(secret ? { client_secret: secret } : {}) };
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
export function authHint(server: string, err: unknown, settings?: OAuthSettings): string {
  const message = err instanceof Error ? err.message : String(err);
  const challenge = scopeChallenges.get(server);
  if (challenge && /\b403\b|insufficient_scope|upscoping/i.test(message)) {
    const missing = challenge.required.length
      ? `the ${challenge.required.join(", ")} scope${challenge.required.length > 1 ? "s" : ""}`
      : "a scope";
    // A pinned server asks for its pin and nothing else, so --all-scopes would
    // re-issue the same grant. The pin is the thing to change.
    if (settings?.scopes) {
      return (
        `grant is too narrow — this needs ${missing}, which the stored grant does not have.\n` +
        `  This server's scopes are pinned by oauth.scopes in its config (${settings.scopes.split(" ").join(", ")}).\n` +
        `  Add the missing scope there, then replace the grant:\n` +
        `    autorouter login ${server} --force` +
        (challenge.description ? `\n  Server said: ${challenge.description}` : "")
      );
    }
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
  if (unauthorized) return `needs authorization — run: autorouter login ${server}`;
  // Not an auth problem, but "fetch failed" is no more actionable than a 401
  // was, so the transport failure gets the same treatment where we can name it.
  return describeNetworkError(err) ?? message;
}

/**
 * A provider for ordinary (non-interactive) connections. It will happily use
 * and refresh a stored token, but refuses to start a browser flow — the router
 * is usually running as a background stdio server with nobody watching.
 */
export function backgroundAuth(
  server: string,
  port: number = CALLBACK_PORT,
  settings?: OAuthSettings,
): FileTokenStore {
  return new FileTokenStore(
    server,
    settings?.callbackPort ?? port,
    () => {
      throw new NeedsLoginError(server);
    },
    settings,
  );
}
