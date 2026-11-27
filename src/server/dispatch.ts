import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ServerEntry } from "../config/types.ts";
import { connect, withTimeout } from "../catalog/providers/mcp.ts";
import { authHint } from "../config/oauth.ts";

/**
 * Replaces an error with its actionable form, keeping the original when
 * authHint() had nothing to add — an unrelated failure should not be reworded
 * into something that looks like an auth problem.
 */
function hinted(server: string, err: unknown, entry?: ServerEntry): Error {
  const raw = err instanceof Error ? err.message : String(err);
  const hint = authHint(server, err, entry?.transport === "http" ? entry.oauth : undefined);
  return hint === raw ? (err instanceof Error ? err : new Error(raw)) : new Error(hint);
}

/** Whether two entries launch or reach the same thing (origin is bookkeeping). */
function sameTarget(a: ServerEntry, b: ServerEntry): boolean {
  return JSON.stringify({ ...a, origin: "" }) === JSON.stringify({ ...b, origin: "" });
}

/**
 * Lazily-opened, reused connections to downstream servers. Nothing is spawned
 * until a capability from that server is actually called, which is what makes
 * the router cheap: 20 configured servers cost zero processes at rest.
 */
export class ConnectionPool {
  private clients = new Map<string, Promise<Client>>();
  private byName = new Map<string, ServerEntry>();

  constructor(entries: ServerEntry[]) {
    for (const e of entries) this.byName.set(e.name, e);
  }

  entry(name: string): ServerEntry | undefined {
    return this.byName.get(name);
  }

  names(): string[] {
    return [...this.byName.keys()];
  }

  /**
   * Replaces the known servers, dropping the connections that no longer match.
   *
   * Called on refresh, because the set of servers is not fixed for the life of
   * the process — one can be added while it runs. An entry edited in place (a
   * new URL, a new env block) or removed has its client closed, since a pooled
   * connection to the old target would keep answering as if nothing changed.
   * Unchanged entries keep theirs: a refresh runs whenever any watched config
   * file changes, and closing every client each time failed whatever call
   * happened to be in flight.
   */
  setEntries(entries: ServerEntry[]): void {
    const next = new Map(entries.map((e) => [e.name, e]));
    for (const [name, client] of this.clients) {
      const before = this.byName.get(name);
      const after = next.get(name);
      if (before && after && sameTarget(before, after)) continue;
      this.clients.delete(name);
      void client.then((c) => c.close()).catch(() => {});
    }
    this.byName = next;
  }

  async get(serverName: string): Promise<Client> {
    const existing = this.clients.get(serverName);
    if (existing) {
      try {
        return await existing;
      } catch {
        // Only evict the promise that failed. A concurrent caller may already
        // have replaced it with a fresh connection, and deleting that one
        // orphans a live client nobody will close.
        if (this.clients.get(serverName) === existing) this.clients.delete(serverName);
        else return this.get(serverName);
      }
    }
    const entry = this.byName.get(serverName);
    if (!entry) throw new Error(`unknown server: ${serverName}`);

    const pending = connect(entry).then((client) => {
      // Drop the cached promise when the process dies so the next call retries.
      client.onclose = () => {
        if (this.clients.get(serverName) === pending) this.clients.delete(serverName);
      };
      return client;
    });
    this.clients.set(serverName, pending);
    try {
      return await pending;
    } catch (err) {
      if (this.clients.get(serverName) === pending) this.clients.delete(serverName);
      // A grant can expire between a reindex and a call, so the actionable
      // message has to exist on this path too, not just at index time.
      throw hinted(serverName, err, entry);
    }
  }

  /**
   * Runs a request against a pooled client, rewriting auth failures.
   *
   * Connecting is not the only place a grant can turn out to be wrong. A
   * too-narrow one connects and lists perfectly well and only fails on the one
   * capability that needed the scope it lacks, so the translation has to sit on
   * the request itself rather than on the handshake.
   */
  private async request<T>(serverName: string, run: (client: Client) => Promise<T>): Promise<T> {
    const client = await this.get(serverName);
    try {
      return await run(client);
    } catch (err) {
      throw hinted(serverName, err, this.byName.get(serverName));
    }
  }

  async callTool(serverName: string, name: string, args: unknown, timeoutMs = 120_000) {
    return this.request(serverName, (client) =>
      withTimeout(
        client.callTool({ name, arguments: (args ?? {}) as Record<string, unknown> }, undefined, {
          timeout: timeoutMs,
        }),
        timeoutMs + 5000,
        `${serverName}/${name}`,
      ),
    );
  }

  async getPrompt(serverName: string, name: string, args: Record<string, string> = {}) {
    return this.request(serverName, (client) => client.getPrompt({ name, arguments: args }));
  }

  async readResource(serverName: string, uri: string) {
    return this.request(serverName, (client) => client.readResource({ uri }));
  }

  /**
   * Drops every pooled connection without waiting for them to close.
   *
   * Called after a reindex: a client connected under a grant that has since
   * been replaced keeps failing, and there is no way to re-authenticate one in
   * place. The next call reconnects with whatever is on disk now.
   */
  reset(): void {
    const clients = [...this.clients.values()];
    this.clients.clear();
    for (const p of clients) void p.then((c) => c.close()).catch(() => {});
  }

  async closeAll(): Promise<void> {
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(
      clients.map(async (p) => {
        try {
          await (await p).close();
        } catch {}
      }),
    );
  }
}
