import type { Implementation, ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";

export type ClientProfile = {
  name: string;
  version: string;
  /** Whether the client refetches tools on notifications/tools/list_changed. */
  supportsListChanged: boolean;
  supportsSampling: boolean;
  /** Human-readable reason, surfaced by `doctor`. */
  rationale: string;
};

/**
 * Clients advertise almost nothing useful in `initialize`, so dynamic-tool
 * support has to be inferred from the client name and version. Getting this
 * wrong in the optimistic direction is the bad failure: the model activates a
 * tool that never appears and gets stuck. So the default is proxy-only, and
 * only known-good clients opt in.
 *
 * Known-good: Claude Code >= 2.1.232, GitHub Copilot, opencode.
 * Known-bad:  Codex, Gemini CLI, Claude Desktop, Vercel AI SDK.
 */
export function profileClient(
  info: Implementation | undefined,
  caps: ClientCapabilities | undefined,
): ClientProfile {
  const name = (info?.name ?? "unknown").toLowerCase();
  const version = info?.version ?? "0.0.0";
  const override = process.env.AUTOROUTER_DYNAMIC?.toLowerCase();

  let supportsListChanged = false;
  let rationale = `${info?.name ?? "unknown"} is not known to honour tools/list_changed; using proxy dispatch`;

  if (name.includes("claude-code") || name.includes("claude code")) {
    if (compareVersions(version, "2.1.232") >= 0) {
      supportsListChanged = true;
      rationale = `Claude Code ${version} refreshes on tools/list_changed`;
    } else {
      rationale = `Claude Code ${version} predates reliable list_changed support (needs >= 2.1.232)`;
    }
  } else if (name.includes("copilot") || name.includes("opencode")) {
    supportsListChanged = true;
    rationale = `${info?.name} honours tools/list_changed`;
  } else if (name.includes("codex") || name.includes("gemini") || name.includes("claude-ai")) {
    rationale = `${info?.name} does not implement tools/list_changed; using proxy dispatch`;
  }

  if (override === "on") {
    supportsListChanged = true;
    rationale = "forced on via AUTOROUTER_DYNAMIC=on";
  } else if (override === "off") {
    supportsListChanged = false;
    rationale = "forced off via AUTOROUTER_DYNAMIC=off";
  }

  return {
    name: info?.name ?? "unknown",
    version,
    supportsListChanged,
    supportsSampling: Boolean(caps?.sampling),
    rationale,
  };
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}
