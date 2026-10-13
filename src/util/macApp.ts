import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

/**
 * Names the macOS app a stdio command would open, or null when it is an
 * ordinary executable.
 *
 * Desktop apps register their own internals as MCP servers — the Codex app
 * lists the ChatGPT binary itself as `cua_repl` — and running a regular app's
 * main executable does not start a server, it opens the app in the user's face,
 * on every index. Helpers that genuinely serve MCP from inside a bundle
 * (Codex's SkyComputerUseClient, cmux's Computer Use helper) are agent apps
 * marked LSUIElement, so only a regular, Dock-visible app's main executable is
 * treated as a launch.
 */
export async function regularAppFor(command: string, cwd?: string): Promise<string | null> {
  if (process.platform !== "darwin" || !command.includes("/")) return null;
  let path: string;
  try {
    path = await realpath(resolve(cwd ?? process.cwd(), command));
  } catch {
    return null;
  }
  const match = /^(.*\.app)\/Contents\/MacOS\/([^/]+)$/.exec(path);
  if (!match) return null;
  const [, bundle, exe] = match as unknown as [string, string, string];
  const info = await readPlist(join(bundle, "Contents", "Info.plist"));
  if (!info || info.CFBundleExecutable !== exe) return null;
  if (truthy(info.LSUIElement) || truthy(info.LSBackgroundOnly)) return null;
  return basename(bundle, ".app");
}

function truthy(v: unknown): boolean {
  return v === true || v === "1" || v === 1 || v === "YES" || v === "true";
}

/** Info.plist may be XML or binary; plutil reads either. */
function readPlist(path: string): Promise<Record<string, unknown> | null> {
  return new Promise((done) => {
    execFile("plutil", ["-convert", "json", "-o", "-", path], { timeout: 5_000 }, (err, stdout) => {
      if (err) return done(null);
      try {
        done(JSON.parse(stdout) as Record<string, unknown>);
      } catch {
        done(null);
      }
    });
  });
}
