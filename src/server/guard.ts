import type { Capability } from "../catalog/types.ts";
import { matchesPattern } from "../catalog/types.ts";
import type { RouterConfig } from "../config/types.ts";

/**
 * Routing costs the host permission layer its granularity: it sees
 * `call_capability`, not `supabase/execute_sql`. This is a real trade-off, not
 * something to paper over. Two mitigations:
 *   - `exclude` capabilities never appear in search results at all.
 *   - `confirm` capabilities reject the first call with the resolved target
 *     spelled out, forcing a second, explicit invocation.
 */
export class Guard {
  constructor(private config: RouterConfig) {}

  requiresConfirmation(cap: Capability): boolean {
    return this.config.confirm.some((p) => matchesPattern(cap.id, p));
  }

  isExcluded(id: string): boolean {
    return this.config.exclude.some((p) => matchesPattern(id, p));
  }

  isAlwaysExposed(id: string): boolean {
    return this.config.alwaysExpose.some((p) => matchesPattern(id, p));
  }

  confirmationMessage(cap: Capability, args: unknown): string {
    return [
      `Confirmation required before running ${cap.id}.`,
      cap.server ? `This calls "${cap.name}" on the "${cap.server}" server.` : "",
      `Arguments: ${truncate(JSON.stringify(args ?? {}), 500)}`,
      "",
      "If this is intended, call call_capability again with confirm: true.",
      "If it is not, tell the user what was about to run instead of retrying.",
    ]
      .filter(Boolean)
      .join("\n");
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
