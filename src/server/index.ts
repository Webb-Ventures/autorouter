import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
  RootsListChangedNotificationSchema,
  type CallToolResult,
  type GetPromptResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { Router, parseCapabilityId } from "../router.ts";
import { profileClient, type ClientProfile } from "./clientProfile.ts";
import { renderCapability, renderRouteResult } from "./render.ts";
import type { Capability, CapabilityKind } from "../catalog/types.ts";
import type { RouterConfig } from "../config/types.ts";
import {
  FIND_PROMPT,
  capabilityForPrompt,
  promptList,
  promptMessages,
} from "./prompts.ts";
import { clamp, compactSchema, tokensOf } from "../util/compact.ts";
import { runAutoAdopt } from "../cli/adopt.ts";
import { runProjectAdopt } from "../workspace/project.ts";
import { workspaceRoot } from "../workspace/root.ts";
import { describeSpec, parseAddSpec, runAdd, type AddSpec } from "../cli/add.ts";
import { ResultStore } from "./spill.ts";
import { autoCallVerdict, validateArgs } from "./auto.ts";

const NAME = "autorouter";
const VERSION = "0.1.0";

/**
 * Server instructions, worded for the activation mode actually in force.
 *
 * The promotion sentence used to say "a tool you call more than once is
 * promoted", which was never what lazy mode did — it promotes after the first
 * successful call — and is simply false under "eager" or "off". The model plans
 * around this text, so it has to describe the real behaviour.
 */
export function instructionsFor(activation: RouterConfig["activation"]): string {
  const promotion =
    activation === "lazy"
      ? " After its first successful call a tool joins your tool list (where supported)."
      : activation === "eager"
        ? " Tool hits join your tool list (where supported)."
        : "";
  // Claude Code defers tool schemas but injects this text into every request,
  // so it carries only what the model needs before it has loaded any tool.
  return `Most tools, skills and MCP servers are behind find_capabilities: search it by goal before deciding something can't be done. Run a hit with call_capability.${promotion} describe_capability returns a full schema, or a skill's instructions; reading them is how a skill runs.`;
}

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
      instructions: instructionsFor(router.resolved.config.activation),
    },
  );

  let profile: ClientProfile | null = null;
  /** Oversized results, saved to disk or held for paging. */
  const results = new ResultStore(router.resolved.config, router.resolved.cwd);
  void results.sweep();
  /** Capabilities promoted to real tools, keyed by their exposed tool name. */
  const activated = new Map<string, Capability>();
  const { promptMode, activation, allowAddServer } = router.resolved.config;
  /**
   * Adoptions that have happened since the last search, waiting to be reported.
   *
   * Auto-adopt fires from a background refresh, where the only channel is
   * stderr — which nobody is tailing. The user needs to know two things (a
   * server moved, and the harness must restart before its context is actually
   * reclaimed), so the note rides out on the next search result and is then
   * cleared.
   */
  let pendingNotes: string[] = [];
  /** Promotion needs both a host that refreshes its tool list and a mode that wants it. */
  const canPromote = () => Boolean(profile?.supportsListChanged) && activation !== "off";

  /**
   * Promotes a tool the model just used successfully.
   *
   * This is the whole of "lazy": a tool definition is permanent context for the
   * rest of the session, and a search hit is only evidence that the model looked
   * at something. A completed call is evidence it needs it — and a second call
   * then goes through the host's own validation and permission prompt rather
   * than the proxy.
   */
  const promoteOnUse = async (cap: Capability): Promise<string | null> => {
    if (activation !== "lazy" || !canPromote()) return null;
    if (cap.kind !== "tool" || !cap.inputSchema) return null;
    const [name] = await promote(server, activated, [cap]);
    return name ?? null;
  };

  /**
   * Routes the current repo's `.mcp.json` servers and project skills, and hides
   * them from the harness through that repo's settings.local.json. Safe to call
   * repeatedly: a second pass finds nothing new and writes nothing.
   */
  async function adoptProject(): Promise<void> {
    try {
      const { notes, plan } = await runProjectAdopt(router.resolved.cwd, { auto: true });
      for (const note of notes) {
        log(note);
        pendingNotes.push(`${note} — restart the harness to reclaim its context.`);
      }
      if (plan?.unapproved.length) {
        log(`not routing unapproved .mcp.json server(s): ${plan.unapproved.join(", ")}`);
      }
    } catch {
      // Never fail a session over a settings file we could not update.
    }
  }

  /**
   * Follows the host's workspace. Claude Code answers roots/list with its launch
   * directory (plus --add-dir ones) and announces changes; the first root is the
   * project whose servers and skills belong in the catalog.
   */
  async function syncRoots(): Promise<void> {
    if (!server.getClientCapabilities()?.roots) return;
    try {
      const { roots } = await server.listRoots();
      const before = router.summary();
      const moved = await router.retarget(workspaceRoot(roots.map((r) => r.uri)));
      if (!moved) return;
      log(`workspace: ${router.resolved.cwd}`);
      await adoptProject();
      if (router.summary() !== before) {
        server.sendToolListChanged?.();
        server.sendPromptListChanged?.();
      }
    } catch {
      // A host that advertises roots but fails to list them keeps the startup root.
    }
  }

  server.oninitialized = () => {
    profile = profileClient(server.getClientVersion(), server.getClientCapabilities());
    results.setReadsFiles(profile.readsFiles);
    log(`client: ${profile.name} ${profile.version} — ${profile.rationale}`);
    void syncRoots();
  };
  server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
    await syncRoots();
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Cheap staleness check on a request the host makes anyway. A long-lived
    // serve process would otherwise answer from the catalog it built at
    // startup forever — including one built before a server was authorized,
    // where the fix (login + reindex) lands on disk and never reaches here.
    void refreshAndAnnounce();
    const tools = routerTools(router, profile, activation, allowAddServer);
    for (const [name, cap] of activated) tools.push(promotedTool(name, cap));
    return { tools };
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    void refreshAndAnnounce();
    return { prompts: promptList(router.catalog.capabilities, promptMode) };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    if (await router.isStale()) await router.refresh();
    return await handleGetPrompt(router, name, args as Record<string, string>, promptMode);
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    try {
      switch (name) {
        case "find_capabilities":
          // A search is the request where a missing capability actually hurts,
          // so wait for a pending rebuild rather than answering from a catalog
          // we already know is stale. Going through refreshAndAnnounce rather
          // than refresh() is what lets a server added since startup be adopted
          // and found in the same request — a host that never re-lists its tools
          // would otherwise never trigger the check at all.
          if (await router.isStale()) await refreshAndAnnounce();
          return await handleFind(router, server, profile, activated, activation, args as any, drainNotes(), {
            results,
            promoteOnUse,
          });
        case "describe_capability":
          return await handleDescribe(router, args as any);
        case "call_capability":
          return await handleCall(router, promoteOnUse, args as any, results);
        case "activate_capabilities":
          if ((args as { off?: boolean }).off) return await handleDeactivate(server, activated, args as any);
          return await handleActivate(router, server, activated, args as any);
        // No longer advertised; still answered for hosts holding an old tool list.
        case "deactivate_capabilities":
          return await handleDeactivate(server, activated, args as any);
        case "add_server":
          return await handleAddServer(router, server, args as any);
        default: {
          const cap = activated.get(name);
          // Already a first-class tool: the host validated the arguments and
          // named it in its own permission prompt, so there is nothing to
          // promote and no proxy disclaimer to add.
          if (cap) return await invoke(router, cap, args, true, results);
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
  let adopting = false;
  /**
   * Runs only after a refresh that was actually triggered by a changed config.
   *
   * Auto-adopt reads and rewrites harness config files; doing that on every
   * tools/list would be a lot of filesystem work to discover nothing, since the
   * answer only changes when one of those files does — which is exactly what
   * staleness already tracks.
   */
  async function maybeAutoAdopt(): Promise<void> {
    // Adoption rewrites the harness config, which changes the fingerprint that
    // triggered this refresh. That is not a loop — adopt is idempotent, so the
    // next pass finds nothing to move — but the flag keeps two concurrent
    // requests from both trying to rewrite the same file.
    if (adopting) return;
    adopting = true;
    try {
      const adopted = await runAutoAdopt(router.resolved.cwd);
      for (const note of adopted) {
        log(note);
        pendingNotes.push(`${note} — restart the harness to reclaim its context.`);
      }
      await adoptProject();
      if (adopted.length) await router.refresh({ force: true });
    } catch {
      // Never fail the request that happened to trigger the check.
    } finally {
      adopting = false;
    }
  }

  async function refreshAndAnnounce(): Promise<void> {
    const before = router.summary();
    const wasStale = await router.isStale();
    await router.refresh();
    if (wasStale) await maybeAutoAdopt();

    if (router.summary() === before) return;
    log(`catalog changed — ${router.summary()}`);
    server.sendToolListChanged?.();
    // A newly authorized server can contribute skills and commands too, so the
    // slash-command list goes stale alongside the tool list.
    server.sendPromptListChanged?.();
  }

  function drainNotes(): string[] {
    const notes = pendingNotes;
    pendingNotes = [];
    return notes;
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`ready — ${router.summary()}`);
  // Hosts without roots never call syncRoots, so the startup root is adopted here.
  void adoptProject();

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
      // Saved results can hold production data; they go with the session.
      results.cleanup().finally(resolve);
    };
    server.onclose = finish;
    transport.onclose = finish;
    process.on("SIGINT", finish);
    process.on("SIGTERM", finish);
    // A closed stdin means the host is gone; nothing further can arrive.
    process.stdin.on("end", finish);
  });
}

function routerTools(
  router: Router,
  profile: ClientProfile | null,
  activation: RouterConfig["activation"],
  allowAddServer: boolean,
): Tool[] {
  const tools: Tool[] = [
    {
      name: "find_capabilities",
      // The server names stay: they are what lets a host's own tool search
      // match "supabase" to this tool.
      description: `Search all tools, skills and commands by goal; returns only what fits. Servers: ${router.inventory()}.`,
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The goal in plain words, not a tool name.",
          },
          kind: {
            type: "string",
            enum: ["tool", "skill", "prompt", "resource", "command", "agent"],
          },
          server: { type: "string" },
          limit: { type: "number", description: "Default 8." },
          arguments: { type: "object" },
          auto: { type: "boolean", description: "Run the top hit with arguments if it clearly wins." },
        },
        required: ["query"],
      },
    },
    {
      name: "describe_capability",
      description: "Full input schema of a tool, or full instructions of a skill or command.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "e.g. mcp:supabase/execute_sql" } },
        required: ["id"],
      },
    },
    {
      name: "call_capability",
      description: "Run a tool, prompt or resource by id. Skills and commands run by following describe_capability's text.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          arguments: { type: "object" },
          confirm: { type: "boolean", description: "Required by some capabilities." },
        },
        required: ["id"],
      },
    },
  ];

  // Only advertise dynamic exposure where the client will actually honour the
  // list_changed notification — otherwise the model activates tools that never
  // materialize and has no way to recover. Under "off" the tool is dead weight
  // in every request, so it does not ship at all.
  if (profile?.supportsListChanged && activation !== "off") {
    // One tool for both directions: a separate deactivate tool cost a whole
    // definition for something used about once a session.
    tools.push({
      name: "activate_capabilities",
      description: "Pin tools into your tool list to call directly. off: true unpins them (all, if ids is omitted).",
      inputSchema: {
        type: "object",
        properties: {
          ids: { type: "array", items: { type: "string" } },
          off: { type: "boolean" },
        },
      },
    });
  }

  if (allowAddServer) {
    tools.push({
      name: "add_server",
      description:
        "Register an MCP server behind the router (not `claude mcp add`): url, command+args, or json for an {\"mcpServers\":…} snippet. Needs confirm: true.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          url: { type: "string" },
          command: { type: "string" },
          args: { type: "array", items: { type: "string" } },
          env: { type: "object" },
          headers: { type: "object" },
          json: { type: "string" },
          confirm: { type: "boolean" },
        },
        required: ["name"],
      },
    });
  }

  return tools;
}

/**
 * Registers a server on the model's behalf.
 *
 * Gated the same way `confirm` capabilities are: the first call reports what
 * would be registered and writes nothing. A stdio entry is a command this
 * machine will execute on every subsequent launch, so it must not land on one
 * tool call that the user waved through — the resolved command has to be in
 * front of them before anything is written.
 */
async function handleAddServer(
  router: Router,
  server: Server,
  args: AddSpec & { confirm?: boolean },
): Promise<CallToolResult> {
  let target: string;
  let name: string;
  try {
    const parsed = parseAddSpec(args);
    name = parsed.name;
    target = describeSpec(parsed.raw);
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }

  if (args.confirm !== true) {
    return textResult(
      [
        `Confirmation required before registering "${name}".`,
        `This machine will ${args.url || target.startsWith("http") ? "connect to" : "execute"}: ${target}`,
        "",
        "Show the user that line. If it is what they asked for, call add_server again with confirm: true.",
      ].join("\n"),
    );
  }

  const result = await runAdd(args, router.resolved.cwd);
  if (!result.ok) return errorResult(result.message);

  // The catalog just grew; the host is holding a stale tool and prompt list.
  await router.refresh({ force: true });
  server.sendToolListChanged?.();
  server.sendPromptListChanged?.();
  return textResult(`${result.message}\nSearch for them with find_capabilities.`);
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
  mode: RouterConfig["promptMode"],
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

  const cap = capabilityForPrompt(router.catalog.capabilities, name, mode);
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
  activation: RouterConfig["activation"],
  args: {
    query?: string;
    kind?: CapabilityKind;
    server?: string;
    limit?: number;
    arguments?: unknown;
    auto?: boolean;
  },
  notes: string[] = [],
  ctx: { results?: ResultStore; promoteOnUse?: (cap: Capability) => Promise<string | null> } = {},
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

  // Under "eager", promote the matched tools instead of describing them: the
  // host then validates arguments against the real schema and its permission
  // prompt names the real tool rather than "call_capability".
  //
  // It is not the default because the bill lands in the wrong place. A promoted
  // tool is permanent context for the session, and a search hit only means the
  // model looked — most of five promoted tools per search are never called. The
  // inline schema below costs a fraction, once, in the transcript; promotion is
  // deferred to the first successful call, where the need is proven.
  const promoted = activation === "eager" && profile?.supportsListChanged
    ? await promote(server, activated, result.hits.map((h) => h.capability))
    : [];

  // find + call in one request. It saves the model a round trip when the task
  // is unambiguous; anything short of a clear winner with arguments that fit
  // falls back to the normal result, with the reason stated so the model knows
  // what to do instead.
  let autoNote: string | null = null;
  if (args.auto === true) {
    const verdict = autoCallVerdict(result.hits);
    const top = result.hits[0]?.capability;
    let reason = verdict.ok ? null : verdict.reason;
    if (!reason && top) {
      const problems = validateArgs(top.inputSchema, args.arguments ?? {});
      if (problems.length) reason = `arguments do not fit ${top.id}: ${problems.join("; ")}`;
      // Auto must never be a way round a confirm gate: the gate exists so a
      // human sees the resolved target before anything runs.
      else if (router.guard.requiresConfirmation(top)) {
        reason = `${top.id} requires confirmation; check with the user, then call_capability with confirm: true`;
      }
    }
    if (!reason && top && verdict.ok) {
      const out = await invoke(router, top, args.arguments ?? {}, false, ctx.results);
      const promotedName = out.isError ? null : await ctx.promoteOnUse?.(top);
      const others = result.hits.slice(1, 4).map((h) => h.capability.id);
      const lead = [
        ...notes.map((n) => `[autorouter] ${n}`),
        `[autorouter] auto-ran ${top.id} (${verdict.why}).${others.length ? ` Other matches: ${others.join(", ")}.` : ""}`,
      ].join("\n");
      return {
        ...out,
        content: [
          { type: "text" as const, text: lead },
          ...out.content,
          ...(promotedName
            ? [{ type: "text" as const, text: `(now in your tool list as ${promotedName} — call it directly next time)` }]
            : []),
        ],
      };
    }
    autoNote = `[autorouter] auto: not run — ${reason}.`;
  }

  // Inlining schemas here as well would pay for them twice — the host is about
  // to list these tools with their schemas already attached.
  const body = renderRouteResult(query, result, { inlineSchemas: promoted.length === 0 });
  const lead = [...notes.map((n) => `[autorouter] ${n}`), ...(autoNote ? [autoNote] : [])];
  const text = lead.length ? `${lead.join("\n")}\n\n${body}` : body;
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
  promoteOnUse: (cap: Capability) => Promise<string | null>,
  args: { id?: string; arguments?: unknown; confirm?: boolean },
  results?: ResultStore,
): Promise<CallToolResult> {
  if (!args.id) return errorResult("id is required");
  // A page of a result too large to inline. Reusing call_capability keeps the
  // surface at the same tools rather than adding a reader of its own.
  if (args.id.startsWith("result:") && results) {
    return await results.page(args.id.slice("result:".length), (args.arguments ?? {}) as Record<string, unknown>);
  }
  const cap = router.get(args.id);
  if (!cap) return errorResult(`No capability with id "${args.id}".`);
  const out = await invoke(router, cap, args.arguments ?? {}, args.confirm === true, results);

  // Only a call that worked earns a place in the tool list. A failed one is as
  // likely to mean the model picked the wrong capability as that it needs this
  // one again, and the budget it would occupy is permanent either way.
  if (out.isError) return out;
  const name = await promoteOnUse(cap);
  if (!name) return out;
  return {
    ...out,
    content: [
      ...out.content,
      {
        type: "text" as const,
        text: `(now in your tool list as ${name} — call it directly next time)`,
      },
    ],
  };
}

async function invoke(
  router: Router,
  cap: Capability,
  args: unknown,
  confirmed: boolean,
  results?: ResultStore,
): Promise<CallToolResult> {
  try {
    const out = await router.call(cap.id, args, { confirmed });
    if (out.capability.kind === "skill" || out.capability.kind === "command" || out.capability.kind === "agent") {
      return { content: out.content, isError: false };
    }
    let content = out.content as CallToolResult["content"];
    let structured = out.structuredContent;
    // Data results only: a prompt's messages are instructions, and an error is
    // short and has to be read whole to be acted on.
    if (results && !out.isError && (cap.kind === "tool" || cap.kind === "resource")) {
      const processed = await results.process(cap.id, out.source, content, structured);
      content = processed.content;
      // structuredContent is a second copy of the same data; keeping it would
      // put back exactly what the card took out.
      if (processed.spilled) structured = undefined;
    }
    // The host's permission prompt only ever saw "call_capability", so the
    // resolved target has to be visible in the result itself.
    return {
      content: [{ type: "text" as const, text: `[${out.source}]` }, ...content],
      isError: out.isError,
      ...(structured ? { structuredContent: structured as Record<string, unknown> } : {}),
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
