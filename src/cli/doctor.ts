import { Router } from "../router.ts";
import { resolveConfig } from "../config/resolve.ts";
import { buildCatalog, saveCatalog } from "../catalog/build.ts";
import { apiBackend, inferProvider, providerForModel } from "../selector/backends.ts";
import { createProvider } from "../index/embeddings.ts";
import { runAdopt } from "./adopt.ts";
import type { Harness } from "./init.ts";
import { hasAuth } from "../config/oauth.ts";
import { promptList } from "../server/prompts.ts";
import { tokensOf } from "../util/compact.ts";

/**
 * Reports what the router can actually see and what it saves. The token
 * comparison is the number that justifies the whole design, so it is the
 * headline output.
 */
export async function runDoctor(cwd: string): Promise<string> {
  const lines: string[] = [];
  const resolved = await resolveConfig(cwd);
  const cfg = resolved.config;

  lines.push("# autorouter doctor", "");
  lines.push(`config: ${resolved.configPath ?? "(defaults — no autorouter.json found)"}`);
  lines.push(`cwd:    ${resolved.cwd}`);
  lines.push(`import: ${cfg.import.join(", ")}`, "");

  lines.push(`## Servers (${resolved.servers.length})`);
  if (!resolved.servers.length) lines.push("  none discovered");
  for (const s of resolved.servers) {
    const target = s.transport === "http" ? s.url : `${s.command} ${s.args.join(" ")}`.trim();
    // Auth state is only meaningful for http servers; a stdio server's
    // credentials are whatever its env block carries.
    const auth = s.transport === "http" ? ((await hasAuth(s.name)) ? " (authorized)" : "") : "";
    lines.push(
      `  ${s.name.padEnd(20)} ${s.transport.padEnd(6)} [${s.origin}] ${truncate(target, 70)}${auth}`,
    );
  }
  lines.push("");

  // Force a rebuild so failures surface now rather than being served from cache.
  const catalog = await buildCatalog(resolved);
  await saveCatalog(catalog);

  const byKind = new Map<string, number>();
  for (const c of catalog.capabilities) byKind.set(c.kind, (byKind.get(c.kind) ?? 0) + 1);
  lines.push(`## Catalog (${catalog.capabilities.length} capabilities)`);
  for (const [kind, n] of [...byKind].sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${String(n).padStart(4)} ${kind}`);
  }
  lines.push("");

  const errorEntries = Object.entries(catalog.errors);
  if (errorEntries.length) {
    lines.push(`## Unreachable (${errorEntries.length})`);
    for (const [name, err] of errorEntries) lines.push(`  ${name}: ${truncate(err, 120)}`);
    // An unauthorized server is the one failure the user can fix in one command,
    // so name the command instead of leaving it in the general error list.
    const needsLogin = errorEntries.filter(([, e]) => e.includes("autorouter login"));
    if (needsLogin.length) {
      lines.push(
        "",
        `  ${needsLogin.length} of these just need a grant of the router's own —`,
        "  the harness holds its token privately and cannot share it:",
        ...needsLogin.map(([name]) => `    autorouter login ${name}`),
      );
    }
    lines.push("");
  }

  lines.push("## Selector");
  const provider = cfg.selector.provider ?? providerForModel(cfg.selector.model) ?? inferProvider("cli");
  const backend = apiBackend(cfg.selector, "cli");
  lines.push(`  mode:     ${cfg.selector.mode ?? "auto"}`);
  lines.push(`  provider: ${provider ?? "(none resolvable)"}`);
  lines.push(`  model:    ${cfg.selector.model ?? backend?.model ?? "(unset)"}`);
  lines.push(
    backend
      ? "  status:   ready for direct API calls"
      : "  status:   no API backend — will use MCP sampling if the host offers it, else raw index order",
  );
  lines.push("");

  lines.push("## Embeddings");
  const embedder = createProvider(cfg.embeddings);
  lines.push(`  provider: ${cfg.embeddings.provider ?? "none"}`);
  lines.push(embedder ? `  status:   ready (${embedder.id})` : "  status:   disabled — lexical BM25 only");
  lines.push("");

  // Routing only saves anything if the servers it routes to are no longer
  // registered directly in the harness. Anything still listed there is loaded
  // in full on every turn, router or not, so report it as unrealized savings.
  const stillDirect = new Map<Harness, string[]>();
  /** Skills and plugins the harness still loads itself, by harness. */
  const stillLoaded = new Map<Harness, { skills: string[]; plugins: string[] }>();
  for (const harness of ["claude", "codex", "cursor", "vscode"] as Harness[]) {
    try {
      const { plans, extras } = await runAdopt({ harness, cwd, keep: [], dryRun: true, extras: true });
      const names = plans.flatMap((p) => p.moved);
      if (names.length) stillDirect.set(harness, [...new Set(names)]);
      if (extras && (extras.skills.length || extras.plugins.length)) {
        stillLoaded.set(harness, {
          skills: extras.skills.map((x) => x.name),
          plugins: extras.plugins.map((x) => x.name),
        });
      }
    } catch {
      // A harness we cannot read is simply not reported on.
    }
  }

  const directNames = new Set([...stillDirect.values()].flat());
  const directTokens = catalog.capabilities
    .filter((c) => c.server && directNames.has(c.server))
    .reduce((sum, c) => sum + c.approxTokens, 0);

  // Skills cost context even with every server routed: the harness injects each
  // one's name and description itself. Counting them with the servers is what
  // makes "still loaded" mean the whole remaining bill rather than part of it.
  const loadedSkills = new Set([...stillLoaded.values()].flatMap((x) => x.skills));
  const skillTokens = catalog.capabilities
    .filter((c) => c.kind === "skill" && loadedSkills.has(c.name))
    .reduce((sum, c) => sum + c.approxTokens, 0);

  const full = catalog.capabilities.reduce((sum, c) => sum + c.approxTokens, 0);
  // The router's own permanent footprint: its five tool definitions, plus the
  // prompt list, which the host fetches once and carries for the session. The
  // prompt list is measured rather than assumed, because it scales with how many
  // skills and commands the catalog holds — quoting a flat number here would
  // understate the bill on a machine with a large skill library.
  const routerSurface = 700 + tokensOf(promptList(catalog.capabilities));
  lines.push("## Context cost");
  lines.push(`  exposing everything: ~${full.toLocaleString()} tokens`);
  lines.push(`  router surface:      ~${routerSurface} tokens`);
  lines.push(`  still loaded direct: ~${(directTokens + skillTokens).toLocaleString()} tokens` +
    (skillTokens ? ` (${directTokens.toLocaleString()} servers + ${skillTokens.toLocaleString()} skills)` : ""));
  const saved = full - routerSurface - directTokens - skillTokens;
  lines.push(
    saved > 0
      ? `  actually saved:      ~${saved.toLocaleString()} tokens per request (${Math.round((saved / full) * 100)}%)`
      : "  actually saved:      nothing yet",
  );

  if (stillDirect.size || stillLoaded.size) {
    lines.push("", "## Not yet adopted");
    lines.push("  These are loaded by a harness directly, so they are injected on every");
    lines.push("  turn regardless of the router:");
    for (const harness of new Set([...stillDirect.keys(), ...stillLoaded.keys()])) {
      const parts: string[] = [];
      const servers = stillDirect.get(harness);
      const extra = stillLoaded.get(harness);
      if (servers?.length) parts.push(`servers: ${servers.join(", ")}`);
      if (extra?.plugins.length) parts.push(`plugins: ${extra.plugins.join(", ")}`);
      if (extra?.skills.length) parts.push(`skills: ${extra.skills.join(", ")}`);
      lines.push(`  ${harness}`);
      for (const part of parts) lines.push(`    ${part}`);
      lines.push(`    → autorouter adopt --target ${harness}`);
    }
  }

  return lines.join("\n");
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
