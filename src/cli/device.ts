import {
  discoverOAuthServerInfo,
  registerClient,
  selectClientAuthMethod,
  selectResourceURL,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthServerInfo } from "@modelcontextprotocol/sdk/client/auth.js";
import type { AuthorizationServerMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { CALLBACK_PORT, DEVICE_GRANT_TYPE, FileTokenStore, readAuth, writeAuth } from "../config/oauth.ts";

/**
 * RFC 8628 device authorization grant — the login path for a machine with no
 * browser on it.
 *
 * The authorization-code flow in login.ts is unusable over SSH: it binds a
 * loopback listener and expects a browser on the same host to redirect into it.
 * A headless box has neither, and forwarding the port only moves the problem.
 * The device grant inverts the handoff — the server prints a short code, the
 * human types it into a browser on whatever device they already have, and the
 * headless side learns the outcome by polling. Nothing has to reach back in.
 *
 * Not every provider implements it. Detection is `device_authorization_endpoint`
 * in the authorization server metadata; when it is absent the caller falls back
 * to the paste-the-code flow rather than failing, because a server the user
 * cannot log into is the thing this is meant to prevent.
 */

/** RFC 8628 §3.2. */
type DeviceAuthorization = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  /** The URI with the code pre-filled — saves the user typing it. */
  verification_uri_complete?: string;
  expires_in?: number;
  interval?: number;
};

/**
 * The endpoint, if this provider offers the grant at all.
 *
 * `grant_types_supported` is checked as well as the endpoint because a provider
 * may publish the endpoint while omitting the grant — and the reverse, which is
 * why the endpoint alone is enough. RFC 8414 does not require either to be
 * present, so treating the endpoint as authoritative is the lenient reading.
 * The metadata schemas are `z.looseObject`, so both keys survive parsing even
 * though the SDK's own type does not name them.
 */
export function deviceEndpoint(metadata: AuthorizationServerMetadata | undefined): string | undefined {
  const endpoint = (metadata as Record<string, unknown> | undefined)?.device_authorization_endpoint;
  return typeof endpoint === "string" && endpoint ? endpoint : undefined;
}

/**
 * Whether this looks like a box a browser cannot be opened on.
 *
 * Used only to pick a better default and to word an error, never to refuse a
 * flow the user asked for by name. macOS and Windows always have a window
 * server; on Linux and the BSDs an absent DISPLAY and WAYLAND_DISPLAY is the
 * ordinary signature of a server install, and an SSH session without one is the
 * case this whole module exists for.
 */
export function looksHeadless(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.AUTOROUTER_ASSUME_HEADLESS === "1") return true;
  if (process.platform === "darwin" || process.platform === "win32") return false;
  return !env.DISPLAY && !env.WAYLAND_DISPLAY;
}

/**
 * Applies client credentials the way the SDK does internally.
 *
 * The SDK keeps `applyClientAuthentication` private, and the device grant needs
 * the same treatment at both the device and token endpoints — Supabase's DCR
 * hands back a secret, and sending it in the body when the provider expects it
 * in the Authorization header fails as an invalid_client.
 */
function authenticateClient(
  client: OAuthClientInformationMixed,
  metadata: AuthorizationServerMetadata | undefined,
  headers: Headers,
  params: URLSearchParams,
): void {
  const method = selectClientAuthMethod(client, metadata?.token_endpoint_auth_methods_supported ?? []);
  const secret = "client_secret" in client ? client.client_secret : undefined;
  if (method === "client_secret_basic" && secret) {
    headers.set("Authorization", `Basic ${btoa(`${client.client_id}:${secret}`)}`);
    return;
  }
  params.set("client_id", client.client_id);
  if (method === "client_secret_post" && secret) params.set("client_secret", secret);
}

/** Pulls the RFC 6749 §5.2 error code out of a response, whatever its shape. */
async function errorCode(res: Response): Promise<{ code: string; description?: string }> {
  const text = await res.text().catch(() => "");
  try {
    const body = JSON.parse(text) as { error?: string; error_description?: string };
    if (body.error) return { code: body.error, description: body.error_description };
  } catch {
    // Not JSON. Some providers return an HTML error page on a malformed
    // device request; the status line is all there is to report.
  }
  return { code: `http_${res.status}`, description: text.slice(0, 200) || undefined };
}

export type DeviceLoginResult = {
  ok: boolean;
  message: string;
  /** What the provider actually issued, which is rarely what was asked for. */
  grantedScope?: string;
};

/**
 * Runs the full device grant for one server and stores the tokens.
 *
 * Client registration is repeated here rather than reused from a previous
 * authorization-code login: a client registered with only `authorization_code`
 * in its grant_types is rejected at the device endpoint by any provider that
 * enforces the field, and that rejection reads as `unauthorized_client` with no
 * hint about why. Re-registering with the device grant included is cheap and
 * removes a failure mode the user cannot diagnose.
 */
export async function runDeviceFlow(opts: {
  server: string;
  url: string;
  scope?: string;
  /** Emits progress; injected so tests can capture it. */
  log?: (line: string) => void;
  /** Overrides the provider's poll interval. Tests use it to avoid real waits. */
  pollIntervalMs?: number;
  fetchFn?: typeof fetch;
  /** Discovery already performed by the caller, to avoid repeating four requests. */
  info?: OAuthServerInfo;
  /** The loopback port registered as this client's redirect. Never bound here. */
  port?: number;
}): Promise<DeviceLoginResult> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const doFetch = opts.fetchFn ?? fetch;

  const info = opts.info ?? (await discoverOAuthServerInfo(opts.url, { fetchFn: doFetch }));
  const metadata = info.authorizationServerMetadata;
  const endpoint = deviceEndpoint(metadata);
  if (!endpoint) {
    return {
      ok: false,
      message:
        `${opts.server} does not advertise a device authorization endpoint, so RFC 8628 is not ` +
        `available for it.\n` +
        `  Authorize from a machine with a browser, or use the paste-the-code flow:\n` +
        `    autorouter login ${opts.server} --manual`,
    };
  }

  // The device grant never redirects, but the provider object is what carries
  // resource selection and the token store, and the redirect it registers has
  // to be the real callback port: this client is reused for a browser login if
  // the machine ever gets a display, and a redirect_uri registered on the wrong
  // port cannot be corrected without re-registering. Nothing is bound here.
  const store = new FileTokenStore(opts.server, opts.port ?? CALLBACK_PORT, () => {
    throw new Error("unreachable: the device grant does not redirect");
  });
  const resource = await selectResourceURL(opts.url, store, info.resourceMetadata);

  let client = (await readAuth(opts.server)).clientInformation;
  const registeredForDevice = (await readAuth(opts.server)).deviceClient === true;
  if (!client || !registeredForDevice) {
    if (!metadata?.registration_endpoint && !client) {
      return {
        ok: false,
        message:
          `${opts.server} supports the device grant but not dynamic client registration, so it ` +
          `needs an OAuth app you register yourself.\n` +
          `  Then: autorouter login ${opts.server} --device --client-id <id> [--client-secret <secret>]`,
      };
    }
    if (metadata?.registration_endpoint) {
      try {
        client = await registerClient(info.authorizationServerUrl, {
          metadata,
          clientMetadata: store.deviceClientMetadata,
          scope: opts.scope,
          fetchFn: doFetch,
        });
        await writeAuth(opts.server, { clientInformation: client, deviceClient: true });
      } catch (err) {
        // A client the user supplied by hand is worth trying even when
        // re-registration fails — they may have created it with the device
        // grant already enabled.
        if (!client) {
          return { ok: false, message: `${opts.server}: client registration failed — ${message(err)}` };
        }
      }
    }
  }
  if (!client) return { ok: false, message: `${opts.server}: no OAuth client available.` };

  // Step 1: ask for a user code.
  const deviceParams = new URLSearchParams();
  const deviceHeaders = new Headers({ "content-type": "application/x-www-form-urlencoded" });
  authenticateClient(client, metadata, deviceHeaders, deviceParams);
  if (opts.scope) deviceParams.set("scope", opts.scope);
  if (resource) deviceParams.set("resource", resource.href);

  const deviceRes = await doFetch(endpoint, {
    method: "POST",
    headers: deviceHeaders,
    body: deviceParams,
  });
  if (!deviceRes.ok) {
    const { code, description } = await errorCode(deviceRes);
    return {
      ok: false,
      message:
        `${opts.server}: the device authorization request was refused (${code})` +
        (description ? ` — ${description}` : "") +
        (code === "unauthorized_client"
          ? `\n  The provider may not allow this grant for dynamically registered clients.\n` +
            `  Try: autorouter login ${opts.server} --manual`
          : ""),
    };
  }
  const grant = (await deviceRes.json()) as DeviceAuthorization;
  if (!grant.device_code || !grant.user_code || !grant.verification_uri) {
    return { ok: false, message: `${opts.server}: the device authorization response was incomplete.` };
  }

  log(
    `\nTo authorize ${opts.server}, open this on any device with a browser:\n\n` +
      `  ${grant.verification_uri_complete ?? grant.verification_uri}\n\n` +
      `  and enter the code:  ${grant.user_code}\n` +
      (grant.verification_uri_complete
        ? `  (that link has the code filled in; the plain URL is ${grant.verification_uri})\n`
        : "") +
      `\nWaiting for you to finish${grant.expires_in ? ` — the code expires in ${Math.round(grant.expires_in / 60)} min` : ""}…`,
  );

  // Step 2: poll. RFC 8628 §3.5 — the interval is the provider's floor, and a
  // slow_down means add five seconds to it permanently, not just once.
  let intervalMs = opts.pollIntervalMs ?? (grant.interval ?? 5) * 1000;
  const bumpMs = opts.pollIntervalMs ? 0 : 5000;
  const deadline = Date.now() + (grant.expires_in ?? 900) * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const params = new URLSearchParams();
    const headers = new Headers({ "content-type": "application/x-www-form-urlencoded" });
    authenticateClient(client, metadata, headers, params);
    params.set("grant_type", DEVICE_GRANT_TYPE);
    params.set("device_code", grant.device_code);
    if (resource) params.set("resource", resource.href);

    const res = await doFetch(metadata!.token_endpoint, { method: "POST", headers, body: params });
    if (res.ok) {
      const tokens = (await res.json()) as OAuthTokens;
      await writeAuth(opts.server, {
        tokens,
        ...(opts.scope ? { requestedScope: opts.scope } : {}),
      });
      return { ok: true, message: "", grantedScope: tokens.scope ?? opts.scope };
    }
    const { code, description } = await errorCode(res);
    if (code === "authorization_pending") continue;
    if (code === "slow_down") {
      intervalMs += bumpMs;
      continue;
    }
    if (code === "access_denied") {
      return { ok: false, message: `${opts.server}: authorization was denied.` };
    }
    if (code === "expired_token") {
      return { ok: false, message: `${opts.server}: the code expired before it was entered. Run the command again.` };
    }
    return {
      ok: false,
      message: `${opts.server}: token request failed (${code})${description ? ` — ${description}` : ""}`,
    };
  }
  return { ok: false, message: `${opts.server}: timed out waiting for the code to be entered.` };
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
