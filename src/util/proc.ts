import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

/**
 * Bun-free process helpers, for the same reason as util/fs.ts: the router is
 * bundled for the Node target so it can be launched with npx from harnesses
 * where Bun is not installed, so nothing below may use Bun.spawn / Bun.which.
 */

export type RunResult = { stdout: string; stderr: string; code: number | null };

/**
 * Run a command with `input` on stdin and capture its output.
 *
 * The prompt goes in on stdin rather than argv because candidate lists run to
 * thousands of characters and would risk the argument-length limit.
 */
export function run(
  command: string,
  args: string[],
  opts: { input?: string; env?: Record<string, string | undefined>; timeoutMs?: number } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: opts.env as NodeJS.ProcessEnv | undefined,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timer =
      opts.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, opts.timeoutMs);

    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (stdout += c));
    child.stderr.on("data", (c: string) => (stderr += c));

    child.on("error", (err) => done(() => reject(err)));
    child.on("close", (code) =>
      done(() =>
        timedOut
          ? reject(new Error(`${command} timed out after ${opts.timeoutMs}ms`))
          : resolve({ stdout, stderr, code }),
      ),
    );

    // A command that exits before reading its input (a bad flag, say) closes the
    // pipe under us; that surfaces as the non-zero exit, not as an EPIPE crash.
    child.stdin.on("error", () => {});
    if (opts.input !== undefined) child.stdin.write(opts.input);
    child.stdin.end();
  });
}

/**
 * Whether a command exists on PATH, without paying to start it.
 *
 * Node has no built-in equivalent of Bun.which, and shelling out to `which`
 * would cost the process startup this check exists to avoid.
 */
export function which(command: string): string | null {
  const isWindows = process.platform === "win32";
  const exts = isWindows
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [""];

  const candidates = isAbsolute(command) || command.includes("/") || command.includes("\\")
    ? [command]
    : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, command));

  for (const candidate of candidates) {
    for (const ext of exts) {
      const path = candidate + ext;
      try {
        accessSync(path, constants.X_OK);
        return path;
      } catch {
        // Not here, or not executable; keep looking.
      }
    }
  }
  return null;
}
