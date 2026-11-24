import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { connect, enumerateServer } from "../catalog/providers/mcp.ts";
import { runStreaming } from "../util/proc.ts";
import type { ServerEntry } from "../config/types.ts";
import type { LoginResult } from "./login.ts";

/**
 * `autorouter login` for a local (stdio) server.
 *
 * There is no grant for the router to obtain here: a local server keeps its own
 * credentials, wherever its vendor decided they go, and signs in on its own
 * terms — a companion command (`railway login`, `firebase login`) or a browser
 * flow it starts the first time it runs. The router launches these servers in
 * the background with stderr captured, which is exactly where neither can
 * happen. So login does the two things that need a terminal:
 *
 *   1. runs the server's sign-in command, attached, when there is one, and
 *   2. starts the server in the foreground and waits for it to answer, with its
 *      stderr visible and enough time for a human to finish a browser flow.
 *
 * Nothing is stored. The credentials stay where the server put them.
 */

type StdioEntry = Extract<ServerEntry, { transport: "stdio" }>;

/** How long a server may take to finish a sign-in it started itself. Matches the OAuth callback wait. */
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

export async function runLocalLogin(
  entry: StdioEntry,
  opts: {
    /** Sign-in command for this run (the argv after `--`); overrides the configured one. */
    command?: string[];
    /** Overrides the wait for a server signing in by itself. For tests. */
    timeoutMs?: number;
  } = {},
): Promise<LoginResult> {
  const command = opts.command?.length ? opts.command : entry.login;
  // The server's own env block applies to its sign-in command too: that is
  // where a config dir or profile name lives, and signing in to a different
  // profile than the server reads would look like success and change nothing.
  const env = { ...process.env, ...(entry.env ?? {}) };

  if (command?.length) {
    const shown = command.join(" ");
    console.log(`Signing in to ${entry.name} with: ${shown}\n`);
    let code: number | null;
    try {
      code = await runStreaming(command[0]!, command.slice(1), { cwd: entry.cwd, env });
    } catch (err) {
      const missing = (err as NodeJS.ErrnoException)?.code === "ENOENT";
      return {
        ok: false,
        message: missing
          ? `${entry.name}: could not run \`${shown}\` — ${command[0]} was not found on PATH.`
          : `${entry.name}: could not run \`${shown}\`: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (code !== 0) {
      return {
        ok: false,
        message: `${entry.name}: \`${shown}\` ${code === null ? "was interrupted" : `exited with code ${code}`}, so it is not signed in.`,
      };
    }
    console.log("");
  } else {
    console.log(
      `Starting ${entry.name} in the foreground: ${[entry.command, ...entry.args].join(" ")}\n` +
        `  If it signs in on first run, the URL or code it prints appears below.\n`,
    );
  }

  let client: Client | undefined;
  try {
    // After a sign-in command the server has nothing left to wait for, so the
    // ordinary startup timeout applies. Without one, the launch *is* the login.
    client = await connect(entry, command?.length ? undefined : (opts.timeoutMs ?? SIGN_IN_TIMEOUT_MS), {
      interactive: true,
    });
    const count = (await enumerateServer(entry, client)).length;
    const answers = `it answers with ${count} capabilit${count === 1 ? "y" : "ies"}`;
    if (command?.length) {
      return { ok: true, authorized: true, message: `${entry.name}: signed in — ${answers}.` };
    }
    return {
      ok: true,
      authorized: true,
      message:
        `${entry.name}: started — ${answers}.\n` +
        `  A local server keeps its own credentials, so starting is all the router can see.\n` +
        `  If its tools still report that you are signed out, run its sign-in command here:\n` +
        `    autorouter login ${entry.name} -- <command>      e.g. -- railway login`,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message:
        `${entry.name}: ${command?.length ? "the sign-in command succeeded, but the server" : "the server"} did not start: ${reason}` +
        (command?.length
          ? ""
          : `\n  If it signs in through a separate command, pass it: autorouter login ${entry.name} -- <command>`),
    };
  } finally {
    await client?.close().catch(() => {});
  }
}
