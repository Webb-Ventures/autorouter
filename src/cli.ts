#!/usr/bin/env node
import { Router, CapabilityError } from "./router.ts";
import { serve } from "./server/index.ts";
import { runInit, type Harness } from "./cli/init.ts";
import { runDoctor } from "./cli/doctor.ts";
import { runAdopt, runRestore } from "./cli/adopt.ts";
import { runAdd, runRemove } from "./cli/add.ts";
import { runLogin, summarizeScopes } from "./cli/login.ts";
import { clearAuth, hasAuth, readAuth } from "./config/oauth.ts";
import { resolveConfig } from "./config/resolve.ts";
import { renderCapability, renderRouteResult, oneLine } from "./server/render.ts";
import type { CapabilityKind } from "./catalog/types.ts";
import { loadCatalog } from "./catalog/build.ts";

const VERSION = "0.2.2";

const USAGE = `autorouter — one search tool instead of every tool

  autorouter serve                     Run as an MCP server over stdio (default)
  autorouter search <query>            Find capabilities for a request
  autorouter describe <id>             Show a capability's schema or instructions
  autorouter call <id> [--args JSON]   Invoke a capability
  autorouter list [--kind K]           List everything in the catalog
  autorouter reindex                   Rebuild the catalog now
  autorouter doctor                    Show what is reachable and what it saves
  autorouter login [server]            Authorize an OAuth server (opens a browser);
                                       with no argument, lists what needs one
  autorouter logout <server>           Forget a stored grant
  autorouter add <name> --url URL      Register a server with the router directly
  autorouter add <name> -- <cmd> ...   Same, for a stdio server
  autorouter add --json '<snippet>'    Same, from a pasted mcpServers block
  autorouter remove <name>             Unregister one
  autorouter init --target <harness>   Register with claude|codex|cursor|vscode
  autorouter adopt --target <harness>  Move that harness's other MCP servers —
                                       and, on Claude Code, its skills and
                                       plugins — behind the router. This is what
                                       removes them from context. --dry-run to
                                       preview.
  autorouter restore --target <harness> Undo the most recent adopt

Options
  --raw          search: skip the selector model, show index ranking
  --url URL      add: an http server
  --command C    add: a stdio server (or put the command after a bare --)
  --json SNIPPET add: a pasted {"mcpServers": {...}} block or a bare entry
  --kind K       restrict to tool|skill|prompt|resource|command|agent
  --server S     restrict to one provider
  --limit N      max results
  --json         machine-readable output
  --yes          init/adopt: do not prompt
  --dry-run      adopt: show what would move, change nothing
  --force        adopt: proceed even if a server is unreachable
  --keep S       adopt: leave server S registered in the harness (comma-separated)
  --keep-skill S adopt: leave skill S loaded (comma-separated)
  --keep-plugin P adopt: leave plugin P enabled (comma-separated)
  --servers-only adopt: move MCP servers only; leave skills and plugins loaded
  --skill-mode M adopt: user-invocable-only (default, /name still works) | off
  --port N       login: loopback callback port (default 33418; keep it stable)
  --client-id ID login: use a pre-registered OAuth client (servers without RFC 7591)
  --client-secret S  login: its secret, if it is a confidential client
  --read-only    login: request only the scopes that cannot mutate anything
  --scopes S     login: request exactly these scopes (comma or space separated)
  --list-scopes  login: show what the server offers, authorize nothing

\`add\` registers behind the router, so a new server never enters your context.
Servers added to a harness the normal way (\`claude mcp add\`) are moved behind
it automatically; set "autoAdopt": false to keep that manual.

Servers like Datadog and Supabase hold no credentials in their config — the
working token is an OAuth grant the harness keeps privately. The router obtains
its own grant instead of borrowing one, so \`autorouter login <server>\` is a
one-time step before those can be adopted.
`;

async function main(argv: string[]): Promise<number> {
  const { command, positionals, flags, rest } = parseArgs(argv);

  switch (command) {
    case undefined:
    case "serve":
      await serve({ cwd: process.cwd() });
      return 0;

    case "search":
      return await cmdSearch(positionals.join(" "), flags);

    case "describe":
      return await cmdDescribe(positionals[0], flags);

    case "call":
      return await cmdCall(positionals[0], flags);

    case "list":
      return await cmdList(flags);

    case "reindex": {
      const router = await Router.create({ force: true });
      console.log(`Reindexed: ${router.summary()}`);
      const failures = Object.entries(router.catalog.errors);
      for (const [name, err] of failures) console.error(`  unreachable: ${name}: ${oneLine(err, 100)}`);
      await router.close();
      return 0;
    }

    case "doctor":
      console.log(await runDoctor(process.cwd()));
      return 0;

    case "init":
      return await cmdInit(flags);

    case "login":
      return await cmdLogin(positionals[0], flags);

    case "logout":
      return await cmdLogout(positionals[0]);

    case "add":
      return await cmdAdd(positionals[0], flags, rest);

    case "remove":
    case "rm":
      return await cmdRemove(positionals[0]);

    case "adopt":
      return await cmdAdopt(flags);

    case "restore": {
      const harness = flags.target as Harness;
      if (!harness) {
        console.error("--target is required: claude|codex|cursor|vscode");
        return 1;
      }
      for (const note of await runRestore(harness)) console.log(note);
      return 0;
    }

    case "version":
    case "--version":
    case "-v":
      console.log(`autorouter ${VERSION}`);
      return 0;

    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return 0;

    default:
      console.error(`Unknown command: ${command}\n\n${USAGE}`);
      return 1;
  }
}

async function cmdAdd(name: string | undefined, flags: Flags, rest: string[]): Promise<number> {
  try {
    const result = await runAdd({
      name,
      url: flags.url as string | undefined,
      // Either form of stdio entry: --command "npx -y foo" as one string, or the
      // argv after a bare --, which is what people copy out of a README.
      command: (flags.command as string | undefined) ?? rest[0],
      args: flags.command ? undefined : rest.slice(1),
      json: flags.json as string | undefined,
    });
    console.log(result.message);
    if (!result.ok && result.path) {
      console.log("Fix it and re-run, or `autorouter remove` it.");
    }
    return result.ok ? 0 : 1;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

async function cmdRemove(name: string | undefined): Promise<number> {
  if (!name) {
    console.error("Usage: autorouter remove <name>");
    return 1;
  }
  console.log(await runRemove(name));
  return 0;
}

async function cmdLogin(server: string | undefined, flags: Flags): Promise<number> {
  if (!server) {
    // Without an argument, show which http servers still need a grant rather
    // than just complaining — that list is the whole reason to run this.
    const resolved = await resolveConfig(process.cwd());
    const http = resolved.servers.filter((s) => s.transport === "http");
    if (!http.length) {
      console.log("No http servers configured; OAuth login does not apply.");
      return 0;
    }
    const states = await Promise.all(
      http.map(async (entry) => {
        const stored = await readAuth(entry.name);
        return {
          name: entry.name,
          ok: Boolean(stored.tokens?.access_token),
          // What the grant actually covers is the part worth auditing — a
          // token that can write to your database looks identical to a
          // read-only one in a list of names.
          scope: stored.tokens?.scope ?? stored.requestedScope,
        };
      }),
    );
    console.log("Usage: autorouter login <server> [--read-only | --scopes a,b]\n");
    for (const s of states) {
      const scope = s.ok && s.scope ? `  ${summarizeScopes(s.scope)}` : "";
      console.log(`  ${s.ok ? "ok  " : "-   "} ${s.name}${scope}`);
    }

    // The same upstream often appears twice — once from the harness config and
    // once via a plugin — and each registration is a separate name holding its
    // own grant. Spell out every command rather than letting the user discover
    // the second one after the first appears to have worked.
    const pending = states.filter((s) => !s.ok);
    if (pending.length > 1) {
      console.log(`\n${pending.length} need a grant; each is a separate authorization:`);
      for (const s of pending) console.log(`  autorouter login ${s.name}`);
    }
    return 1;
  }
  const port = flags.port ? Number(flags.port) : undefined;
  // --list-scopes reports rather than authorizes, so a non-zero exit would be
  // wrong even though nothing was granted.
  const result = await runLogin({
    server,
    cwd: process.cwd(),
    port: Number.isFinite(port) ? port : undefined,
    force: Boolean(flags.force),
    clientId: flags["client-id"] as string | undefined,
    clientSecret: flags["client-secret"] as string | undefined,
    scopes: flags.scopes as string | undefined,
    readOnly: Boolean(flags["read-only"]),
    listScopes: Boolean(flags["list-scopes"]),
  });
  console.log(result.message);
  if (result.ok && !flags["list-scopes"]) {
    console.log("Re-run `autorouter reindex` to pick up its capabilities.");
  }
  return result.ok ? 0 : 1;
}

async function cmdLogout(server: string | undefined): Promise<number> {
  if (!server) {
    console.error("Usage: autorouter logout <server>");
    return 1;
  }
  await clearAuth(server);
  console.log(`Forgot stored credentials for ${server}.`);
  return 0;
}

async function cmdSearch(query: string, flags: Flags): Promise<number> {
  if (!query.trim()) {
    console.error("A query is required: autorouter search \"query postgres\"");
    return 1;
  }
  const router = await Router.create();
  try {
    if (flags.raw) {
      const hits = await router.rawSearch(query, {
        kind: flags.kind as CapabilityKind | undefined,
        server: flags.server,
        limit: num(flags.limit) ?? 20,
      });
      if (flags.json) {
        console.log(JSON.stringify(hits.map((h) => ({ id: h.capability.id, ...h })), null, 2));
      } else {
        for (const h of hits) {
          console.log(
            `${h.score.toFixed(3)}  ${h.capability.id.padEnd(44)} ${oneLine(h.capability.description, 90)}`,
          );
        }
      }
      return 0;
    }

    const result = await router.route(query, {
      kind: flags.kind as CapabilityKind | undefined,
      server: flags.server,
      limit: num(flags.limit),
    });
    console.log(
      flags.json
        ? JSON.stringify(result, null, 2)
        // A CLI caller has no host tool list to fall back on, so it always gets
        // the schemas it needs to actually invoke what it found.
        : renderRouteResult(query, result, { inlineSchemas: true }),
    );
    return 0;
  } finally {
    await router.close();
  }
}

async function cmdDescribe(id: string | undefined, flags: Flags): Promise<number> {
  if (!id) {
    console.error("A capability id is required.");
    return 1;
  }
  const router = await Router.create();
  try {
    const found = await router.describe(id);
    if (!found) {
      console.error(`No capability with id "${id}".`);
      return 1;
    }
    console.log(flags.json ? JSON.stringify(found, null, 2) : renderCapability(found.capability, found.body));
    return 0;
  } finally {
    await router.close();
  }
}

async function cmdCall(id: string | undefined, flags: Flags): Promise<number> {
  if (!id) {
    console.error("A capability id is required.");
    return 1;
  }
  let args: unknown = {};
  if (flags.args) {
    try {
      args = JSON.parse(flags.args);
    } catch {
      console.error("--args must be valid JSON");
      return 1;
    }
  }

  const router = await Router.create();
  try {
    const out = await router.call(id, args, { confirmed: Boolean(flags.yes) });
    if (flags.json) {
      console.log(JSON.stringify(out, null, 2));
    } else {
      for (const item of out.content) {
        console.log(item.type === "text" ? item.text : `[${item.type}]`);
      }
    }
    return out.isError ? 1 : 0;
  } catch (err) {
    if (err instanceof CapabilityError) {
      console.error(err.message);
      if (err.needsConfirmation) console.error("\nRe-run with --yes to proceed.");
      return 1;
    }
    throw err;
  } finally {
    await router.close();
  }
}

async function cmdList(flags: Flags): Promise<number> {
  const router = await Router.create();
  try {
    const caps = router.index
      .all()
      .filter((c) => !flags.kind || c.kind === flags.kind)
      .filter((c) => !flags.server || c.server === flags.server)
      .sort((a, b) => a.id.localeCompare(b.id));
    if (flags.json) {
      console.log(JSON.stringify(caps, null, 2));
    } else {
      for (const c of caps) console.log(`${c.id.padEnd(50)} ${oneLine(c.description, 80)}`);
      console.log(`\n${caps.length} capabilities · ${router.fullSurfaceTokens().toLocaleString()} tokens if all exposed`);
    }
    return 0;
  } finally {
    await router.close();
  }
}

async function cmdInit(flags: Flags): Promise<number> {
  const harness = (flags.target ?? flags.harness) as Harness | undefined;
  if (!harness || !["claude", "codex", "cursor", "vscode"].includes(harness)) {
    console.error("Specify --target claude|codex|cursor|vscode");
    return 1;
  }
  // Prefer the bundled entrypoint so the registered command works without Bun.
  const entry = process.argv[1] ?? "";
  const isBunSource = entry.endsWith(".ts");
  const command = isBunSource ? "bun" : process.execPath;
  const args = isBunSource ? [entry, "serve"] : [entry, "serve"];

  const notes = await runInit({ harness, command, args, yes: flags.yes });
  for (const note of notes) console.log(note);

  // Registering the router without adopting leaves every other server loaded,
  // which is a net *increase* in context. Say so rather than let it pass.
  const { plans, extras } = await runAdopt({
    harness,
    cwd: process.cwd(),
    keep: [],
    dryRun: true,
    extras: true,
  });
  const pending = [
    plansCount(plans) ? `${plansCount(plans)} MCP server(s)` : null,
    extras?.skills.length ? `${extras.skills.length} skill(s)` : null,
    extras?.plugins.length ? `${extras.plugins.length} plugin(s)` : null,
  ].filter(Boolean);
  if (pending.length) {
    console.log(
      `\n${pending.join(", ")} are still loaded directly by ${harness}.` +
        `\nUntil they move behind the router they stay in every prompt:` +
        `\n  autorouter adopt --target ${harness}`,
    );
  }
  console.log("\nRestart the harness for the change to take effect.");
  return 0;
}

function plansCount(plans: { moved: string[] }[]): number {
  return plans.reduce((n, p) => n + p.moved.length, 0);
}

async function cmdAdopt(flags: Flags): Promise<number> {
  const harness = (flags.target ?? flags.harness) as Harness | undefined;
  if (!harness || !["claude", "codex", "cursor", "vscode"].includes(harness)) {
    console.error("Specify --target claude|codex|cursor|vscode");
    return 1;
  }
  const list = (v: unknown) => String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const keep = list(flags.keep);
  const dryRun = Boolean(flags["dry-run"]);
  const skillMode = flags["skill-mode"] === "off" ? "off" : "user-invocable-only";
  if (flags["skill-mode"] && !["off", "user-invocable-only"].includes(String(flags["skill-mode"]))) {
    console.error("--skill-mode must be user-invocable-only or off");
    return 1;
  }
  const extrasOpts = {
    extras: !flags["servers-only"],
    skillMode: skillMode as "off" | "user-invocable-only",
    keepSkills: list(flags["keep-skill"]),
    keepPlugins: list(flags["keep-plugin"]),
  };

  // A server the router cannot reach is one the router cannot route to. Moving
  // it out of the harness config — or disabling the plugin that supplies it —
  // would silently delete a working capability, usually an OAuth server whose
  // token the harness holds and we do not. Resolve this before planning so the
  // plan itself can exclude them.
  const unreachable = await unreachableServers();
  const unreachableNames = new Set(unreachable.keys());

  const preview = await runAdopt({
    harness,
    cwd: process.cwd(),
    keep,
    dryRun: true,
    unreachable: unreachableNames,
    ...extrasOpts,
  });
  const total = preview.plans.reduce((n, p) => n + p.moved.length, 0);
  const extras = preview.extras;
  const extrasTotal = (extras?.skills.length ?? 0) + (extras?.plugins.length ?? 0);
  if (!total && !extrasTotal) {
    console.log(preview.notes.join("\n"));
    return 0;
  }

  for (const plan of preview.plans) {
    if (!plan.moved.length && !plan.kept.length) continue;
    console.log(`\n${plan.file} [${plan.section}]`);
    for (const name of plan.moved) {
      const why = unreachable.get(name);
      console.log(why ? `  move  ${name}   ⚠ unreachable: ${truncate(why, 60)}` : `  move  ${name}`);
    }
    for (const name of plan.kept) console.log(`  keep  ${name}`);
  }

  if (extras && extrasTotal) {
    console.log(`\n${extras.file}`);
    for (const p of extras.plugins) console.log(`  disable plugin  ${p.name}   (${p.reason})`);
    for (const s of extras.skills) {
      const label = s.from ? `${s.from}:${s.name}` : s.name;
      console.log(`  hide skill      ${label}   → ${s.mode}`);
    }
  }
  if (extras?.skipped.length) {
    console.log("");
    for (const note of extras.skipped) console.log(`  skip  ${note}`);
  }

  const blocked = preview.plans.flatMap((p) => p.moved).filter((n) => unreachable.has(n));
  if (blocked.length) {
    console.log(
      `\n⚠ The router could not connect to: ${[...new Set(blocked)].join(", ")}.` +
        `\n  Adopting them would take a working server out of your harness and put it` +
        `\n  behind a router that cannot reach it. Authenticate them first, or keep them:` +
        `\n    autorouter adopt --target ${harness} --keep ${[...new Set(blocked)].join(",")}`,
    );
    if (!flags.force) {
      console.log("\n  Re-run with --force to adopt them anyway.");
      return 1;
    }
  }

  if (dryRun) {
    console.log("\nDry run — nothing changed.");
    return 0;
  }
  if (!flags.yes && process.stdin.isTTY) {
    const { createInterface } = await import("node:readline/promises");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const what = [
      total ? `${total} server(s)` : null,
      extras?.skills.length ? `${extras.skills.length} skill(s)` : null,
      extras?.plugins.length ? `${extras.plugins.length} plugin(s)` : null,
    ].filter(Boolean).join(", ");
    const answer = (
      await rl.question(`\nMove ${what} behind the router? [y/N] `)
    ).trim().toLowerCase();
    rl.close();
    if (answer !== "y" && answer !== "yes") {
      console.log("Aborted.");
      return 1;
    }
  }

  const result = await runAdopt({
    harness,
    cwd: process.cwd(),
    keep,
    dryRun: false,
    unreachable: unreachableNames,
    ...extrasOpts,
  });
  console.log("");
  for (const note of result.notes) console.log(note);
  console.log(`Undo with: autorouter restore --target ${harness}`);
  return 0;
}

type Flags = Record<string, string | undefined> & {
  raw?: boolean | any;
  json?: boolean | any;
  yes?: boolean | any;
};

function parseArgs(argv: string[]): {
  command?: string;
  positionals: string[];
  flags: Flags;
  rest: string[];
} {
  const positionals: string[] = [];
  const flags: Flags = {};
  let command: string | undefined;
  let rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    // A bare "--" ends option parsing: everything after it is a command line for
    // something else, so `autorouter add foo -- npx -y foo-mcp --verbose` passes
    // that --verbose to foo-mcp rather than swallowing it here.
    if (arg === "--") {
      rest = argv.slice(i + 1);
      break;
    }
    if (arg.startsWith("--")) {
      const [name, inline] = splitOnce(arg.slice(2), "=");
      // `autorouter --help` must print usage, not fall through to `serve`
      // because no positional command was given.
      if (!command && (name === "help" || name === "version")) {
        command = `--${name}`;
        continue;
      }
      // `--json` is a boolean everywhere else (machine-readable output) but
      // carries the pasted server snippet for `add`. Resolving that by command
      // keeps the flag named the way the vendor docs people copy from name it.
      const boolean =
        ["raw", "json", "yes", "dry-run", "force", "servers-only", "read-only", "list-scopes"].includes(name) &&
        !(name === "json" && command === "add");
      if (boolean) {
        flags[name] = true as any;
      } else if (inline !== undefined) {
        flags[name] = inline;
      } else {
        flags[name] = argv[++i];
      }
      continue;
    }
    if (!command) command = arg;
    else positionals.push(arg);
  }
  return { command, positionals, flags, rest };
}

function splitOnce(s: string, sep: string): [string, string | undefined] {
  const i = s.indexOf(sep);
  return i === -1 ? [s, undefined] : [s.slice(0, i), s.slice(i + 1)];
}

function num(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isNaN(n) ? undefined : n;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  });

/**
 * Names of configured servers the last catalog build could not reach. Read from
 * the persisted catalog rather than reconnecting, so `adopt` stays fast; a stale
 * answer is fine because it only ever adds a warning, never suppresses one.
 */
async function unreachableServers(): Promise<Map<string, string>> {
  const catalog = await loadCatalog(process.cwd());
  const out = new Map<string, string>();
  for (const [name, err] of Object.entries(catalog?.errors ?? {})) out.set(name, err);
  return out;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
