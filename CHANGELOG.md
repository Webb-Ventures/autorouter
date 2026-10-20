# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `autorouter audit`: the real context bill, read from Claude Code's
  transcripts. It uses the usage figures recorded for each call to report:
  - average context per call, input processed and cache share
  - compactions, with median size before and after
  - what fills the window, with each block charged once for every call that
    re-reads it
  - which hooks print the most
  - which MCP servers the harness still calls directly

  It also replays the sessions under a sweep of `autoCompactWindow` values and
  recommends one. Takes `--days`, `--project` and `--json`.
- `doctor` reports three costs that adopt can't move:
  - `SessionStart` hooks whose output lands in context, with the measured
    median size, and a note when an empty matcher re-runs them after every
    compaction.
  - `CLAUDE.md` / `AGENTS.md` lines that name `mcp__<server>__<tool>` for a
    server now behind the router, with the `call_capability` id to use
    instead.
  - Servers injected on the harness command line (`--mcp-config`, for
    example cmux's `cmux-cua`), flagged when the router imports them too.
- Large results are saved instead of inlined. A tool or resource result over
  `spillOverTokens` (default 3,000) is written to a private per-session
  directory under the cache and replaced by a card with the path, row count,
  field types, sample rows and a ready-made `jq` filter. Rows are saved as
  JSONL; Supabase's untrusted-data wrapper is unwrapped and its warning kept.
  Clients without file tools page through the result with
  `call_capability({ id: "result:<handle>" })` instead. New settings:
  `spillOverTokens`, `spillOverrides`, `resultsMode`, `resultsDir`.
  `init --target claude` offers a `Read` allow rule for the results directory.
- `find_capabilities` takes optional `arguments` and `auto: true` to search and
  run in one request when the top hit is a clear winner and the arguments fit
  its schema. It never bypasses a `confirm` gate.
- Repo-aware pick-up. The router follows the host's workspace (MCP
  `roots/list`, then `CLAUDE_PROJECT_DIR`, then its cwd) and routes that repo's
  `.mcp.json` servers and project skills — from the working directory up to
  the git root, plus nested `<subdir>/.claude/skills` that Claude Code only
  loads on demand. They are hidden from Claude Code through the repo's own,
  git-ignored `.claude/settings.local.json` (`disabledMcpjsonServers`,
  `skillOverrides`), never by editing a committed file. On by default;
  disable with `"autoAdoptProject": false`. `adopt --project [dir]` and
  `restore --project [dir]` do the same by hand, and restore removes only
  what autorouter added.
- `autorouter approve [server…]`: let the router launch a repo's `.mcp.json`
  stdio servers. The approval pins the exact command.
- `autorouter repair [--apply]`: puts back repo servers that earlier versions
  of adopt moved out of a committed `.mcp.json` into the global router config
  (byte-for-byte from the adopt backup when possible), scopes private project
  servers to their project, and adopts each repo the new way. Dry run by
  default.

- `autorouter update`: upgrade in place via the package manager that installed
  the running copy, detected from where that copy sits on disk rather than from
  `PATH` — npm/pnpm/yarn/bun, global or as a project dependency. `--check`
  reports the available version without installing and `--dry-run` prints the
  command. An `npx`/`bunx`/`dlx` copy and a source checkout are reported as
  such instead of having a package manager run against them.
- Headless login. `autorouter login --device` runs the RFC 8628 device
  authorization grant — it prints a short code and a URL to enter on any other
  device and polls for the result, so nothing has to reach back into the
  machine. `--manual` covers providers that do not implement RFC 8628 by
  printing the authorization URL and reading the redirect you paste back.
  Neither binds a port. On a box with no display one of the two is now chosen
  automatically instead of waiting out a five-minute timeout for a browser that
  was never going to open; `AUTOROUTER_ASSUME_HEADLESS=1` forces that detection.
- `autorouter add` / `autorouter remove`: register a server with the router
  directly, by `--url`, by `--command` or a `--` passthrough, or from a pasted
  `{"mcpServers": …}` snippet via `--json`.
- Auto-adopt: a running router moves servers added to a harness config behind
  itself, so `claude mcp add` no longer needs a follow-up `autorouter adopt`.
  Servers only; disable with `"autoAdopt": false`.
- `add_server` tool, so a server can be registered from inside a session. The
  first call reports what would be registered and writes nothing; a second call
  with `confirm: true` proceeds. Disable with `"allowAddServer": false`.
- `promptMode` (`all` | `commands` | `none`) and `activation`
  (`eager` | `lazy` | `off`) settings.
- cmux's Computer Use server (`cmux-cua`) is imported while cmux is running.
  cmux injects it per session with `--mcp-config` rather than writing it to a
  config file, so no existing importer could see it. On by default as the
  `cmux` import source.

### Changed

- The router's own surface is shorter: server instructions 196 → 85 tokens,
  and tools plus instructions ~1,010 → ~480 on a live catalog.
  - `deactivate_capabilities` is folded into `activate_capabilities({ ids, off:
    true })`. The old name is still answered, just not listed.
  - `add_server` is off by default (`"allowAddServer": true` turns it back on);
    `autorouter add` covers the same ground without a permanent tool definition.
  - `find_capabilities` names the catalog's servers but drops the counts.
  - Slash commands without an `argument-hint` no longer carry a placeholder
    argument description.
- `init --target claude` no longer writes a primer into `~/.claude/CLAUDE.md`
  and removes one an older version wrote. Claude Code already injects the
  server's instructions into every request, so the primer said everything
  twice. Other harnesses keep a shorter primer.

### Fixed

- `adopt` and auto-adopt no longer edit committed project files
  (`.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`). They used to empty a
  repo's `.mcp.json` — a diff for the whole team — and move its servers into
  the router's global config, making them reachable from every project.
  Private per-project servers (`~/.claude.json` `projects[path]`) now move to
  the router's `projects[path]` section instead of the global list.
- `adopt` no longer writes project skills into user-level `skillOverrides`,
  where the bare-name override hid a same-named skill in every repo.

### Security

- A repo's `.mcp.json` servers are only indexed (and launched) when Claude Code
  would run them: the folder is trusted, and the server is HTTP or approved —
  in Claude Code, or with `autorouter approve`. Previously the router launched
  any `.mcp.json` stdio command in whatever directory it started in.

### Changed

- `autorouter login` reindexes automatically once a new grant is stored, so a
  freshly authorized server is searchable without a second command.
  `--no-reindex` skips it. Only a login that actually stores a grant triggers
  the rebuild — `--list-scopes` and an already-authorized server do not.
- Skills are no longer republished as MCP prompts by default (`promptMode:
  "commands"`). The prompt list is permanent context and skills were the bulk of
  it — one plugin shipping 141 skills cost ~11.5k tokens per turn, more than
  adopting that plugin saved. Skills remain searchable; `"promptMode": "all"`
  restores the slash commands.
- Tools are promoted to first-class host tools on first successful **use**
  rather than on every search hit (`activation: "lazy"`). A search hit is not
  evidence a tool is needed, and a promoted tool is permanent context.
  `"activation": "eager"` restores the previous behaviour.
- `doctor` reports savings per harness instead of summing un-adopted servers
  across all of them, which charged every harness for every other harness's
  configuration.
- Measured on a 702-capability catalog, the permanent router surface drops from
  ~13,158 to ~972 tokens.

### Fixed

- The server instructions said a tool is promoted after being called "more than
  once". Lazy activation promotes after the first successful call, and eager and
  off behave differently again; the instructions now describe the mode in force.
- Servers switched off with Codex's `enabled = false` are no longer launched.
  Only `disabled: true` was honoured, so the ChatGPT desktop app — which the
  Codex app registers as the `cua_repl` server — opened on every restart and
  re-index. As a backstop, a command that is a regular macOS app's main
  executable is never launched, since it opens the app instead of serving MCP.
- OAuth refreshes are serialized across routers. Each harness session runs its
  own router against the same token file, and providers that rotate refresh
  tokens (Stripe) rejected whichever router refreshed second, after which the
  SDK deleted the stored grant and every session was logged out.
- Harness config files are now fingerprinted by the catalog. A server added with
  `claude mcp add` was previously invisible to a running router until the 6-hour
  TTL expired.
- `Router.refresh()` re-resolves the config and re-seeds the connection pool. A
  server added while a `serve` process was running was never indexed and could
  not be dispatched to.
- `init` updates an existing primer block instead of skipping it, so guidance
  written by an older version no longer goes stale forever.

## [0.1.0] - 2026-08-27

Initial release.

- `find_capabilities` / `describe_capability` / `call_capability` /
  `activate_capabilities` over a catalog built from every configured MCP server,
  skill, plugin command and subagent.
- BM25 retrieval with optional embedding fusion (Voyage, OpenAI) and a selector
  model reranking the shortlist over sampling, a direct API, or a headless
  harness CLI.
- `adopt` / `restore`: moves a harness's other MCP servers — and, on Claude Code,
  its skills and plugins — behind the router, with a verbatim backup of every
  file it rewrites.
- Dynamic tool promotion where the client honours `notifications/tools/list_changed`,
  with inline schemas as the fallback everywhere else.
- Token-budgeted surfaces: promoted tool list, per-search inline schemas, and
  prompt descriptions are each bounded in tokens rather than item count.
- Own OAuth grants via RFC 7591 dynamic client registration, with `--read-only`
  and `--scopes` for narrowing.
- `autorouter` CLI: `search`, `describe`, `call`, `list`, `doctor`, `reindex`,
  `init`, `adopt`, `restore`, `login`, `logout`.

[Unreleased]: https://github.com/Webb-Ventures/autorouter/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Webb-Ventures/autorouter/releases/tag/v0.1.0
