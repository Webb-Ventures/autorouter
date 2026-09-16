# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
