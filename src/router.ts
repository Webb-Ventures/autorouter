import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { resolveConfig, type ResolvedConfig } from "./config/resolve.ts";
import { buildCatalog, getCatalog, isStale, saveCatalog } from "./catalog/build.ts";
import type { Capability, Catalog, CapabilityKind } from "./catalog/types.ts";
import { HybridIndex, type Scored } from "./index/search.ts";
import { selectCapabilities } from "./selector/index.ts";
import type { SelectorResult } from "./selector/types.ts";
import { ConnectionPool } from "./server/dispatch.ts";
import { Guard } from "./server/guard.ts";
import { readText } from "./util/fs.ts";

export type RouteHit = {
  capability: Capability;
  reason: string;
  score: number;
  confidence?: number;
};

export type CallOutcome = {
  capability: Capability;
  /** "server/tool" — echoed into results so the transcript stays auditable. */
  source: string;
  content: any[];
  isError: boolean;
  structuredContent?: unknown;
};

/** Distinguishes a router-level refusal from a downstream transport failure. */
export class CapabilityError extends Error {
  constructor(message: string, readonly needsConfirmation = false) {
    super(message);
    this.name = "CapabilityError";
  }
}

export type RouteResult = {
  hits: RouteHit[];
  backend: string;
  model?: string;
  note?: string;
  /** How many candidates the index produced before the selector narrowed them. */
  considered: number;
};

/**
 * Owns the whole pipeline: catalog -> hybrid index -> selector -> dispatch.
 * Shared by the MCP server and the CLI so both behave identically.
 */
export class Router {
  /**
   * Mutable, because `serve` is a long-lived process. These start as the
   * catalog built at startup and are replaced wholesale by refresh().
   */
  catalog: Catalog;
  index: HybridIndex;
  /**
   * Also mutable, and for a sharper reason than the catalog: a server can be
   * *added* while this process is running — by `autorouter add`, by adoption
   * moving one out of a harness, or by the add_server tool. Resolving the config
   * once at startup would leave the running router indexing and dispatching to
   * the set of servers that existed when it booted, so a newly added server
   * would not appear until the host was restarted.
   */
  resolved: ResolvedConfig;
  guard: Guard;
  /** In-flight refresh, so concurrent searches share one rebuild. */
  private refreshing: Promise<void> | null = null;

  private constructor(
    resolved: ResolvedConfig,
    catalog: Catalog,
    index: HybridIndex,
    readonly pool: ConnectionPool,
    guard: Guard,
  ) {
    this.resolved = resolved;
    this.guard = guard;
    this.catalog = catalog;
    this.index = index;
  }

  static async create(opts: { cwd?: string; force?: boolean } = {}): Promise<Router> {
    const resolved = await resolveConfig(opts.cwd);
    const catalog = await getCatalog(resolved, { force: opts.force });
    const index = new HybridIndex(catalog.capabilities, resolved.config);
    await index.warmEmbeddings();
    return new Router(
      resolved,
      catalog,
      index,
      new ConnectionPool(resolved.servers),
      new Guard(resolved.config),
    );
  }

  /**
   * Rebuilds the catalog when it has gone stale, and swaps the live index.
   *
   * Without this, a `serve` process indexes once at startup and serves that
   * snapshot for its entire life. That is wrong in the one case that matters
   * most: a server which was unauthorized at startup contributes *no*
   * capabilities, so `autorouter login` followed by `reindex` fixes the file on
   * disk while every running host keeps searching a catalog the server is
   * missing from — and the model concludes the tool does not exist.
   *
   * The rebuild runs in the background and the caller is not blocked; a search
   * issued during it still answers from the current index.
   */
  async refresh(opts: { force?: boolean } = {}): Promise<void> {
    if (this.refreshing) return this.refreshing;
    if (!opts.force && !(await isStale(this.catalog, this.resolved.config.cacheTtlSec))) return;

    this.refreshing = (async () => {
      try {
        // Re-read the config, not just the catalog. The server list is an input
        // to the build, and the thing that most often changed since the last one
        // is precisely that list.
        const resolved = await resolveConfig(this.resolved.cwd);
        const catalog = await buildCatalog(resolved);
        await saveCatalog(catalog);
        const index = new HybridIndex(catalog.capabilities, resolved.config);
        await index.warmEmbeddings();
        // Swap only after the new index is fully built, so no search ever sees
        // a half-populated one.
        this.resolved = resolved;
        this.guard = new Guard(resolved.config);
        this.catalog = catalog;
        this.index = index;
        // Servers that failed at the previous build may now be reachable, and
        // a pooled connection created against the old grant would keep failing.
        // The entry list is replaced too, or a server added since startup is
        // indexed and then fails to dispatch.
        this.pool.setEntries(resolved.servers);
      } catch {
        // Keep serving what we have. A transient network failure during a
        // background rebuild must not take the router down.
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  /** True when the on-disk catalog has moved on from the one in memory. */
  async isStale(): Promise<boolean> {
    return await isStale(this.catalog, this.resolved.config.cacheTtlSec);
  }

  /** One-line inventory used in the router tool's own description. */
  summary(): string {
    const counts = new Map<string, number>();
    const servers = new Set<string>();
    for (const cap of this.catalog.capabilities) {
      counts.set(cap.kind, (counts.get(cap.kind) ?? 0) + 1);
      if (cap.server) servers.add(cap.server);
    }
    const parts = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([kind, n]) => `${n} ${kind}${n === 1 ? "" : "s"}`);
    const domains = [...servers].slice(0, 12).join(", ");
    return `${servers.size} providers · ${parts.join(" · ")}${domains ? ` · ${domains}` : ""}`;
  }

  /** Total tokens the catalog would cost if every capability were exposed. */
  fullSurfaceTokens(): number {
    return this.catalog.capabilities.reduce((sum, c) => sum + c.approxTokens, 0);
  }

  async route(
    query: string,
    opts: {
      kind?: CapabilityKind | CapabilityKind[];
      server?: string;
      limit?: number;
      harness?: string;
      server_handle?: Server;
    } = {},
  ): Promise<RouteResult> {
    const cfg = this.resolved.config;
    const candidates = await this.index.search(query, {
      kind: opts.kind,
      server: opts.server,
      limit: cfg.selector.candidates ?? 30,
    });

    const selection: SelectorResult = await selectCapabilities(query, candidates, {
      config: { ...cfg.selector, maxResults: opts.limit ?? cfg.selector.maxResults },
      harness: opts.harness ?? "cli",
      server: opts.server_handle,
    });

    const scoreById = new Map(candidates.map((c) => [c.capability.id, c.score]));
    const hits: RouteHit[] = [];
    for (const sel of selection.selections) {
      const cap = this.index.get(sel.id);
      if (!cap) continue;
      hits.push({
        capability: cap,
        reason: sel.reason,
        score: scoreById.get(sel.id) ?? 0,
        confidence: sel.confidence,
      });
    }

    return {
      hits,
      backend: selection.backend,
      model: selection.model,
      note: selection.note,
      considered: candidates.length,
    };
  }

  /** Index-only search, no selector. Used by `autorouter search --raw`. */
  async rawSearch(
    query: string,
    opts: { kind?: CapabilityKind | CapabilityKind[]; server?: string; limit?: number } = {},
  ): Promise<Scored[]> {
    return this.index.search(query, { ...opts, limit: opts.limit ?? 20 });
  }

  get(id: string): Capability | undefined {
    return this.index.get(id);
  }

  /** Full detail for one capability: schema for tools, body text for skills. */
  async describe(id: string): Promise<{ capability: Capability; body?: string } | null> {
    const capability = this.index.get(id);
    if (!capability) return null;
    let body: string | undefined;
    if (capability.bodyPath) {
      body = (await readText(capability.bodyPath)) ?? undefined;
    }
    return { capability, body };
  }

  /**
   * Resolves a capability id to an actual invocation. Lives here rather than in
   * the MCP server so the CLI, the server, and tests all take the same path —
   * including the guard check, which must not be skippable by a caller.
   */
  async call(
    id: string,
    args: unknown = {},
    opts: { confirmed?: boolean } = {},
  ): Promise<CallOutcome> {
    const capability = this.index.get(id);
    if (!capability) throw new CapabilityError(`No capability with id "${id}".`);

    if (this.guard.requiresConfirmation(capability) && !opts.confirmed) {
      throw new CapabilityError(this.guard.confirmationMessage(capability, args), true);
    }

    // Skills, commands and agents are instructions, not RPCs: returning the
    // body *is* the invocation.
    if (capability.kind === "skill" || capability.kind === "command" || capability.kind === "agent") {
      const found = await this.describe(id);
      return {
        capability,
        source: capability.id,
        content: [
          {
            type: "text",
            text: found?.body
              ? `${capability.id} is a ${capability.kind}; follow these instructions directly.\n\n${found.body.trim()}`
              : `${capability.id} has no instruction body.`,
          },
        ],
        isError: false,
      };
    }

    const parsed = parseCapabilityId(capability.id);
    if (!parsed.server) throw new CapabilityError(`${capability.id} has no owning server.`);
    const source = `${parsed.server}/${capability.name}`;

    if (capability.kind === "resource" && capability.uri) {
      const res = await this.pool.readResource(parsed.server, capability.uri);
      return {
        capability,
        source,
        content: [
          {
            type: "text",
            text: res.contents
              .map((c: any) => c.text ?? `[${c.mimeType ?? "binary"} at ${c.uri}]`)
              .join("\n\n"),
          },
        ],
        isError: false,
      };
    }

    if (capability.kind === "prompt") {
      const res = await this.pool.getPrompt(
        parsed.server,
        capability.name,
        (args ?? {}) as Record<string, string>,
      );
      return {
        capability,
        source,
        content: [
          {
            type: "text",
            text: res.messages
              .map((m: any) => `${m.role}: ${m.content?.text ?? JSON.stringify(m.content)}`)
              .join("\n\n"),
          },
        ],
        isError: false,
      };
    }

    // A downstream tool that rejects its arguments throws a protocol error
    // rather than returning isError. That is a normal tool outcome, not a router
    // failure, so it must reach the model as content it can act on — a stack
    // trace here would just be noise the caller cannot use.
    let res: any;
    try {
      res = await this.pool.callTool(parsed.server, capability.name, args);
    } catch (err) {
      return {
        capability,
        source,
        content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
    return {
      capability,
      source,
      content: res.content ?? [],
      isError: res.isError === true,
      structuredContent: res.structuredContent,
    };
  }

  async close(): Promise<void> {
    await this.pool.closeAll();
  }
}

/** "mcp:supabase/execute_sql" -> { kind, server, name } */
export function parseCapabilityId(id: string): { prefix: string; server?: string; name: string } {
  const colon = id.indexOf(":");
  if (colon === -1) return { prefix: "", name: id };
  const prefix = id.slice(0, colon);
  const rest = id.slice(colon + 1);
  const slash = rest.indexOf("/");
  if (slash === -1) return { prefix, name: rest };
  return { prefix, server: rest.slice(0, slash), name: rest.slice(slash + 1) };
}
