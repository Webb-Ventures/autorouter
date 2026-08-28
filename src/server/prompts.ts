import type { Prompt, PromptMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Capability } from "../catalog/types.ts";
import { clamp } from "../util/compact.ts";

/**
 * Slash commands, via MCP prompts.
 *
 * Claude Code will not accept slash commands over MCP — it reads `commands/*.md`
 * off disk, which a router cannot contribute to. What it *does* surface as slash
 * commands are MCP prompts, as `/mcp__autorouter__<name>`. So every instruction-
 * style capability in the catalog (skills, plugin commands, subagents) is
 * published as a prompt, and adopting a plugin into the router keeps its slash
 * commands working instead of silently dropping them.
 *
 * Tools are deliberately absent. A prompt returns text for the model to act on;
 * it cannot return a tool result, so exposing `execute_sql` here would produce a
 * slash command that looks callable and does nothing. Tools reach the model
 * through search and activation instead.
 */
export const INSTRUCTION_KINDS = new Set(["skill", "command", "agent"]);

/** The search entry point, so `/mcp__autorouter__find <query>` works. */
export const FIND_PROMPT = "find";

/**
 * Prose budget for a slash command's description.
 *
 * The prompt list is permanent context — the host fetches it once and carries it
 * for the session, so every character here is paid on every turn. A skill
 * description is written to be read by a human browsing a marketplace and runs
 * to several hundred characters; what a model needs is enough to decide whether
 * to invoke it, and invoking it delivers the full body anyway. Measured across
 * this machine's catalog, clamping here roughly halves the permanent cost of the
 * prompt list at no cost to selection.
 */
const DESCRIPTION_CHARS = 180;

export function promptList(capabilities: Capability[]): Prompt[] {
  const prompts: Prompt[] = [
    {
      name: FIND_PROMPT,
      description: "Search every available tool, skill and command by what you want to do.",
      arguments: [{ name: "query", description: "What you are trying to accomplish.", required: true }],
    },
  ];

  const seen = new Set<string>([FIND_PROMPT]);
  for (const cap of capabilities) {
    if (!INSTRUCTION_KINDS.has(cap.kind)) continue;
    const name = uniquePromptName(cap, seen);
    seen.add(name);
    prompts.push({
      name,
      description: clamp(cap.description || `${cap.kind} ${cap.name}`, DESCRIPTION_CHARS),
      arguments: [
        {
          name: "arguments",
          // Plugin commands declare `argument-hint` for exactly this; passing it
          // through is what makes the router's slash command look like the one
          // it replaced.
          description: cap.argumentHint ?? "Optional arguments.",
          required: false,
        },
      ],
    });
  }
  return prompts;
}

/**
 * MCP prompt names allow only [a-zA-Z0-9_-], while capability ids carry the ":"
 * and "/" of their namespace. Collisions are possible once two plugins both
 * ship a "setup" command, so the plugin prefix is kept and a numeric suffix is
 * the last resort — a silently shadowed slash command is worse than an ugly one.
 */
export function promptName(cap: Capability): string {
  const raw = cap.server ? `${cap.server}_${cap.name}` : cap.name;
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_").slice(0, 64) || cap.kind;
}

function uniquePromptName(cap: Capability, taken: Set<string>): string {
  const base = promptName(cap);
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base.slice(0, 60)}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return base;
}

/** Resolves a prompt name back to the capability that produced it. */
export function capabilityForPrompt(
  capabilities: Capability[],
  name: string,
): Capability | undefined {
  const seen = new Set<string>([FIND_PROMPT]);
  for (const cap of capabilities) {
    if (!INSTRUCTION_KINDS.has(cap.kind)) continue;
    const promptName = uniquePromptName(cap, seen);
    seen.add(promptName);
    if (promptName === name) return cap;
  }
  return undefined;
}

/**
 * Builds the messages for an invoked prompt.
 *
 * The body is substituted the way Claude Code substitutes a command file:
 * `$ARGUMENTS` for everything passed, `$1`..`$9` positionally. A command body
 * written for the native loader therefore behaves identically here, which is the
 * whole point — the user should not be able to tell the router replaced it.
 */
export function promptMessages(
  cap: Capability,
  body: string | undefined,
  args: Record<string, string>,
): PromptMessage[] {
  const raw = (args.arguments ?? "").trim();
  const text = body?.trim()
    ? substitute(body.trim(), raw)
    : `${cap.id} has no instruction body. Its description is: ${cap.description}`;

  const header = `Follow these ${cap.kind} instructions (${cap.id}).`;
  const trailer = raw && !mentionsArguments(body ?? "")
    ? `\n\nArguments provided: ${raw}`
    : "";
  return [
    { role: "user", content: { type: "text", text: `${header}\n\n${text}${trailer}` } },
  ];
}

function substitute(body: string, raw: string): string {
  const positional = raw.split(/\s+/).filter(Boolean);
  return body
    .replace(/\$ARGUMENTS\b/g, raw)
    .replace(/\$(\d)\b/g, (_, d: string) => positional[Number(d) - 1] ?? "");
}

/**
 * Whether the body consumes its arguments itself. When it does not, they are
 * appended — otherwise a user who typed `/cmd foo` would watch the argument
 * vanish with no indication it was ignored.
 */
function mentionsArguments(body: string): boolean {
  return /\$ARGUMENTS\b|\$\d\b/.test(body);
}
