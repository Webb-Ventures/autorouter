import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { ServerEntry } from "../../config/types.ts";
import { backgroundAuth } from "../../config/oauth.ts";
import type { Capability } from "../types.ts";
import { estimateTokens } from "../types.ts";

const CLIENT_INFO = { name: "autorouter", version: "0.1.0" };
const DEFAULT_TIMEOUT_MS = 30_000;

export async function connect(entry: ServerEntry, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Client> {
  const client = new Client(CLIENT_INFO, { capabilities: {} });
  const transport =
    entry.transport === "http" ? httpTransport(entry) : stdioTransport(entry);

  const timeout = entry.transport === "stdio" && entry.startupTimeoutSec
    ? entry.startupTimeoutSec * 1000
    : timeoutMs;

  await withTimeout(client.connect(transport), timeout, `connect to ${entry.name}`);
  return client;
}

function stdioTransport(entry: Extract<ServerEntry, { transport: "stdio" }>) {
  return new StdioClientTransport({
    command: entry.command,
    args: entry.args,
    cwd: entry.cwd,
    // Inherit the parent env so PATH-dependent commands (uvx, npx) resolve,
    // which is the single most common cause of stdio servers failing to start.
    env: { ...(process.env as Record<string, string>), ...(entry.env ?? {}) },
    stderr: "pipe",
  });
}

function httpTransport(entry: Extract<ServerEntry, { transport: "http" }>) {
  const url = new URL(entry.url);
  // Several of the heaviest servers (Datadog, Supabase, Linear) carry no
  // credentials in their config at all — the header values expand to empty and
  // the real grant is an OAuth token the harness holds privately. The router
  // holds its own grant instead, which also makes it work under Codex and
  // Cursor, where there is no harness token to fall back on.
  const init = {
    ...(entry.headers ? { requestInit: { headers: entry.headers } } : {}),
    authProvider: backgroundAuth(entry.name),
  };
  return /\/sse\/?$/.test(url.pathname)
    ? new SSEClientTransport(url, init)
    : new StreamableHTTPClientTransport(url, init);
}

export async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${label}`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Enumerates everything a server offers. Each list endpoint is paginated via
 * nextCursor — Claude Code itself only ever requests the first page, which is
 * why gateways with >30 tools appear truncated there. The router follows the
 * whole chain so its catalog is complete.
 */
export async function enumerateServer(
  entry: ServerEntry,
  client: Client,
): Promise<Capability[]> {
  const out: Capability[] = [];
  const caps = client.getServerCapabilities() ?? {};

  if (caps.tools) {
    for (const tool of await pageThrough((cursor) => client.listTools({ cursor }), "tools")) {
      const t = tool as any;
      out.push({
        id: `mcp:${entry.name}/${t.name}`,
        kind: "tool",
        name: t.name,
        server: entry.name,
        title: t.title ?? t.annotations?.title,
        description: t.description ?? "",
        keywords: [entry.name, ...splitIdentifier(t.name), ...schemaKeywords(t.inputSchema)],
        inputSchema: t.inputSchema,
        approxTokens: estimateTokens(t.name, t.description, t.inputSchema),
      });
    }
  }

  if (caps.prompts) {
    for (const prompt of await pageThrough((cursor) => client.listPrompts({ cursor }), "prompts")) {
      const p = prompt as any;
      out.push({
        id: `prompt:${entry.name}/${p.name}`,
        kind: "prompt",
        name: p.name,
        server: entry.name,
        title: p.title,
        description: p.description ?? "",
        keywords: [entry.name, ...splitIdentifier(p.name)],
        inputSchema: p.arguments ? { arguments: p.arguments } : undefined,
        approxTokens: estimateTokens(p.name, p.description),
      });
    }
  }

  if (caps.resources) {
    for (const res of await pageThrough((cursor) => client.listResources({ cursor }), "resources")) {
      const r = res as any;
      out.push({
        id: `resource:${entry.name}/${r.name ?? r.uri}`,
        kind: "resource",
        name: r.name ?? r.uri,
        server: entry.name,
        description: r.description ?? `Resource ${r.uri}`,
        keywords: [entry.name, ...splitIdentifier(r.name ?? "")],
        uri: r.uri,
        approxTokens: estimateTokens(r.name, r.description, r.uri),
      });
    }
  }

  return out;
}

async function pageThrough<K extends "tools" | "prompts" | "resources">(
  fetchPage: (cursor?: string) => Promise<any>,
  key: K,
): Promise<any[]> {
  const items: any[] = [];
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  for (let i = 0; i < 50; i++) {
    let page: any;
    try {
      page = await fetchPage(cursor);
    } catch {
      break; // Server declared the capability but does not implement the list.
    }
    items.push(...(page?.[key] ?? []));
    cursor = page?.nextCursor;
    if (!cursor || seenCursors.has(cursor)) break;
    seenCursors.add(cursor);
  }
  return items;
}

/** "execute_sql" -> ["execute","sql"]; "listDeployments" -> ["list","deployments"] */
export function splitIdentifier(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((s) => s.toLowerCase());
}

/** Property names carry real signal ("dashboard_id" implies dashboards). */
function schemaKeywords(schema: any): string[] {
  const props = schema?.properties;
  if (!props || typeof props !== "object") return [];
  return Object.keys(props).flatMap(splitIdentifier).slice(0, 40);
}
