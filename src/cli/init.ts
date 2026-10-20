import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { ensureDir, readText, writeText } from "../util/fs.ts";
import { suggestModel } from "../selector/backends.ts";
import { homeDir, stripJsonComments } from "../util/paths.ts";
import { resolveConfig } from "../config/resolve.ts";
import { ResultStore } from "../server/spill.ts";

export type Harness = "claude" | "codex" | "cursor" | "vscode";

const HARNESS_LABEL: Record<Harness, string> = {
  claude: "Claude Code",
  codex: "Codex CLI",
  cursor: "Cursor",
  vscode: "VS Code / Copilot",
};

/**
 * Registers the router with a harness and, because the selector should run on
 * the harness's own cheapest model, asks which model to use when it cannot be
 * inferred. The answer lands in that server's env block, so each harness gets
 * its own selector without a shared global setting.
 */
export async function runInit(opts: {
  harness: Harness;
  command: string;
  args: string[];
  yes?: boolean;
}): Promise<string[]> {
  const notes: string[] = [];
  const env: Record<string, string> = {};

  const suggested = await suggestModel(opts.harness);
  const model = opts.yes ? suggested : await promptModel(opts.harness, suggested);
  if (model) {
    env.AUTOROUTER_SELECTOR_MODEL = model;
    notes.push(`Selector model: ${model}`);
  } else {
    notes.push(
      "No selector model set — the router will use MCP sampling if the host offers it, otherwise raw index ranking.",
    );
  }

  switch (opts.harness) {
    case "claude":
      notes.push(await writeJsonServer(join(homeDir(), ".claude.json"), "mcpServers", opts, env));
      break;
    case "cursor":
      notes.push(await writeJsonServer(join(homeDir(), ".cursor", "mcp.json"), "mcpServers", opts, env));
      break;
    case "vscode":
      notes.push(await writeJsonServer(join(homeDir(), ".vscode", "mcp.json"), "servers", opts, env));
      break;
    case "codex":
      notes.push(await writeCodexServer(opts, env));
      break;
  }

  notes.push(await writePrimer(opts.harness));
  if (opts.harness === "claude") notes.push(await offerResultsReadRule(Boolean(opts.yes)));
  return notes;
}

/**
 * Large tool results are saved under the router's cache, outside any project,
 * so Claude Code asks permission for every Read of one. An allow rule for that
 * one directory removes the prompt without widening anything else.
 *
 * Asked, never assumed: a permission rule is the user's to grant. Without a
 * terminal (or with --yes) the rule is printed rather than written.
 */
async function offerResultsReadRule(yes: boolean): Promise<string> {
  const resolved = await resolveConfig(process.cwd());
  const dir = new ResultStore(resolved.config, resolved.cwd).rootDir;
  const rule = `Read(${readRulePath(dir)}/**)`;
  const path = join(homeDir(), ".claude", "settings.json");
  const text = (await readText(path)) ?? "{}";
  let settings: any;
  try {
    settings = JSON.parse(stripJsonComments(text));
  } catch {
    return `Could not parse ${path}; to skip Read prompts for saved results, add "${rule}" to permissions.allow.`;
  }
  const allow: string[] = Array.isArray(settings?.permissions?.allow) ? settings.permissions.allow : [];
  if (allow.includes(rule)) return `Saved results are already readable without a prompt (${rule}).`;

  const suggestion = `To skip the Read prompt for large saved results, add "${rule}" to permissions.allow in ${path}.`;
  if (yes || !process.stdin.isTTY) return suggestion;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let answer: string;
  try {
    answer = (
      await rl.question(
        `\nLarge tool results are saved under ${dir}.\nLet Claude Code read them without asking each time? Adds ${rule} [Y/n]: `,
      )
    ).trim().toLowerCase();
  } finally {
    rl.close();
  }
  if (answer && answer !== "y" && answer !== "yes") return suggestion;

  settings.permissions ??= {};
  settings.permissions.allow = [...allow, rule];
  await ensureDir(join(path, ".."));
  await writeText(path, `${JSON.stringify(settings, null, 2)}\n`);
  return `Allowed Claude Code to read saved results: ${rule} in ${path}`;
}

/**
 * Claude Code reads `~/x` as home-relative and `//x` as an absolute path; a
 * single leading slash would be taken relative to the settings file.
 */
export function readRulePath(dir: string): string {
  const home = homeDir();
  if (dir === home || dir.startsWith(`${home}/`)) return `~${dir.slice(home.length)}`;
  return `/${dir}`;
}

async function writeJsonServer(
  path: string,
  key: string,
  opts: { command: string; args: string[] },
  env: Record<string, string>,
): Promise<string> {
  await ensureDir(join(path, ".."));
  const existing = (await readText(path)) ?? "{}";
  let config: any;
  try {
    config = JSON.parse(existing);
  } catch {
    return `Could not parse ${path}; add the server manually.`;
  }
  config[key] ??= {};
  config[key].autorouter = {
    command: opts.command,
    args: opts.args,
    ...(Object.keys(env).length ? { env } : {}),
  };
  await writeText(path, `${JSON.stringify(config, null, 2)}\n`);
  return `Registered autorouter in ${path}`;
}

async function writeCodexServer(
  opts: { command: string; args: string[] },
  env: Record<string, string>,
): Promise<string> {
  const path = join(homeDir(), ".codex", "config.toml");
  await ensureDir(join(path, ".."));
  const text = (await readText(path)) ?? "";
  let config: any;
  try {
    config = text ? parseToml(text) : {};
  } catch {
    return `Could not parse ${path}; add [mcp_servers.autorouter] manually.`;
  }
  config.mcp_servers ??= {};
  config.mcp_servers.autorouter = {
    command: opts.command,
    args: opts.args,
    startup_timeout_sec: 60,
    ...(Object.keys(env).length ? { env } : {}),
  };
  await writeText(path, stringifyToml(config));
  return `Registered autorouter in ${path}`;
}

/**
 * Each harness reads persistent guidance from a different file. Without a
 * primer the model has no reason to search before concluding a task is
 * impossible, which is the main failure mode of a router.
 *
 * Claude Code is the exception: it injects the server's own instructions into
 * every request, so a primer there says the same thing twice on every call.
 * An existing block from an older init is removed instead.
 */
async function writePrimer(harness: Harness): Promise<string> {
  const targets: Record<Harness, string> = {
    claude: join(homeDir(), ".claude", "CLAUDE.md"),
    codex: join(homeDir(), ".codex", "AGENTS.md"),
    cursor: join(process.cwd(), ".cursor", "rules", "autorouter.mdc"),
    vscode: join(process.cwd(), ".github", "copilot-instructions.md"),
  };
  const path = targets[harness];
  await ensureDir(join(path, ".."));

  const current = (await readText(path)) ?? "";
  if (harness === "claude") return await removePrimer(path, current);
  const section =
    harness === "cursor"
      ? `---\ndescription: Capability router\nalwaysApply: true\n---\n\n${PRIMER}`
      : PRIMER;

  // Rewrite an existing block rather than skipping it. Returning early on the
  // marker means every machine that ran an older `init` keeps guidance that has
  // since gone stale — and the primer is the only thing telling the model the
  // router exists at all, so a stale one is a silent regression.
  const existing = /<!-- autorouter -->[\s\S]*?<!-- \/autorouter -->/.exec(current);
  if (existing) {
    if (existing[0] === PRIMER) return `Primer already current in ${path}`;
    await writeText(path, current.replace(existing[0], PRIMER));
    return `Updated router primer in ${path}`;
  }

  await writeText(path, current ? `${current.trimEnd()}\n\n${section}\n` : `${section}\n`);
  return `Added router primer to ${path}`;
}

const PRIMER_BLOCK = /\n*<!-- autorouter -->[\s\S]*?<!-- \/autorouter -->\n?/;

/** The text without the router's primer block, or null when there is none. */
export function stripPrimer(text: string): string | null {
  if (!PRIMER_BLOCK.test(text)) return null;
  const next = text.replace(PRIMER_BLOCK, "\n").replace(/\n{3,}$/, "\n");
  return next.trim() ? next : "";
}

async function removePrimer(path: string, current: string): Promise<string> {
  const next = stripPrimer(current);
  if (next === null) return "No primer needed: Claude Code reads the router's server instructions";
  await writeText(path, next);
  return `Removed the router primer from ${path}: Claude Code reads the router's server instructions`;
}

const PRIMER = `<!-- autorouter -->
## Capability router

Most tools, skills and MCP servers are behind \`find_capabilities\`: search it by
goal before deciding a task can't be done, then run a hit with
\`call_capability\`. Install MCP servers with \`autorouter add\`, not the harness's
own command, which loads every tool into context.
<!-- /autorouter -->`;

async function promptModel(harness: Harness, suggested: string | null): Promise<string | null> {
  if (!process.stdin.isTTY) return suggested;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(
      `\nThe router uses a small model to pick which capabilities fit a request.\n` +
        `It should be the cheapest model available in ${HARNESS_LABEL[harness]}.`,
    );
    const answer = (
      await rl.question(
        suggested
          ? `Selector model [${suggested}] (enter to accept, "none" to skip): `
          : "Selector model (blank to skip): ",
      )
    ).trim();
    if (answer.toLowerCase() === "none") return null;
    return answer || suggested;
  } finally {
    rl.close();
  }
}
