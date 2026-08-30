import { resolveConfig } from "../config/resolve.ts";
import { removeServer, upsertServers } from "../config/write.ts";
import { normalizeServer, isSelfReference, type RawServer } from "../config/adapters/shared.ts";
import { connect, enumerateServer } from "../catalog/providers/mcp.ts";
import { authHint } from "../config/oauth.ts";
import { Router } from "../router.ts";

export type AddSpec = {
  name?: string;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  /** A pasted vendor snippet: either a bare entry or an `mcpServers` wrapper. */
  json?: string;
};

export type AddResult = {
  ok: boolean;
  name: string;
  /** Human-readable target, for confirmation prompts and output. */
  target: string;
  path?: string;
  capabilities?: number;
  message: string;
};

/**
 * Parses whatever the user had to hand into one named server entry.
 *
 * The `--json` path exists because that is the form vendors actually publish:
 * every "add this to your MCP client" doc is an `mcpServers` block, and
 * retyping it as flags is where the transcription errors come from. Both the
 * wrapper and a bare entry are accepted, since people paste either.
 */
export function parseAddSpec(spec: AddSpec): { name: string; raw: RawServer } {
  if (spec.json) {
    let parsed: any;
    try {
      parsed = JSON.parse(spec.json);
    } catch (err) {
      throw new Error(`--json is not valid JSON: ${err instanceof Error ? err.message : err}`);
    }
    const servers = parsed?.mcpServers ?? parsed?.servers;
    if (servers && typeof servers === "object") {
      const entries = Object.entries(servers as Record<string, RawServer>);
      if (entries.length !== 1 && !spec.name) {
        throw new Error(
          `--json holds ${entries.length} servers; name the one you want: autorouter add <name> --json '…'`,
        );
      }
      const picked = spec.name
        ? entries.find(([n]) => n === spec.name)
        : entries[0];
      if (!picked) throw new Error(`--json has no server named "${spec.name}".`);
      return { name: spec.name ?? picked[0], raw: picked[1] };
    }
    if (!spec.name) throw new Error("A name is required: autorouter add <name> --json '…'");
    return { name: spec.name, raw: parsed as RawServer };
  }

  if (!spec.name) throw new Error("A name is required: autorouter add <name> --url … | --command …");
  if (!spec.url && !spec.command) {
    throw new Error(`Nothing to register: pass --url, --command, or -- <command> <args…>`);
  }
  return {
    name: spec.name,
    raw: {
      ...(spec.url ? { url: spec.url, headers: spec.headers } : {}),
      ...(spec.command ? { command: spec.command, args: spec.args ?? [] } : {}),
      ...(spec.env ? { env: spec.env } : {}),
    },
  };
}

/** What the entry will actually launch or reach, for a confirmation prompt. */
export function describeSpec(raw: RawServer): string {
  return raw.url ? raw.url : `${raw.command} ${(raw.args ?? []).join(" ")}`.trim();
}

/**
 * Registers a server directly with the router.
 *
 * The write happens before the connection check on purpose. The most common
 * reason a new server fails to enumerate is that it has no OAuth grant yet, and
 * `autorouter login <name>` needs the entry to exist before it can authorize it
 * — refusing to save an unreachable server would make the recovery step
 * impossible to reach.
 */
export async function runAdd(spec: AddSpec, cwd = process.cwd()): Promise<AddResult> {
  const { name, raw } = parseAddSpec(spec);
  const target = describeSpec(raw);

  const entry = normalizeServer(name, raw, "config");
  if (!entry) {
    return { ok: false, name, target, message: `Could not read a server out of that: ${target || "(empty)"}` };
  }
  if (isSelfReference(entry)) {
    return {
      ok: false,
      name,
      target,
      message: `"${target}" launches autorouter itself. Registering the router with the router would recurse forever.`,
    };
  }

  const resolved = await resolveConfig(cwd);
  const path = await upsertServers({ [name]: raw }, {
    configPath: resolved.configPath,
    overwrite: true,
  });

  let client;
  let capabilities: number | undefined;
  let failure: string | undefined;
  try {
    client = await connect(entry);
    capabilities = (await enumerateServer(entry, client)).length;
  } catch (err) {
    failure = authHint(name, err);
  } finally {
    try {
      await client?.close();
    } catch {}
  }

  if (failure) {
    return {
      ok: false,
      name,
      target,
      path,
      message: `Registered ${name} in ${path}, but it did not answer: ${failure}`,
    };
  }

  // Rebuild now rather than waiting out the TTL, so the very next search sees
  // it. A running serve process picks the same change up from the config file's
  // fingerprint.
  const router = await Router.create({ cwd, force: true });
  await router.close();

  return {
    ok: true,
    name,
    target,
    path,
    capabilities,
    message: `Added ${name} → ${target}\n  ${capabilities} capabilities, registered in ${path}`,
  };
}

export async function runRemove(name: string, cwd = process.cwd()): Promise<string> {
  const resolved = await resolveConfig(cwd);
  const { removed, path } = await removeServer(name, resolved.configPath);
  if (!removed) return `No server named "${name}" in ${path}.`;

  // A server the router imports from a harness is not the router's to delete.
  // Saying so here is cheaper than the user discovering it on the next search.
  const stillImported = (await resolveConfig(cwd)).servers.some((s) => s.name === name);
  return stillImported
    ? `Removed ${name} from ${path}, but a harness still registers it — it will keep appearing. ` +
        `Add "${name}/*" to "exclude" to hide it entirely.`
    : `Removed ${name} from ${path}.`;
}
