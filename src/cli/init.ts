import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { ensureDir, readText, writeText } from "../util/fs.ts";
import { suggestModel } from "../selector/backends.ts";
import { homeDir } from "../util/paths.ts";

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
  return notes;
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
  if (current.includes("<!-- autorouter -->")) return `Primer already present in ${path}`;

  const section =
    harness === "cursor"
      ? `---\ndescription: Capability router\nalwaysApply: true\n---\n\n${PRIMER}`
      : PRIMER;
  await writeText(path, current ? `${current.trimEnd()}\n\n${section}\n` : `${section}\n`);
  return `Added router primer to ${path}`;
}

const PRIMER = `<!-- autorouter -->
## Capability router

Most tools, skills and commands on this machine are not in your tool list. They
are behind \`find_capabilities\`.

Before deciding a task cannot be done, or reaching for a manual workaround, call
\`find_capabilities({ query: "<what you are trying to do>" })\`. It searches every
configured MCP server, skill and plugin command and returns only what fits.
Then \`describe_capability\` for the schema, and \`call_capability\` to run it.
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
