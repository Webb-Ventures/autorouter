import net from "node:net";

/** Node's own default, and the value we are raising away from. */
const NODE_DEFAULT_ATTEMPT_TIMEOUT_MS = 250;

/** Long enough for a cross-continent TCP handshake, short enough to still fail fast. */
const DEFAULT_ATTEMPT_TIMEOUT_MS = 5_000;

/**
 * Widens the per-address timeout Node applies while racing a host's A and AAAA
 * records, because the default is too tight for a genuinely distant server.
 *
 * Node 20+ dials every address a hostname resolves to under Happy Eyeballs
 * (RFC 8305), giving each attempt `autoSelectFamilyAttemptTimeout` — 250ms by
 * default — before abandoning it and moving to the next. Exhausting the list
 * throws an AggregateError that `fetch` reports only as "fetch failed", with
 * the per-address causes buried a level down.
 *
 * 250ms is under the TCP handshake time to anything far enough away. Datadog's
 * `mcp.datadoghq.com` terminates in us-east-1 and takes ~250ms to connect from
 * the US west coast — right on the boundary, so it fails or succeeds by jitter.
 * Its AAAA records make that worse rather than better: a host with no IPv6
 * route fails them instantly with EHOSTUNREACH, so the interleaved v6 attempts
 * burn list positions without ever buying a slow v4 attempt more time. The
 * result is a server that curl reaches every time and `fetch` reaches almost
 * never, which is exactly what this looks like from the outside.
 *
 * Raising the per-attempt budget keeps the racing behaviour — a host with
 * working IPv6 still prefers it, and an unreachable address still fails on its
 * own error rather than on the timeout — while letting a slow-but-fine address
 * finish. This is a no-op on Bun, which does not implement the knob.
 */
export function tuneConnectionRacing(): void {
  const override = Number(process.env.AUTOROUTER_CONNECT_ATTEMPT_TIMEOUT_MS);
  const target = Number.isFinite(override) && override > 0 ? override : DEFAULT_ATTEMPT_TIMEOUT_MS;

  const get = net.getDefaultAutoSelectFamilyAttemptTimeout;
  const set = net.setDefaultAutoSelectFamilyAttemptTimeout;
  if (typeof set !== "function") return;

  // Only move the untouched default. A value already raised by a --network-*
  // flag or an embedding process is a deliberate choice and stays put.
  const current = typeof get === "function" ? get() : NODE_DEFAULT_ATTEMPT_TIMEOUT_MS;
  if (current > NODE_DEFAULT_ATTEMPT_TIMEOUT_MS && !override) return;

  try {
    set(target);
  } catch {
    // Node rejects out-of-range values; the default is survivable.
  }
}

type ErrnoLike = { code?: string; address?: string; port?: number; errors?: unknown[] };

function errno(err: unknown): ErrnoLike | null {
  return err && typeof err === "object" ? (err as ErrnoLike) : null;
}

/**
 * Pulls the connect-level failure out from under a `fetch` rejection.
 *
 * Node reports every transport failure as the bare string "fetch failed" and
 * hangs the real reason off `.cause` — which for a Happy Eyeballs race is an
 * AggregateError whose own message is empty and whose `.errors` hold one errno
 * per address tried. Nothing legible survives to the surface, so a DNS failure,
 * a refused port, an expired certificate and an unroutable address all read
 * identically. This reassembles enough to tell them apart.
 *
 * Returns null when the error is not a transport failure, so callers can leave
 * an ordinary protocol error alone.
 */
export function describeNetworkError(err: unknown): string | null {
  const message = err instanceof Error ? err.message : String(err);
  if (!/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|ECONNRESET|certificate/i.test(message)) {
    return null;
  }

  // Walk to the deepest cause, collecting the aggregate's per-address errnos.
  const attempts: ErrnoLike[] = [];
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 8; depth++) {
    const e = errno(cur);
    if (!e) break;
    if (Array.isArray(e.errors)) attempts.push(...e.errors.map(errno).filter((x): x is ErrnoLike => !!x));
    else if (e.code) attempts.push(e);
    cur = (cur as { cause?: unknown }).cause;
  }

  const codes = [...new Set(attempts.map((a) => a.code).filter(Boolean))] as string[];
  if (!codes.length) return null;

  const where = attempts
    .filter((a) => a.address)
    .map((a) => `${a.address}${a.code ? ` (${a.code})` : ""}`)
    .slice(0, 6);
  const detail = where.length ? `\n  Tried: ${where.join(", ")}` : "";

  if (codes.includes("ENOTFOUND")) return `host does not resolve.${detail}`;
  if (codes.includes("ECONNREFUSED")) return `connection refused — nothing is listening there.${detail}`;
  if (codes.includes("ETIMEDOUT")) {
    return (
      `could not connect before the per-address timeout.${detail}\n` +
      `  If curl reaches this host fine, the handshake is just slower than the timeout;\n` +
      `  raise it with AUTOROUTER_CONNECT_ATTEMPT_TIMEOUT_MS (currently ` +
      `${net.getDefaultAutoSelectFamilyAttemptTimeout?.() ?? "?"}ms).`
    );
  }
  if (codes.includes("EHOSTUNREACH")) return `no route to host — often an IPv6 address on an IPv4-only network.${detail}`;
  return `${message} (${codes.join(", ")})${detail}`;
}
