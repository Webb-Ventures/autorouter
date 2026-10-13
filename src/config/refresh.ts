import { open, stat, unlink } from "node:fs/promises";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { authPath, readAuth, writeAuth } from "./oauth.ts";

const LOCK_WAIT_MS = 20_000;
/** A holder that has not finished within this long has crashed. */
const LOCK_STALE_MS = 30_000;

/**
 * Serializes refresh-token exchanges across every router sharing a grant.
 *
 * One router runs per harness session, all reading the same token file. Stripe,
 * like most providers following OAuth 2.1, rotates the refresh token on every
 * exchange, so when two routers see the same expired access token the first
 * refresh succeeds and the second presents a token that no longer exists. The
 * provider answers `invalid_grant`, the SDK reacts by deleting the stored
 * tokens, and every router is logged out — roughly once a day, whenever two
 * sessions happen to wake together.
 *
 * Wrapping the transport's fetch is the only seam the SDK leaves around the
 * exchange. Under the lock, a router whose refresh token has already been spent
 * by another is handed the rotated tokens instead of a request that would
 * revoke them, and a successful exchange is written to disk before the lock is
 * released so the next waiter sees it.
 */
export function serializeRefresh(server: string, fetchFn: FetchLike): FetchLike {
  return async (url, init) => {
    const presented = refreshTokenIn(init?.body);
    if (!presented) return fetchFn(url, init);

    const release = await acquireLock(`${authPath(server)}.lock`);
    try {
      const stored = (await readAuth(server)).tokens;
      if (stored?.refresh_token && stored.refresh_token !== presented) {
        return new Response(JSON.stringify(stored), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const res = await fetchFn(url, init);
      if (res.ok) {
        try {
          const tokens = (await res.clone().json()) as OAuthTokens;
          // A provider that does not rotate omits refresh_token; keep ours.
          if (tokens?.access_token) await writeAuth(server, { tokens: { refresh_token: presented, ...tokens } });
        } catch {
          // Unparseable here means unparseable for the SDK too; it reports it.
        }
      }
      return res;
    } finally {
      await release();
    }
  };
}

function refreshTokenIn(body: unknown): string | null {
  if (!(body instanceof URLSearchParams) && typeof body !== "string") return null;
  const params = new URLSearchParams(body);
  return params.get("grant_type") === "refresh_token" ? params.get("refresh_token") : null;
}

/**
 * An O_EXCL lock file. Waiting out a live holder is bounded: past the deadline
 * the exchange proceeds unlocked, which is no worse than before the lock.
 */
async function acquireLock(path: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(String(process.pid));
      await handle.close();
      return () => unlink(path).catch(() => {});
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") return async () => {};
    }
    try {
      if (Date.now() - (await stat(path)).mtimeMs > LOCK_STALE_MS) {
        await unlink(path).catch(() => {});
        continue;
      }
    } catch {
      continue; // released between open and stat
    }
    if (Date.now() > deadline) return async () => {};
    await new Promise((r) => setTimeout(r, 100));
  }
}
