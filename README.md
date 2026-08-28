# autorouter

[![CI](https://github.com/Webb-Ventures/autorouter/actions/workflows/ci.yml/badge.svg)](https://github.com/Webb-Ventures/autorouter/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/autorouter-mcp.svg)](https://www.npmjs.com/package/autorouter-mcp)
[![licence: MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)

One tool instead of every tool.

Every MCP server you register injects its full tool list — names, descriptions,
JSON schemas — into the system prompt on every single turn. Five servers and a
handful of skills is routinely 20–30k tokens of permanent overhead, paid whether
or not the task touches any of them. It also makes tool selection _worse_: more
candidates means more mis-picks.

autorouter is an MCP server that exposes ~4 stable tools and hides everything
else behind a search. The model asks for what it needs in natural language, gets
back a few ranked candidates, reads one schema, and calls it through the router.

```
find_capabilities({ query: "inspect recent deployment errors" })
  → mcp:deployments/get_logs       (tool)
  → mcp:monitoring/search_events   (tool)
  → skill:incident-triage          (skill)

describe_capability({ id: "mcp:deployments/get_logs" })
call_capability({ id: "mcp:deployments/get_logs", arguments: { lines: 50 } })
```

## Install

```sh
npm install -g autorouter-mcp        # or: npx autorouter-mcp <command>
autorouter init --target claude      # claude | codex | cursor | vscode
autorouter adopt --target claude     # ← the step that actually saves context
```

**`adopt` is not optional.** Registering the router alongside your existing
servers is a net _increase_: their schemas are still loaded and the router adds
four more tools. `adopt` moves the downstream entries out of the harness config
and into the router's own, so the harness loads one server and the router still
reaches all of them.

MCP servers are not the whole bill. Skills and plugins load through entirely
separate mechanisms — every `SKILL.md` contributes its name and description to
the system prompt, and an enabled plugin contributes its own skills, commands
_and_ servers just by being installed. On Claude Code, `adopt` handles those too,
using the only two levers the harness exposes:

| what    | how                                            | effect                                                  |
| ------- | ---------------------------------------------- | ------------------------------------------------------- |
| skills  | `skillOverrides[name] = "user-invocable-only"` | out of the model's context; `/name` still works for you |
| plugins | `enabledPlugins[id] = false`                   | plugin's skills, commands and servers all stop loading  |

The router still finds all of them — it reads `~/.claude/skills` and
`installed_plugins.json` directly, which record _installation_, not what the
harness has enabled. That is what makes disabling a plugin a move rather than a
deletion.

Two things are refused rather than done quietly. A plugin whose MCP servers the
router cannot reach (usually OAuth, where the harness holds the token and the
router does not) stays enabled — disabling it would take away a server that
currently works. So does a plugin whose servers the router never learned about,
which happens if you drop `"plugins"` from `import`. Both are reported as `skip`
lines with the reason.

Use `--servers-only` to keep the old behaviour, `--skill-mode off` to remove the
slash command as well, and `--keep-skill` / `--keep-plugin` to exempt individual
ones. Codex, Cursor and VS Code have no skill or plugin concept, so there is
nothing extra to do there.

Run `autorouter doctor` to see the difference:

```
## Context cost
  exposing everything: ~12,400 tokens
  router surface:      ~700 tokens
  still loaded direct: ~11,700 tokens (10,800 servers + 900 skills)
  actually saved:      ~0 tokens per request (0%)

## Not yet adopted
  claude
    servers: project-tools, docs-search, issue-tracker
    plugins: ui-toolkit
    skills: code-review, incident-response
    → autorouter adopt --target claude
```

That "still loaded direct" line is what adoption removes. Every removal is backed
up verbatim to `~/.autorouter/adopted/` before anything is written;
`autorouter restore --target claude` puts it back byte for byte.

## How it finds things

Retrieve, then rerank.

1. **BM25** over every capability, always on, no dependencies. The tokenizer
   splits camelCase and snake_case (`get_user` → `get`, `user`, `getuser`)
   and boosts fields: name ×3, keywords ×2, description ×1, schema ×0.5.
2. **Embeddings**, optional. Voyage or OpenAI; scores are min-max normalized and
   fused `0.5 × bm25 + 0.5 × cosine`. An absent or unreachable provider is not an
   error — it degrades to pure lexical.
3. **A selector model** reranks the shortlist. It should be the cheapest model in
   whichever harness you are using, so `init` asks which one when it cannot infer
   it, and stores the answer in that harness's own server entry.

### The selector backend

Three ways to reach a model, tried in this order under `"mode": "auto"`:

| backend    | how                                         | when it fires                                                   |
| ---------- | ------------------------------------------- | --------------------------------------------------------------- |
| `sampling` | `sampling/createMessage` back to the host   | the host declares the capability — few do; Claude Code does not |
| `api`      | direct HTTPS to Anthropic / OpenAI / Ollama | `selector.apiKeyEnv` names a variable that is actually set      |
| `cli`      | `claude -p` or `codex exec`, headless       | a harness CLI is on `PATH`                                      |

The CLI backend is the one that usually fires, and it exists because the other two
usually cannot. Sampling is the protocol's own answer and almost nothing
implements it. The API backend then asks for an `ANTHROPIC_API_KEY` that a Claude
Code subscriber has no reason to own — they logged in, they did not buy a key — so
the router would degrade to raw index order while telling them to go purchase
access to a model they are already paying for. Meanwhile `claude` is sitting on
`PATH`, already authenticated. Shelling out to it reuses that login with nothing
to configure and no second bill.

What it costs is process startup, which makes a CLI selector slower than a direct
HTTPS request. That is why a configured API key still outranks it. Selections are
memoized per query and candidate set for the life of the process, so the price is
paid once per distinct search, not once per turn.

The harness is stripped back to a reranker. A default headless agent may boot
hooks, language servers, plugin sync and project-instruction discovery that a
short ranking task does not need. The subprocess therefore runs with
`--bare --tools "" --setting-sources ""` and `MAX_THINKING_TOKENS=0` (Codex:
`--ephemeral -s read-only`). The empty tool list is a correctness property before
it is a saving: a selector that could edit files would be a different program.

```jsonc
"selector": {
  "mode": "auto",          // auto | sampling | cli | api | off
  "provider": "cli",
  "cliCommand": "claude",  // only needed if the binary is not under its usual name
  "model": "haiku",
  "candidates": 30,
  "maxResults": 8,
  "timeoutMs": 20000       // raised automatically to the backend's own floor
}
```

It is also started with an empty MCP config (`--strict-mcp-config`,
`mcp_servers={}`) — inheriting the router's own wiring would load the exact
catalog the router exists to keep out of context, and on a bad day recurse into
the router itself.

`model` is passed through only when you set it. Codex rejects model names an
account's plan does not carry, so the account default is what it gets otherwise.

`mode: "off"` skips reranking entirely and returns raw index order, which is
fast, free, and noticeably worse.

Downstream servers are **not** spawned at startup. The catalog is built once and
persisted to `~/.cache/autorouter/catalog.json`; a server is cold-started only
when one of its capabilities is first called.

## What it indexes

| kind                         | source                                                          |
| ---------------------------- | --------------------------------------------------------------- |
| `tool`, `prompt`, `resource` | every configured MCP server (following `nextCursor` pagination) |
| `skill`                      | `**/SKILL.md` under your skill paths and plugin `skills/` dirs  |
| `command`, `agent`           | plugin `commands/*.md` and `agents/*.md`                        |

Skills, commands and agents are also republished as [slash commands](#slash-commands).

Harness configs are imported rather than duplicated: `~/.claude.json` (global and
per-project) and `.mcp.json`, `~/.codex/config.toml`, `~/.cursor/mcp.json`,
`~/.vscode/mcp.json`, and installed Claude Code plugins.

## Configuration

`autorouter.json` — looked up at `$AUTOROUTER_CONFIG`, `./.autorouter.json`,
`./autorouter.json`, `~/.config/autorouter/config.json`, `~/.autorouter.json`.

```jsonc
{
  "import": ["claude", "codex", "cursor", "plugins"],
  "servers": { "custom": { "command": "…", "args": [] } },
  "skillPaths": ["~/.claude/skills", ".claude/skills"],
  "exclude": ["media.generate_video"], // never surfaced at all
  "alwaysExpose": ["code-search.search"], // stays first-class, never adopted
  "confirm": ["database.execute_statement"], // first call is rejected, must re-issue
  "selector": { "mode": "auto" },
  "embeddings": {
    "provider": "voyage",
    "model": "voyage-3-lite",
    "apiKeyEnv": "VOYAGE_API_KEY",
  },
}
```

Env overrides (`AUTOROUTER_IMPORT`, `AUTOROUTER_SELECTOR_MODEL`,
`AUTOROUTER_SELECTOR_MODE`, `AUTOROUTER_EMBEDDINGS_PROVIDER`, …) let each harness
pin its own behaviour without a shared global file. `AUTOROUTER_HOME` redirects
every home-relative path, for tests and containers.

## Slash commands

Adopting a plugin into the router would otherwise cost you its slash commands:
Claude Code reads `commands/*.md` off disk, and nothing over MCP can add to that
list. What it _does_ surface as slash commands are MCP prompts, so every skill,
plugin command and subagent in the catalog is republished as one:

```
/mcp__autorouter__find <what you want to do>
/mcp__autorouter__plugin_name_command_name
/mcp__autorouter__skill_name
```

Bodies are substituted the way the native loader substitutes them — `$ARGUMENTS`
for everything you typed, `$1`..`$9` positionally — so a command file written for
Claude Code behaves identically through the router. `argument-hint` frontmatter
is passed through as the argument description. Names are prefixed with the owning
plugin, so two plugins shipping a `setup` command both stay reachable rather than
one silently shadowing the other.

Tools are deliberately not published here. A prompt returns text for the model to
act on and cannot return a tool result, so a slash command for `database_write` would
look callable and do nothing. Tools reach the model through search instead.

## Harness support

Searching returns a tool with its **full description and input schema**, not a
summary — the same information a native tool listing carries, because a truncated
description leaves the model guessing argument names, and a guessed argument is
the whole difference between roughly reliable and reliable.

Better still, where the client honours `notifications/tools/list_changed`,
`find_capabilities` **promotes** what it matched to real first-class tools. The
model then makes an ordinary tool call: the host validates arguments against the
real schema, the permission prompt names the real tool rather than
`call_capability`, and the router is not in the execution path at all. It becomes
a loader that decides what is in your tool list, not a middleman on every call.

| supports `listChanged`                          | proxy only                                       |
| ----------------------------------------------- | ------------------------------------------------ |
| Claude Code ≥ 2.1.232, GitHub Copilot, opencode | Codex, Gemini CLI, Claude Desktop, Vercel AI SDK |

Where it is unsupported the schema travels inline in the search result instead,
and `activate_capabilities` is never advertised, so the model is never told about
a tool it cannot use. Override the detection with `AUTOROUTER_DYNAMIC=on|off|auto`.
A tool registered mid-turn may not be callable until the next turn on Claude Code,
so `call_capability` always remains as the same-turn fallback and returns an
identical result.

## Token budgets

A router that leaks context is just a slower way of loading everything, so the
three surfaces that persist or accumulate are each bounded in **tokens**, not in
item count. Counting items looks like a bound and is not one: tool definitions
vary widely in size, so the context cost of "15 tools" depends entirely on what
the model happened to search for.

| surface                   | budget                            | lifetime   |
| ------------------------- | --------------------------------- | ---------- |
| promoted tool list        | 3,000 tok, LRU eviction           | session    |
| inline schemas per search | 700 tok, spent top-down           | one result |
| prompt list               | descriptions clamped to 180 chars | session    |

Tools promoted by the search in flight are never evicted — a tool that vanishes
between being offered and being called is worse than one never offered.

Schemas are **compacted** everywhere they are repeated: `$schema`, `title` and
`examples` are dropped, and prose is trimmed, more aggressively the deeper it
sits. Every structural field survives untouched — names, types, enums, `required`,
nesting, and `additionalProperties: false` — because dropping one of those turns a
valid call into a guessed one. This reduces repeated schema size without changing
what is callable.

`describe_capability` is the exception and returns the schema verbatim: it exists
precisely to recover anything a budgeted result had to leave out.

## CLI

For agents that have a shell but no MCP, the same engine is directly usable:

```sh
autorouter search "chart a csv"
autorouter search "query a database" --raw --limit 5
autorouter describe skill:dataviz
autorouter call mcp:deployments/get_logs --args '{"lines":50}'
autorouter list --kind skill
autorouter doctor
autorouter reindex

autorouter adopt --target claude --dry-run          # preview, change nothing
autorouter adopt --target claude --servers-only     # skip skills and plugins
autorouter adopt --target claude --keep project-tools --keep-plugin ui-toolkit
autorouter restore --target claude                  # undo the most recent adopt

autorouter login                                    # which servers need a grant
autorouter login remote-server                      # authorize one (opens a browser)
autorouter logout remote-server                     # forget a stored grant
```

## OAuth servers

Some remote MCP servers carry no credentials in their visible configuration.
The working token is an OAuth grant obtained by the harness, stored in the
harness's credential store, and issued specifically to that harness.

The router does not read it. It runs its own authorization-code flow and holds
its own grant, which means it also works under Codex and Cursor, neither of which
has a token to borrow:

```sh
autorouter login remote-server
autorouter reindex
```

Registration is RFC 7591 dynamic client registration, so there is no app to
create first. Tokens live in `~/.autorouter/oauth/<server>.json` at `0600` and
are refreshed automatically; `logout` deletes them. The loopback redirect uses a
fixed port (33418, `--port` or `$AUTOROUTER_OAUTH_PORT` to change it) because the
redirect URI is baked into the registration a provider stores — a grant obtained
on one port cannot be refreshed from another.

### Choosing permissions

A dynamically registered client may default to every scope the provider
advertises, including write or administrative permissions. That can leave a
search tool holding a token capable of destructive actions. Scopes are the only
restriction that survives a prompt injection, so pick them deliberately:

```sh
autorouter login remote-server --list-scopes
autorouter login remote-server --read-only
autorouter login remote-server --scopes "projects:read,data:read"
```

`--read-only` keeps the scopes whose names do not grant mutation. It is a
heuristic over naming conventions (`:write`, `admin`, `manage`, `all`) and it
cannot infer the permissions behind opaque scope names. `--scopes` is the exact
lever when the heuristic cannot tell. Where a provider offers no read-only subset
at all, `--read-only` fails loudly rather than requesting an empty scope, which
most providers read as "give the default".

Scopes are fixed when the grant is issued, so narrowing an existing one means
`--force` and a fresh authorization. A re-login inherits the previous narrowing
unless you pass a new one, and `autorouter login` with no argument prints what
each stored grant actually covers.

Until a server has a grant, `adopt` refuses to move it or to disable the plugin
that supplies it. Moving a server the router cannot reach would delete a working
capability, so `doctor` and `adopt` both print the exact `login` command instead.

## The trade-off, stated plainly

Routing means your host's permission prompt sees `call_capability`, not
`database.execute_statement`. That is a real loss of granularity and this tool
does not pretend otherwise. Three mitigations: `exclude` means a capability is
never surfaced; `confirm` rejects the first attempt with the resolved target
spelled out and requires the model to re-issue with `confirm: true`; and every
result is prefixed with the resolved `server/tool` so the transcript stays
auditable.

Adopting skills and plugins edits `~/.claude/settings.json`, a file you also edit
by hand. The whole file is backed up verbatim alongside the server moves and
`restore` rewrites it byte for byte, but it is a shared file and worth knowing
about. Hidden skills default to `user-invocable-only` rather than `off` for the
same reason: `/name` keeps working, so the capability is relocated, not removed.

## Development

```sh
bun install
bun test
bun run src/cli.ts doctor
bun run build          # bun build src/cli.ts --target=node --outfile dist/cli.js
```

The build targets Node so `npx` works for people who do not have Bun.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the invariants worth knowing before
changing anything — chiefly that nothing is spawned at startup, that every write
`adopt` makes has to restore byte for byte, and that the selector subprocess runs
with no tools by design.

## Licence

[MIT](LICENSE). Security reports go through [SECURITY.md](SECURITY.md), not the
public issue tracker.
