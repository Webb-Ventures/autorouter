import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import type { ServerEntry } from "../types.ts";
import { normalizeServer } from "./shared.ts";
import { exists } from "../../util/fs.ts";

const BUNDLE_ID = "com.cmuxterm.app";
const APP_BIN = "/Applications/cmux.app/Contents/Resources/bin";

/**
 * The cmux terminal's Computer Use server never appears in a config file: cmux
 * hands it to each agent it launches as `claude --mcp-config '{...}'`, so no
 * importer can see it. What does persist is the daemon socket the injected
 * entry proxies to, which is all a router-launched copy needs.
 */
export function cmuxSocketPath(): string {
  return (
    process.env.CMUX_CUA_SOCKET_PATH ||
    join(tmpdir(), `cmux-cua-${userInfo().uid}`, BUNDLE_ID, "cmux-cua.sock")
  );
}

/**
 * Rebuilds the entry cmux injects. The socket must exist — without a running
 * cmux the binary would start its own daemon and prompt for permissions under
 * whichever app launched the router.
 */
export async function loadCmux(): Promise<ServerEntry[]> {
  if (process.platform !== "darwin") return [];
  const socket = cmuxSocketPath();
  const binDir = process.env.CMUX_BUNDLED_CLI_PATH ? dirname(process.env.CMUX_BUNDLED_CLI_PATH) : APP_BIN;
  const command = join(binDir, "cmux-cua");
  if (!(await exists(socket)) || !(await exists(command))) return [];

  const env: Record<string, string> = {
    CMUX_CUA_MCP_FORCE_PROXY: "1",
    CMUX_CUA_EXTERNAL_PERMISSION_FLOW: "1",
    CMUX_CUA_TELEMETRY_ENABLED: "false",
    CMUX_CUA_UPDATE_CHECK: "false",
  };
  // Inside a cmux pane, share the pane's cursor session so the router's actions
  // show up as the same agent as the harness's own.
  if (process.env.CMUX_SURFACE_ID) env.CMUX_CUA_DEFAULT_SESSION = `cmux-${process.env.CMUX_SURFACE_ID}`;

  const entry = normalizeServer("cmux-cua", { command, args: ["mcp", "--socket", socket], env }, "cmux");
  return entry ? [entry] : [];
}
