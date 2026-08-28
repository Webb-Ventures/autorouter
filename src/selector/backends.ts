import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { SelectorBackend } from "./types.ts";
import type { SelectorConfig as Cfg } from "../config/types.ts";
import { readCodexModel } from "../config/adapters/codex.ts";
import { run, which as whichPath } from "../util/proc.ts";

/**
 * Backend 1 — MCP sampling. The host runs the completion with the user's own
 * session and credentials, so there is no API key to configure and no separate
 * bill. costPriority: 1 asks the host for its cheapest model, which is exactly
 * the "use whatever is cheapest in this harness" requirement.
 *
 * Support is uneven (Claude Code and Codex are limited), so this backend
 * reports itself unavailable unless the client declared the capability.
 */
export function samplingBackend(server: Server): SelectorBackend | null {
  const caps = server.getClientCapabilities();
  if (!caps?.sampling) return null;
  return {
    id: "sampling",
    async complete(system, user, timeoutMs) {
      const res = await server.createMessage(
        {
          messages: [{ role: "user", content: { type: "text", text: user } }],
          systemPrompt: system,
          maxTokens: 1024,
          temperature: 0,
          modelPreferences: {
            // Ranking a short list is a cheap task; ask for the cheap model.
            costPriority: 1,
            speedPriority: 0.9,
            intelligencePriority: 0.2,
          },
        },
        { timeout: timeoutMs },
      );
      const content: any = res.content;
      return content?.type === "text" ? content.text : "";
    },
  };
}

/**
 * Backend 2 — the harness's own CLI, run headless.
 *
 * This is the backend that actually fires on a normal machine. MCP sampling is
 * the clean answer and almost nothing implements it: Claude Code does not
 * declare the capability, so `samplingBackend` returns null. The API backend
 * then asks for an `ANTHROPIC_API_KEY` that a Claude Code user has no reason to
 * possess — they authenticated with a subscription login, not a key — and the
 * router degrades to raw index order while telling them to go get one.
 *
 * But the credential is right there: `claude` and `codex` are on PATH and
 * already logged in. Shelling out to them in headless mode reuses that login
 * exactly as the "use whatever is cheapest in this harness" requirement
 * intended, with no key to configure and no separate bill.
 *
 * The cost is process startup — a few seconds per call against ~1s for a direct
 * API request. That is why a configured API key still wins in `auto`: this is the
 * fallback that makes the router work out of the box, not the fast path.
 */
export function cliBackend(cfg: Cfg, harness: string): SelectorBackend | null {
  const spec = cliSpec(cfg, harness);
  if (!spec) return null;
  return {
    id: "cli",
    model: `${spec.command}${spec.model ? ` (${spec.model})` : ""}`,
    // Measured at 2.5-5s for a 30-candidate list against `claude -p --model
    // haiku`, most of it process startup rather than inference. The floor is set
    // well above that: a cold npm/bun resolve on the first call of a session is
    // slower than any steady-state measurement, and a timeout here is
    // indistinguishable to the user from having no selector at all.
    minTimeoutMs: 30_000,
    async complete(system, user, timeoutMs) {
      const res = await run(spec.command, spec.args, {
        // The prompt goes in on stdin rather than argv: candidate lists run to
        // thousands of characters and would risk the argument-length limit.
        input: `${system}\n\n${user}`,
        // A selector subprocess must never inherit the router's own MCP wiring,
        // or it would load the very catalog the router exists to keep out of
        // context — and on a bad day recurse into the router itself.
        env: { ...process.env, ...spec.env },
        timeoutMs,
      });
      if (res.code !== 0) {
        throw new Error(`${spec.command} exited ${res.code}: ${res.stderr.trim().slice(0, 200)}`);
      }
      return res.stdout;
    },
  };
}

type CliSpec = { command: string; args: string[]; model?: string; env?: Record<string, string> };

/**
 * Empty MCP config, per harness.
 *
 * The selector's job is to rank a list of strings, so every downstream server
 * the harness would otherwise start is pure latency — and in the router's case a
 * recursion hazard, since one of those servers is the router itself.
 */
const MCP_OFF = ["--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'];
const MCP_OFF_CODEX = ["-c", "mcp_servers={}"];

/**
 * How to invoke each harness headlessly.
 *
 * Both are stripped down to the same shape: no MCP servers, no tools, no session
 * persistence, and the account's own default model unless one is configured.
 */
function cliSpec(cfg: Cfg, harness: string): CliSpec | null {
  const explicit = cfg.cliCommand;
  // The harness name identifies the user's own login, so it is the first
  // choice. But it is often absent — `autorouter search` from a shell reports
  // "cli", and an unrecognised MCP client reports its own name — and in that
  // case any installed harness CLI still carries a usable login. Falling back
  // to whatever is on PATH is what makes the selector work from the terminal
  // rather than only from inside a supported host.
  const h = (isKnownHarness(harness) ? harness : detectHarness() ?? harness).toLowerCase();

  if (explicit ? /claude/.test(explicit) : h.includes("claude") || h.includes("cursor")) {
    const command = explicit ?? "claude";
    if (!which(command)) return null;
    // Ranking a short list is the cheapest task in the system; ask for the
    // cheapest model rather than whatever the user's session defaults to.
    const model = cfg.model ?? "haiku";
    return {
      command,
      args: [
        "-p",
        "--model", model,
        // Skip hooks, LSP, plugin sync, keychain reads and CLAUDE.md discovery.
        // None of it helps rank a list of strings, and together it is most of
        // what a headless Claude Code run spends its startup on.
        "--bare",
        "--setting-sources", "",
        "--no-session-persistence",
        // The selector must not be able to *act*. An empty tool list is a
        // correctness guarantee first — a subprocess that can edit files is a
        // different program than a reranker — and a large saving second, since
        // the built-in tool definitions dwarf the candidate list they would be
        // reasoning about.
        "--tools", "",
        ...MCP_OFF,
      ],
      model,
      // Extended thinking is actively harmful here and expensive: measured on a
      // 30-candidate list, Haiku spent 6,223 output tokens deliberating for 22s
      // and returned a *worse* answer than the 168-token, 3.7s response it gives
      // with thinking off. Ranking a short list against a one-line request is a
      // recall task, not a reasoning one.
      env: { MAX_THINKING_TOKENS: "0" },
    };
  }

  if (explicit ? /codex/.test(explicit) : h.includes("codex") || h.includes("chatgpt")) {
    const command = explicit ?? "codex";
    if (!which(command)) return null;
    return {
      command,
      args: [
        "exec",
        "--skip-git-repo-check",
        // No session file for a throwaway ranking, and no shell access: the
        // selector returns JSON, so anything it could execute is a bug.
        "--ephemeral",
        "-s", "read-only",
        // No -m unless the user asked for one. Codex rejects model names its
        // account plan does not carry — `gpt-5.1-codex-mini` fails outright on a
        // ChatGPT login — so the account default is the only safe choice.
        ...(cfg.model ? ["-m", cfg.model] : []),
        ...MCP_OFF_CODEX,
      ],
      ...(cfg.model ? { model: cfg.model } : {}),
    };
  }

  return null;
}

/** Whether a command exists on PATH, without paying to start it. */
function which(command: string): boolean {
  return Boolean(whichPath(command));
}

const HARNESS_CLIS: Array<{ match: string; command: string }> = [
  { match: "claude", command: "claude" },
  { match: "codex", command: "codex" },
];

function isKnownHarness(harness: string): boolean {
  const h = harness.toLowerCase();
  return HARNESS_CLIS.some((c) => h.includes(c.match)) || h.includes("cursor") || h.includes("chatgpt");
}

/** First harness CLI found on PATH, for callers that cannot name their own. */
function detectHarness(): string | null {
  for (const { match, command } of HARNESS_CLIS) {
    if (which(command)) return match;
  }
  return null;
}

/** Backend 3 — direct API call, provider inferred from the harness. */
export function apiBackend(cfg: Cfg, harness: string): SelectorBackend | null {
  // A configured model name identifies its provider more reliably than the
  // harness does, so it wins when present.
  const provider = cfg.provider ?? providerForModel(cfg.model) ?? inferProvider(harness);
  if (!provider) return null;

  switch (provider) {
    case "anthropic": {
      const key = process.env[cfg.apiKeyEnv ?? "ANTHROPIC_API_KEY"];
      if (!key) return null;
      const model = cfg.model ?? "claude-haiku-4-5-20251001";
      return {
        id: "anthropic",
        model,
        async complete(system, user, timeoutMs) {
          const res = await fetchJson(
            cfg.baseUrl ?? "https://api.anthropic.com/v1/messages",
            {
              "content-type": "application/json",
              "x-api-key": key,
              "anthropic-version": "2023-06-01",
            },
            {
              model,
              max_tokens: 1024,
              temperature: 0,
              system,
              messages: [{ role: "user", content: user }],
            },
            timeoutMs,
          );
          return (res?.content ?? [])
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("");
        },
      };
    }
    case "openai":
    case "openai-compatible": {
      const key = process.env[cfg.apiKeyEnv ?? "OPENAI_API_KEY"];
      const base = cfg.baseUrl ?? "https://api.openai.com/v1";
      if (provider === "openai" && !key) return null;
      const model = cfg.model ?? "gpt-5.6-mini";
      return {
        id: provider,
        model,
        async complete(system, user, timeoutMs) {
          const res = await fetchJson(
            `${base.replace(/\/$/, "")}/chat/completions`,
            {
              "content-type": "application/json",
              ...(key ? { authorization: `Bearer ${key}` } : {}),
            },
            {
              model,
              temperature: 0,
              messages: [
                { role: "system", content: system },
                { role: "user", content: user },
              ],
            },
            timeoutMs,
          );
          return res?.choices?.[0]?.message?.content ?? "";
        },
      };
    }
    case "ollama": {
      const base = cfg.baseUrl ?? "http://127.0.0.1:11434";
      const model = cfg.model ?? "llama3.2";
      return {
        id: "ollama",
        model,
        async complete(system, user, timeoutMs) {
          const res = await fetchJson(
            `${base.replace(/\/$/, "")}/api/chat`,
            { "content-type": "application/json" },
            {
              model,
              stream: false,
              options: { temperature: 0 },
              messages: [
                { role: "system", content: system },
                { role: "user", content: user },
              ],
            },
            timeoutMs,
          );
          return res?.message?.content ?? "";
        },
      };
    }
    default:
      return null;
  }
}

/**
 * Maps the detected harness to its native provider so the selector runs on the
 * same vendor the user is already paying for. Falls back to whichever key is
 * present in the environment.
 */
/** "claude-haiku-4-5" -> anthropic, "gpt-5.6-mini" -> openai, "llama3.2" -> ollama. */
export function providerForModel(model: string | undefined): Cfg["provider"] | null {
  if (!model) return null;
  const m = model.toLowerCase();
  if (m.startsWith("claude") || m.includes("anthropic")) return "anthropic";
  if (m.startsWith("gpt") || m.startsWith("o1") || m.startsWith("o3") || m.startsWith("o4")) return "openai";
  if (m.startsWith("llama") || m.startsWith("qwen") || m.startsWith("mistral") || m.startsWith("gemma")) {
    return "ollama";
  }
  return null;
}

export function inferProvider(harness: string): Cfg["provider"] | null {
  const h = harness.toLowerCase();
  if (h.includes("claude")) {
    if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  }
  if (h.includes("codex") || h.includes("chatgpt")) {
    if (process.env.OPENAI_API_KEY) return "openai";
  }
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.OLLAMA_HOST) return "ollama";
  return null;
}

/**
 * Best-effort cheap-model name for the harness the router is running under, so
 * `init` can pre-fill the right default instead of asking blindly.
 */
export async function suggestModel(harness: string): Promise<string | null> {
  const h = harness.toLowerCase();
  if (h.includes("claude")) return "claude-haiku-4-5-20251001";
  if (h.includes("codex") || h.includes("chatgpt")) {
    const configured = await readCodexModel();
    // Map the user's chosen tier down to its mini sibling when we can.
    if (configured?.startsWith("gpt-5")) return "gpt-5.6-mini";
    return configured ?? "gpt-5.6-mini";
  }
  if (h.includes("cursor")) return "claude-haiku-4-5-20251001";
  return null;
}

async function fetchJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => "")}`.slice(0, 300));
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
