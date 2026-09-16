import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { auth, discoverOAuthServerInfo } from "@modelcontextprotocol/sdk/client/auth.js";
import { resolveConfig } from "../config/resolve.ts";
import {
  CALLBACK_PORT,
  FileTokenStore,
  clearAuth,
  hasAuth,
  readAuth,
  setClientInformation,
  writeAuth,
} from "../config/oauth.ts";
import {
  isReadOnlyScope,
  parseScopeList,
  readOnlyScopes,
  requestableScopes,
  unknownScopes,
} from "../config/scopes.ts";
import type { ServerEntry } from "../config/types.ts";

/**
 * Runs the OAuth authorization-code flow for one server and stores the grant.
 *
 * The redirect target is a loopback HTTP server started for the duration of the
 * flow. A fixed port is used rather than an ephemeral one because the port is
 * baked into the redirect_uri that gets registered with the provider, and a
 * registration made on one port is useless on the next run.
 */

export async function runLogin(opts: {
  server: string;
  cwd: string;
  port?: number;
  force?: boolean;
  /** Pre-registered client, for servers without RFC 7591 registration. */
  clientId?: string;
  clientSecret?: string;
  /** Exact scopes to request, overriding whatever the server advertises. */
  scopes?: string;
  /** Request only the scopes that do not grant mutation. */
  readOnly?: boolean;
  /**
   * Request everything the server advertises, discarding any narrowing a
   * previous grant carried. The escape hatch from a grant that was narrowed
   * past what the server actually needs.
   */
  allScopes?: boolean;
  /** Print the available scopes and exit without authorizing. */
  listScopes?: boolean;
}): Promise<{ ok: boolean; message: string }> {
  const resolved = await resolveConfig(opts.cwd);
  const entry = resolved.servers.find((s) => s.name === opts.server);
  if (!entry) {
    const names = resolved.servers.map((s) => s.name).join(", ");
    return { ok: false, message: `Unknown server "${opts.server}". Known: ${names}` };
  }
  if (entry.transport !== "http") {
    return { ok: false, message: `${entry.name} is a stdio server; OAuth applies to http servers only.` };
  }
  if (opts.listScopes) return await describeScopes(entry);
  // Read before --force wipes the file, so the replacement grant can inherit
  // the narrowing the old one was given.
  const previousScope = (await readAuth(entry.name)).requestedScope;
  if (opts.force) await clearAuth(entry.name);
  else if (await hasAuth(entry.name)) {
    // A scope request against an existing grant is a no-op without --force, and
    // saying only "already has a grant" reads as though the narrowing applied.
    const asked = opts.readOnly
      ? "--read-only"
      : opts.allScopes
        ? "--all-scopes"
        : opts.scopes
          ? "--scopes"
          : null;
    return {
      ok: true,
      message: asked
        ? `${entry.name} already has a stored grant, so ${asked} was not applied.\n` +
          `  Scopes are fixed when the grant is issued; re-run with --force to authorize again.` +
          (previousScope ? `\n  Current: ${previousScope.split(/\s+/).join(", ")}` : "")
        : `${entry.name} already has a stored grant. Re-run with --force to replace it.` +
          (previousScope ? `\n  Scopes: ${previousScope.split(/\s+/).join(", ")}` : ""),
    };
  }

  const port = opts.port ?? CALLBACK_PORT;
  if (opts.clientId) {
    await setClientInformation(entry.name, {
      client_id: opts.clientId,
      ...(opts.clientSecret ? { client_secret: opts.clientSecret } : {}),
    });
  }
  return await authorize(entry, port, {
    scopes: opts.scopes,
    readOnly: opts.readOnly,
    allScopes: opts.allScopes,
    // A re-login inherits the narrowing from the grant it replaces. Without
    // this, `login --force` after a `--read-only` login quietly hands back a
    // full-access token.
    previous: previousScope,
  });
}

/**
 * Shows what a server offers before committing to a browser flow. The two
 * metadata documents can disagree, so this reports the set the resource will
 * actually accept rather than everything the authorization server fronts.
 */
async function describeScopes(
  entry: Extract<ServerEntry, { transport: "http" }>,
): Promise<{ ok: boolean; message: string }> {
  const advertised = await advertisedScopes(entry.url);
  if (!advertised.length) {
    return {
      ok: true,
      message:
        `${entry.name} advertises no scopes, so there is nothing to choose — ` +
        `the grant is whatever the provider decides to issue.`,
    };
  }
  const ro = readOnlyScopes(advertised);
  const lines = advertised.map((s) => `  ${ro.includes(s) ? "read " : "write"}  ${s}`);
  return {
    ok: true,
    message:
      `${entry.name} scopes:\n${lines.join("\n")}\n\n` +
      (ro.length && ro.length < advertised.length
        ? `  autorouter login ${entry.name} --read-only        (${ro.length} of ${advertised.length})\n`
        : "") +
      `  autorouter login ${entry.name} --scopes "${(ro.length ? ro : advertised).slice(0, 2).join(",")}"`,
  };
}

/** What this resource accepts, per the precedence in requestableScopes(). */
async function advertisedScopes(url: string): Promise<string[]> {
  try {
    const info = await discoverOAuthServerInfo(url);
    return requestableScopes(
      info.resourceMetadata?.scopes_supported,
      info.authorizationServerMetadata?.scopes_supported,
    );
  } catch {
    return [];
  }
}

async function authorize(
  entry: Extract<ServerEntry, { transport: "http" }>,
  port: number,
  want: { scopes?: string; readOnly?: boolean; allScopes?: boolean; previous?: string },
): Promise<{ ok: boolean; message: string }> {
  // Captured after auth() generates it, and compared against what the browser
  // sends back.
  let pendingState: string | undefined;

  // The code has to be handed back from the HTTP callback to the auth() call,
  // so both sides share one promise rather than polling a variable.
  let resolveCode!: (code: string) => void;
  let rejectCode!: (err: Error) => void;
  const codePromise = new Promise<string>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    if (url.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    const { code, failure } = evaluateCallback(url.searchParams, pendingState);
    res.writeHead(failure ? 400 : 200, { "content-type": "text/html" });
    res.end(
      `<html><body style="font:16px system-ui;padding:3rem">` +
        (failure
          ? `<h2>Authorization failed</h2><pre>${escapeHtml(failure)}</pre>`
          : `<h2>Authorized</h2><p>You can close this tab and return to the terminal.</p>`) +
        `</body></html>`,
    );
    if (failure) rejectCode(new Error(failure));
    else resolveCode(code!);
  });

  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(port, "127.0.0.1", res);
  }).catch((err: NodeJS.ErrnoException) => {
    throw err.code === "EADDRINUSE"
      ? new Error(`Port ${port} is in use. Pass --port to pick another (it must stay the same across logins).`)
      : err;
  });

  // SEP-835 scope selection inside auth() only consults the *resource* metadata
  // and falls back to client metadata. Datadog publishes its one required scope
  // (mcp_all) on the authorization server rather than the resource, so without
  // this the authorize request goes out scopeless and the grant comes back
  // unusable. Discovering up front also surfaces a bad URL as a clear error
  // before a browser window opens.
  let advertised: string[] = [];
  let canRegister = true;
  try {
    const info = await discoverOAuthServerInfo(entry.url);
    // The resource document wins over the authorization server's when it says
    // anything at all — the server's list spans every API it fronts, and
    // Supabase rejects the authorize request outright when scopes outside the
    // MCP resource's own 13 are included. See requestableScopes().
    advertised = requestableScopes(
      info.resourceMetadata?.scopes_supported,
      info.authorizationServerMetadata?.scopes_supported,
    );
    canRegister = Boolean(info.authorizationServerMetadata?.registration_endpoint);
  } catch {
    // Discovery failures are not fatal here — auth() repeats the discovery and
    // will report the real problem with better context.
  }

  const chosen = chooseScopes(advertised, want);
  if ("error" in chosen) return { ok: false, message: `${entry.name}: ${chosen.error}` };
  const scope = chosen.scope;
  if (chosen.warn?.length) {
    console.log(
      `Note: ${chosen.warn.join(", ")} ${chosen.warn.length > 1 ? "are" : "is"} not in ` +
        `${entry.name}'s advertised scopes. Requesting anyway — the provider will ` +
        `reject the name if it does not exist.`,
    );
  }

  // Not every provider implements RFC 7591 — GitHub's MCP, for one, expects an
  // OAuth app you created yourself. Say so before opening a browser onto a
  // request that cannot succeed.
  if (!canRegister && !(await readAuth(entry.name)).clientInformation) {
    return {
      ok: false,
      message:
        `${entry.name} does not support dynamic client registration, so it needs an OAuth ` +
        `app you register yourself.\n` +
        `  Redirect URI to enter: ${`http://localhost:${port}/callback`}\n` +
        `  Then: autorouter login ${entry.name} --client-id <id> [--client-secret <secret>]`,
    };
  }

  const provider = new FileTokenStore(entry.name, port, (url) => {
    console.log(`\nOpening your browser to authorize ${entry.name}:\n  ${url}\n`);
    openBrowser(url.toString());
  });

  try {
    const first = await auth(provider, { serverUrl: entry.url, scope });
    if (first === "AUTHORIZED") {
      return { ok: true, message: `${entry.name}: already authorized (existing grant is still valid).` };
    }

    // auth() returned REDIRECT: the browser is open, wait for the callback.
    pendingState = (await readAuth(entry.name)).state;
    const code = await withTimeout(codePromise, 5 * 60_000, "waiting for the browser callback");
    const result = await auth(provider, { serverUrl: entry.url, authorizationCode: code, scope });
    if (result !== "AUTHORIZED") {
      return { ok: false, message: `${entry.name}: token exchange did not complete (${result}).` };
    }
    if (scope) await writeAuth(entry.name, { requestedScope: scope });
    const stored = await readAuth(entry.name);
    // Report what the provider actually granted, not what was asked for. They
    // differ more often than not — a provider may drop a scope it does not
    // recognise and issue the rest without saying so.
    const granted = stored.tokens?.scope ?? scope;
    return { ok: true, message: `${entry.name}: authorized.${granted ? `\n  ${summarizeScopes(granted)}` : ""}` };
  } catch (err) {
    return { ok: false, message: `${entry.name}: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    server.close();
  }
}

/**
 * Decides whether a redirect that landed on the loopback listener is ours.
 *
 * RFC 6749 §10.12: the listener is reachable by any page the user has open
 * during the flow, so a code arriving without the state we issued is not ours
 * and must not be exchanged — doing so would bind the router to whichever
 * account the attacker authorized.
 */
export function evaluateCallback(
  params: URLSearchParams,
  expectedState: string | undefined,
): { code?: string; failure: string | null } {
  const returned = params.get("state");
  if (expectedState && returned !== expectedState) {
    return { failure: "state mismatch — this callback did not come from the login you started" };
  }
  const code = params.get("code");
  if (code) return { code, failure: null };
  const error = params.get("error");
  const description = params.get("error_description");
  return {
    failure: description ? `${error ?? "error"}: ${description}` : (error ?? "no code returned"),
  };
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    // Detached and ignored: the browser must outlive this command, and its
    // stdio must not interleave with ours.
    spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // Headless box, or no handler registered. The URL was already printed.
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new Error(`timed out ${label}`)), ms);
    }),
  ]);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/**
 * Resolves what to put in the authorize request's `scope` parameter.
 *
 * Explicit --scopes wins over --read-only wins over the scope a previous grant
 * was narrowed to wins over everything advertised. Returning undefined is
 * meaningful: it lets the SDK apply its own SEP-835 selection, which is right
 * when a provider advertises nothing.
 */
export function chooseScopes(
  advertised: string[],
  want: { scopes?: string; readOnly?: boolean; allScopes?: boolean; previous?: string },
): { scope?: string; warn?: string[] } | { error: string } {
  // --scopes stays the exact lever and still outranks both of these. But
  // --read-only and --all-scopes are opposites with no defensible precedence,
  // and quietly picking one would hand back a grant of the wrong breadth —
  // the property least likely to be noticed after the fact.
  if (want.readOnly && want.allScopes && !want.scopes) {
    return { error: "--read-only and --all-scopes ask for opposite grants; pick one" };
  }

  if (want.scopes) {
    const requested = parseScopeList(want.scopes);
    if (!requested.length) return { error: "--scopes was empty" };
    // Advertised lists are routinely incomplete — Datadog publishes only
    // `mcp_all` yet issues `mcp_read` and `mcp_write` as distinct grants — so
    // an unlisted name is a warning, not a rejection. The user typed it; the
    // provider is the one that gets to refuse it.
    const unknown = unknownScopes(requested, advertised);
    return { scope: requested.join(" "), ...(unknown.length ? { warn: unknown } : {}) };
  }

  if (want.allScopes) {
    if (!advertised.length) {
      return { error: "--all-scopes needs the server to advertise its scopes, and this one advertises none" };
    }
    // Deliberately ahead of `previous`: this flag exists to undo a narrowing,
    // so inheriting the old one would defeat the only thing it does.
    return { scope: advertised.join(" ") };
  }

  if (want.readOnly) {
    if (!advertised.length) {
      return { error: "--read-only needs the server to advertise its scopes, and this one advertises none" };
    }
    const ro = readOnlyScopes(advertised);
    if (!ro.length) {
      // Datadog is the live example: one scope, mcp_all, and no read-only
      // subset exists. Silently requesting nothing would hand back a full
      // grant while looking like it had been restricted.
      return {
        error:
          `no read-only scopes are offered (available: ${advertised.join(", ")}).\n` +
          `  Authorize with full access, or pick explicitly with --scopes.`,
      };
    }
    return { scope: ro.join(" ") };
  }

  if (want.previous) return { scope: want.previous };
  return { scope: advertised.length ? advertised.join(" ") : undefined };
}

/**
 * A one-line account of what a grant covers.
 *
 * Some providers expand a single requested scope into a very long granted list
 * — Datadog's `mcp_all` comes back as ~140 names — so printing them all buries
 * the one fact that matters, which is whether the token can write.
 */
export function summarizeScopes(scope: string, limit = 6): string {
  const all = scope.split(/\s+/).filter(Boolean);
  if (!all.length) return "scope: (none reported)";
  const writes = all.filter((s) => !isReadOnlyScope(s));
  if (all.length <= limit) {
    return `scope: ${all.join(", ")}${writes.length ? "" : "  (read-only)"}`;
  }
  return (
    `scope: ${all.length} granted, ${writes.length} of them write ` +
    `(${writes.slice(0, 3).join(", ") || "none"}${writes.length > 3 ? ", …" : ""})`
  );
}
