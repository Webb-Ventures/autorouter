/**
 * Scope selection for OAuth servers.
 *
 * A grant obtained with dynamic client registration defaults to everything the
 * provider advertises, which for Supabase means database:write and
 * edge_functions:write — the router would hold a credential able to drop tables
 * on behalf of a search tool. The scopes are the only enforcement point that
 * survives a prompt injection, so they are worth choosing deliberately.
 */

/**
 * Scope names that grant mutation. Best-effort: it recognises the conventions
 * providers actually use (`projects:write`, `write:issues`, `admin.foo`,
 * `mcp_all`) but cannot see through an opaque name like GitHub's `repo`, which
 * grants write while reading as neutral. `--scopes` is the exact lever when the
 * heuristic guesses wrong; this only decides what `--read-only` keeps.
 */
const MUTATING = /(^|[:._\-\/])(write|admin|manage|delete|destroy|create|update|modify|readwrite|rw|full|all)([:._\-\/]|$)/i;

export function isReadOnlyScope(scope: string): boolean {
  return !MUTATING.test(scope);
}

/**
 * The read-only subset, or an empty array when the provider offers no such
 * subset. Empty is a meaningful answer — Datadog publishes exactly one scope
 * (`mcp_all`) — and the caller must say so rather than silently requesting
 * nothing, which most providers treat as "request the default", i.e. all of it.
 */
export function readOnlyScopes(advertised: string[]): string[] {
  return advertised.filter(isReadOnlyScope);
}

/** Accepts "a,b" or "a b" or a mix, the way people actually type lists. */
export function parseScopeList(input: string): string[] {
  return input.split(/[\s,]+/).filter(Boolean);
}

/**
 * Names the user asked for that the server never advertised. Requesting an
 * unknown scope is rejected outright by some providers and silently dropped by
 * others, so it is worth catching before a browser opens.
 */
export function unknownScopes(requested: string[], advertised: string[]): string[] {
  if (!advertised.length) return []; // Nothing to check against.
  const known = new Set(advertised);
  return requested.filter((s) => !known.has(s));
}
