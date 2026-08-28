import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ServerEntry } from "../config/types.ts";
import { connect, withTimeout } from "../catalog/providers/mcp.ts";
import { authHint } from "../config/oauth.ts";

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

  async get(serverName: string): Promise<Client> {
    const existing = this.clients.get(serverName);
    if (existing) {
      try {
        return await existing;
      } catch {
        this.clients.delete(serverName);
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
      this.clients.delete(serverName);
      // A grant can expire between a reindex and a call, so the actionable
      // message has to exist on this path too, not just at index time.
      const hint = authHint(serverName, err);
      throw hint === (err instanceof Error ? err.message : String(err)) ? err : new Error(hint);
    }
  }

  async callTool(serverName: string, name: string, args: unknown, timeoutMs = 120_000) {
    const client = await this.get(serverName);
    return withTimeout(
      client.callTool({ name, arguments: (args ?? {}) as Record<string, unknown> }, undefined, {
        timeout: timeoutMs,
      }),
      timeoutMs + 5000,
      `${serverName}/${name}`,
    );
  }

  async getPrompt(serverName: string, name: string, args: Record<string, string> = {}) {
    const client = await this.get(serverName);
    return client.getPrompt({ name, arguments: args });
  }

  async readResource(serverName: string, uri: string) {
    const client = await this.get(serverName);
    return client.readResource({ uri });
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
          (await p).close();
        } catch {}
      }),
    );
  }
}
