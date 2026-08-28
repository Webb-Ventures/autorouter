import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type GetPromptResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { Router, parseCapabilityId } from "../router.ts";
import { profileClient, type ClientProfile } from "./clientProfile.ts";
import { renderCapability, renderRouteResult } from "./render.ts";
import type { Capability, CapabilityKind } from "../catalog/types.ts";
import {
  FIND_PROMPT,
  capabilityForPrompt,
  promptList,
  promptMessages,
} from "./prompts.ts";
import { clamp, compactSchema, tokensOf } from "../util/compact.ts";

const NAME = "autorouter";
const VERSION = "0.1.0";

const INSTRUCTIONS = `This server is a capability router. Instead of loading every
available tool into your context, it exposes a search interface over all of them.

Workflow:
1. find_capabilities({ query }) — describe what you are trying to do in plain
   language. Matching tools come back with their full input schema, and on
   hosts that support it are added to your tool list immediately, so you can
   call them directly like any other tool.
2. call_capability({ id, arguments }) — the fallback path, and the only one on
   hosts that do not refresh their tool list. Use it whenever a tool named in a
   search result is not yet callable directly; the result is identical.
3. describe_capability({ id }) — full detail on demand: the schema for a tool
   that was not inlined, or the complete instruction text for a skill. Reading a
   skill's instructions is how a skill runs.

Search before concluding that something is impossible: the catalog covers many
servers, skills and plugin commands that are not visible in your tool list.`;

export async function serve(opts: { cwd?: string } = {}): Promise<void> {
  const router = await Router.create({ cwd: opts.cwd });
  const server = new Server(
    { name: NAME, version: VERSION },
    {
      capabilities: {
        tools: { listChanged: true },
        // Prompts are how a router gets slash commands. Claude Code reads
        // commands/*.md off disk, which nothing over MCP can add to, but it does
        // surface every MCP prompt as /mcp__<server>__<name>.
        prompts: { listChanged: true },
      },
      instructions: INSTRUCTIONS,
    },
  );

  let profile: ClientProfile | null = null;
  /** Capabilities promoted to real tools, keyed by their exposed tool name. */
  const activated = new Map<string, Capability>();

  server.oninitialized = () => {
    profile = profileClient(server.getClientVersion(), server.getClientCapabilities());
    log(`client: ${profile.name} ${profile.version} — ${profile.rationale}`);
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Cheap staleness check on a request the host makes anyway. A long-lived
    // serve process would otherwise answer from the catalog it built at
    // startup forever — including one built before a server was authorized,
    // where the fix (login + reindex) lands on disk and never reaches here.
    void refreshAndAnnounce();
    const tools = routerTools(router, profile);
    for (const [name, cap] of activated) tools.push(promotedTool(name, cap));
    return { tools };
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    void refreshAndAnnounce();
    return { prompts: promptList(router.catalog.capabilities) };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    if (await router.isStale()) await router.refresh();
    return await handleGetPrompt(router, name, args as Record<string, string>);
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    try {
      switch (name) {
        case "find_capabilities":
          // A search is the request where a missing capability actually hurts,
          // so wait for a pending rebuild rather than answering from a catalog
          // we already know is stale.
          if (await router.isStale()) await router.refresh();
          return await handleFind(router, server, profile, activated, args as any);
        case "describe_capability":
          return await handleDescribe(router, args as any);
        case "call_capability":
          return await handleCall(router, args as any);
        case "activate_capabilities":
          return await handleActivate(router, server, activated, args as any);
        case "deactivate_capabilities":
          return await handleDeactivate(server, activated, args as any);
        default: {
          const cap = activated.get(name);
          if (cap) return await invoke(router, cap, args, true);
          return errorResult(`Unknown tool: ${name}. Use find_capabilities to search.`);
        }
      }
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  });

  /**
   * Rebuilds when stale and tells the host the tool list changed.
   *
   * The inventory line in find_capabilities' own description names the servers
   * in the catalog, so it goes stale with it — a host that caches tool
   * descriptions would keep showing a list that omits a newly authorized
   * server.
   */
  async function refreshAndAnnounce(): Promise<void> {
    const before = router.summary();
    await router.refresh();
    if (router.summary() === before) return;
    log(`catalog changed — ${router.summary()}`);
    server.sendToolListChanged?.();
    // A newly authorized server can contribute skills and commands too, so the
    // slash-command list goes stale alongside the tool list.
    server.sendPromptListChanged?.();
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`ready — ${router.summary()}`);

  // connect() resolves as soon as the transport is wired up, but the server has
  // to outlive that — the caller exits the process on the returned promise, so
  // resolving here would kill the server before it answers initialize. Stay
  // pending until the client hangs up or we are signalled.
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      router.close().catch(() => {});
      resolve();
    };
    server.onclose = finish;
    transport.onclose = finish;
    process.on("SIGINT", finish);
    process.on("SIGTERM", finish);
    // A closed stdin means the host is gone; nothing further can arrive.
    process.stdin.on("end", finish);
  });
}

function routerTools(router: Router, profile: ClientProfile | null): Tool[] {
  const tools: Tool[] = [
    {
      name: "find_capabilities",
      description: `Search every available tool, skill, prompt and command by what you are trying to do, and get back only the ones that fit. Catalog: ${router.summary()}. Use this whenever a task might need a capability you cannot already see — searching is cheap and the catalog is much larger than your tool list.`,
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "What you are trying to accomplish, in plain language. Describe the goal, not a guessed tool name.",
          },
          kind: {
            type: "string",
            enum: ["tool", "skill", "prompt", "resource", "command", "agent"],
            description: "Optional: restrict results to one kind of capability.",
          },
          server: { type: "string", description: "Optional: restrict to one provider." },
          limit: { type: "number", description: "Max results (default 8)." },
        },
        required: ["query"],
      },
    },
    {
      name: "describe_capability",
      description:
        "Get full detail for one capability id from find_capabilities: the complete input schema for a tool, or the full instruction text for a skill or command.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "Capability id, e.g. mcp:supabase/execute_sql" } },
        required: ["id"],
      },
    },
    {
      name: "call_capability",
      description:
        "Run a capability by id and return its result. Works for tools, prompts and resources; skills and commands are executed by following the text from describe_capability instead.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Capability id to invoke." },
          arguments: { type: "object", description: "Arguments matching the capability's input schema." },
          confirm: {
            type: "boolean",
            description: "Set true to proceed with a capability that requires explicit confirmation.",
          },
        },
        required: ["id"],
      },
    },
  ];

  // Only advertise dynamic exposure where the client will actually honour the
  // list_changed notification — otherwise the model activates tools that never
  // materialize and has no way to recover.
  if (profile?.supportsListChanged) {
    tools.push(
      {
        name: "activate_capabilities",
        description:
          "Promote capabilities to real, first-class tools in your tool list so you can call them directly with full schema validation. Use after find_capabilities when you expect to call something several times.",
        inputSchema: {
          type: "object",
          properties: {
            ids: { type: "array", items: { type: "string" }, description: "Capability ids to promote." },
          },
          required: ["ids"],
        },
      },
      {
        name: "deactivate_capabilities",
        description: "Remove previously activated capabilities from your tool list to reclaim context.",
        inputSchema: {
          type: "object",
          properties: {
            ids: { type: "array", items: { type: "string" }, description: "Ids to remove; omit to remove all." },
          },
        },
      },
    );
  }

  return tools;
}

/**
 * A promoted capability as the host will see it.
 *
 * The schema is compacted rather than passed through: this definition lives in
 * the host's tool list for the rest of the session, so it is the single most
 * expensive place a stray paragraph can land. Structure is preserved exactly,
 * so the host's own argument validation is unaffected.
 */
function promotedTool(name: string, cap: Capability): Tool {
  return {
    name,
    description: clamp(cap.description || `${cap.kind} ${cap.name}`, PROMOTED_DESC_CHARS),
    inputSchema: cap.inputSchema
      ? (compactSchema(cap.inputSchema) as Tool["inputSchema"])
      : { type: "object", properties: {} },
  };
}

/** Prose budget for a promoted tool's own description. */
const PROMOTED_DESC_CHARS = 320;

/** What one promoted tool actually costs the host, post-compaction. */
function promotedCost(name: string, cap: Capability): number {
  return tokensOf(promotedTool(name, cap));
}

/**
 * Serves a slash command.
 *
 * Two shapes: `find` runs a search and returns the results as text, so
 * `/mcp__autorouter__find <query>` is a usable entry point from the keyboard;
 * everything else resolves to a skill or command and returns its instruction
 * body, which is exactly what invoking it natively does.
 */
async function handleGetPrompt(
  router: Router,
  name: string,
  args: Record<string, string>,
): Promise<GetPromptResult> {
  if (name === FIND_PROMPT) {
    const query = (args.query ?? "").trim();
    if (!query) throw new Error("query is required");
    const result = await router.route(query, { harness: "prompt" });
    return {
      description: `Capabilities matching "${query}"`,
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: renderRouteResult(query, result, { inlineSchemas: true }),
          },
        },
      ],
    };
  }

  const cap = capabilityForPrompt(router.catalog.capabilities, name);
  if (!cap) throw new Error(`Unknown prompt: ${name}`);
  const found = await router.describe(cap.id);
  return {
    description: cap.description,
    messages: promptMessages(cap, found?.body, args),
  };
}

/** How many matched tools are promoted to real host tools per search. */
const AUTO_ACTIVATE_LIMIT = 5;

/**
 * Ceiling on the total size of the promoted tool list, in tokens.
 *
 * Bounding by *count* is the obvious thing and it is wrong: tool definitions on
 * this machine range from 199 to 1,748 tokens, so fifteen promoted tools is
 * anywhere between 3k and 26k of permanent context depending entirely on which
 * ones the model happened to search for. Three Datadog searches would quietly
 * park ~10k tokens in the tool list and stay there for the session — the exact
 * bloat the router exists to remove, arrived at by a slower road.
 *
 * A token budget makes the guarantee independent of which tools are hit: the
 * promoted list never exceeds this, whether that is twenty small tools or four
 * large ones.
 */
const ACTIVE_TOKEN_BUDGET = 3000;

async function handleFind(
  router: Router,
  server: Server,
  profile: ClientProfile | null,
  activated: Map<string, Capability>,
  args: { query?: string; kind?: CapabilityKind; server?: string; limit?: number },
): Promise<CallToolResult> {
  const query = (args.query ?? "").trim();
  if (!query) return errorResult("query is required");

  const result = await router.route(query, {
    kind: args.kind,
    server: args.server,
    limit: args.limit,
    harness: profile?.name,
    server_handle: server,
  });

  // Where the host honours list_changed, promote the matched tools instead of
  // describing them. That is the difference between approximating a native tool
  // call and making one: the host validates the arguments against the real
  // schema, the permission prompt names the real tool rather than
  // "call_capability", and the router leaves the execution path entirely. The
  // proxy stays as the fallback, because Claude Code does not always allow a
  // tool registered mid-turn to be called before the next one.
  const promoted = profile?.supportsListChanged
    ? await promote(server, activated, result.hits.map((h) => h.capability))
    : [];

  // Inlining schemas here as well would pay for them twice — the host is about
  // to list these tools with their schemas already attached.
  const text = renderRouteResult(query, result, { inlineSchemas: promoted.length === 0 });
  if (!promoted.length) return textResult(text);

  return textResult(
    `${text}\n\nNow callable directly as: ${promoted.join(", ")}.\n` +
      "If they are not yet in your tool list, use call_capability with the ids above — the result is identical.",
  );
}

/**
 * Registers capabilities as first-class host tools, newest search wins.
 *
 * Bounded on purpose: activation exists to keep context small, and an unbounded
 * set would drift back toward loading everything. Eviction is LRU and the budget
 * is in tokens, so what gets dropped is whatever has gone longest unused — and
 * a single very large tool costs several small ones their place, which is the
 * correct trade when the thing being conserved is context.
 */
async function promote(
  server: Server,
  activated: Map<string, Capability>,
  caps: Capability[],
): Promise<string[]> {
  const names: string[] = [];
  let changed = false;
  for (const cap of caps) {
    if (cap.kind !== "tool" || !cap.inputSchema) continue;
    if (names.length >= AUTO_ACTIVATE_LIMIT) break;
    const name = exposedName(cap);
    names.push(name);
    // Re-set even when present, so a repeat hit refreshes its LRU position.
    if (activated.get(name)?.id !== cap.id) changed = true;
    activated.delete(name);
    activated.set(name, cap);
  }
  if (evictToBudget(activated, names)) changed = true;
  if (changed) await server.sendToolListChanged();
  return names;
}

/**
 * Drops least-recently-promoted tools until the list fits the token budget.
 *
 * Tools promoted by the search in flight are never evicted: the model was just
 * told it can call them, and a tool that vanishes between the search result and
 * the call is worse than one that was never offered.
 */
function evictToBudget(activated: Map<string, Capability>, keep: string[]): boolean {
  let total = 0;
  for (const [name, cap] of activated) total += promotedCost(name, cap);
  if (total <= ACTIVE_TOKEN_BUDGET) return false;

  const protectedNames = new Set(keep);
  let changed = false;
  for (const [name, cap] of activated) {
    if (total <= ACTIVE_TOKEN_BUDGET) break;
    if (protectedNames.has(name)) continue;
    total -= promotedCost(name, cap);
    activated.delete(name);
    changed = true;
  }
  return changed;
}

async function handleDescribe(router: Router, args: { id?: string }): Promise<CallToolResult> {
  if (!args.id) return errorResult("id is required");
  const found = await router.describe(args.id);
  if (!found) {
    return errorResult(`No capability with id "${args.id}". Use find_capabilities to search.`);
  }
  return textResult(renderCapability(found.capability, found.body));
}

async function handleCall(
  router: Router,
  args: { id?: string; arguments?: unknown; confirm?: boolean },
): Promise<CallToolResult> {
  if (!args.id) return errorResult("id is required");
  const cap = router.get(args.id);
  if (!cap) return errorResult(`No capability with id "${args.id}".`);
  return invoke(router, cap, args.arguments ?? {}, args.confirm === true);
}

async function invoke(
  router: Router,
  cap: Capability,
  args: unknown,
  confirmed: boolean,
): Promise<CallToolResult> {
  try {
    const out = await router.call(cap.id, args, { confirmed });
    if (out.capability.kind === "skill" || out.capability.kind === "command" || out.capability.kind === "agent") {
      return { content: out.content, isError: false };
    }
    // The host's permission prompt only ever saw "call_capability", so the
    // resolved target has to be visible in the result itself.
    return {
      content: [{ type: "text" as const, text: `[${out.source}]` }, ...out.content],
      isError: out.isError,
      ...(out.structuredContent
        ? { structuredContent: out.structuredContent as Record<string, unknown> }
        : {}),
    };
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}

async function handleActivate(
  router: Router,
  server: Server,
  activated: Map<string, Capability>,
  args: { ids?: string[] },
): Promise<CallToolResult> {
  const ids = args.ids ?? [];
  if (!ids.length) return errorResult("ids is required");

  const added: string[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const cap = router.get(id);
    if (!cap || cap.kind !== "tool") {
      missing.push(id);
      continue;
    }
    const toolName = exposedName(cap);
    activated.set(toolName, cap);
    added.push(toolName);
  }

  if (added.length) await server.sendToolListChanged();

  const lines = [
    added.length ? `Activated as tools: ${added.join(", ")}` : "Nothing activated.",
    missing.length ? `Not activatable (unknown, or not a tool): ${missing.join(", ")}` : "",
    // Claude Code will not always let a mid-turn tool be called in the same
    // turn, so the fallback path must be stated rather than assumed.
    added.length
      ? "If these do not appear in your tool list yet, call them through call_capability instead — the result is identical."
      : "",
  ].filter(Boolean);
  return textResult(lines.join("\n"));
}

async function handleDeactivate(
  server: Server,
  activated: Map<string, Capability>,
  args: { ids?: string[] },
): Promise<CallToolResult> {
  const before = activated.size;
  if (!args.ids?.length) activated.clear();
  else {
    for (const id of args.ids) {
      for (const [name, cap] of activated) {
        if (cap.id === id || name === id) activated.delete(name);
      }
    }
  }
  if (activated.size !== before) await server.sendToolListChanged();
  return textResult(`Active tools: ${activated.size} (was ${before}).`);
}

/** MCP tool names must be stable and free of the : and / used in ids. */
export function exposedName(cap: Capability): string {
  const parsed = parseCapabilityId(cap.id);
  const raw = parsed.server ? `${parsed.server}__${cap.name}` : cap.name;
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** stdout is the MCP transport; diagnostics must go to stderr. */
function log(message: string): void {
  process.stderr.write(`[autorouter] ${message}\n`);
}
