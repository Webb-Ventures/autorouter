# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Search no longer drops real matches. The weakest lexical hit was always
  discarded (with two hits, one vanished and the other could be auto-run as the
  "only match"); plural and inflected queries (`issues`, `created`) missed
  singular tool names; and a tool name typed without its separator
  (`executesql`) matched nothing.
- Schema compaction keeps parameters named `title`, `example` or `examples`.
  They were deleted while `required` still listed them.
- A selector answer that could not be parsed is no longer cached as "nothing
  matched" for the rest of the session, and the cache respects the result limit.
- Prompt arguments containing `$1`, `$$` or `$&` are passed through unchanged,
  and a `description:` wrapped over several frontmatter lines is read whole.
- A catalog refresh closes only the connections whose server changed or was
  removed. It closed all of them, failing whatever call was in flight.
- Concurrent requests share one catalog rebuild, a forced refresh waits for a
  build that started before it, and a refresh can no longer overwrite the
  workspace a retarget just switched to.
- Downstream stderr is drained. It was piped and never read, so a server that
  logged enough blocked on its next line and stopped answering.
- Timeouts hold: the selector CLI's is enforced even when a descendant keeps
  its pipes open, and `startup_timeout_sec` above 60 is no longer capped by the
  SDK's default (which also cut `autorouter login` for a local server to 60s).
- A `tools/list` that fails is reported as that server's error instead of being
  cached as "no tools" until the TTL ran out.
- Two directories can no longer share a catalog cache file (`/a/foo-bar` and
  `/a/foo/bar` did), and a router config created after startup is noticed.
  Cache files are renamed, so each project rebuilds once.
- Saved results keep 64-bit ids exact, page mode shows the envelope
  (`has_more`, `next_cursor`), and spill settings follow a config change.
- Servers with the same command but a different `env` (or the same URL with
  different headers) are separate servers. They were merged into whichever was
  registered first. Deduping can no longer produce two servers with one name,
  and a `login` command survives when a harness registers the same server.
- Plugins that declare servers in a root `.mcp.json` are routed. They were not
  read, and `adopt` then disabled the plugin as "skills only".
  `${CLAUDE_PLUGIN_ROOT}` is resolved in `env`, `cwd`, `url` and headers too,
  and correctly when the router itself runs as a plugin.
- `adopt` writes the router's config before it removes anything from a harness,
  refuses to rewrite a `settings.json` it cannot parse, and leaves the router's
  own registration in place whatever it is named.
- Config files and OAuth grants are written atomically (through symlinks,
  keeping permissions), so an interrupt or a concurrent reader never sees a
  truncated file.
- `login --force` keeps the old grant until the new login succeeds. A missing
  browser opener no longer crashes the login (it always did on Windows), a
  client given with `--client-id` is not replaced in the device flow, and a
  200 response carrying an error is not stored as a token.
- `--project --dry-run` no longer treats `--dry-run` as the project and applies
  for real, and `--command "npx -y foo"` is split into a command and arguments.
- Ctrl-D at a prompt aborts with exit code 1; `doctor` no longer prints
  `-Infinity%` on an empty catalog; `repair` reads Codex's TOML backups; and
  `update` recognises a pnpm project install.
- `login --read-only` no longer grants Gmail's full-access scopes. Google's
  scopes are URLs with no word like "write" in them, so 15 of the Gmail MCP
  server's 20 were classed as read — `https://mail.google.com/` (the whole
  mailbox, permanent delete included), `gmail.send`, `gmail.compose`,
  `gmail.drafts`, `gmail.labels`, `gmail.messages` and the settings scopes
  among them — and `--read-only` would have requested all of those while
  `--list-scopes` labelled them "read". Under
  `https://www.googleapis.com/auth/` a scope is now read-only only when it
  ends in `.readonly` (plus `gmail.metadata` and the `userinfo` pair), and any
  other URL-shaped scope counts as write unless its path says `read` or
  `readonly`. `send`, `compose`, `insert`, `import`, `remove` and `edit` are
  recognised as mutating in every scope style. For Gmail, `--read-only` now
  requests exactly six scopes.
- `adopt --target claude` under `CLAUDE_CONFIG_DIR` edited `~/.claude` and
  `~/.claude.json` instead of the install it ran in.
- A stdio server that timed out while connecting is now stopped. It was left
  running, one more copy per reindex.
- Hidden skills are invocable by Claude again. Adopt hid them as
  `skillOverrides: "user-invocable-only"`, which Claude Code enforces by
  rejecting every Skill-tool call ("Skill … is disabled for model invocation")
  — so a skill named in CLAUDE.md, another skill, or a request failed instead
  of loading. Both project and user adoption now use `"name-only"`: the
  description leaves context, the name stays, and the Skill tool works.
  Project entries autorouter wrote the old way are migrated on the next
  pick-up (or `adopt --project`); `doctor` lists any still pending.
  `--skill-mode` accepts `name-only` (default), `user-invocable-only`, `off`.
- `autorouter add` says what it is waiting on. It saved the entry, then started
  the server and rebuilt the catalog without printing anything, so a first run
  of `npx -y <large package>` looked like a hang right after the config file
  changed. Each step now prints a line to stderr; stdout still carries only the
  result.

### Added

- More than one Claude Code install per machine. Every Claude path follows
  `CLAUDE_CONFIG_DIR` the way Claude Code does: `settings.json`, `skills/`,
  `plugins/`, transcripts and `CLAUDE.md` come from that dir, and so does
  `.claude.json` (the default install keeps it at `~/.claude.json`). A router
  started under another install indexes that install's skills, servers and
  plugins, and keeps a catalog of its own. `adopt`/`restore --target claude`
  take `--config-dir <dir>` (repeatable or comma-separated) and
  `--all-claude-dirs`. Each install gets its own backup and restores on its
  own. `doctor` lists every install, whether the router is registered in it,
  and what each still loads.
- The `oauth` block of an http server entry is read, in the shape Claude Code
  uses in `.mcp.json` and `~/.claude.json`. It was copied into the router's
  config by `adopt` and then ignored, so a server without dynamic client
  registration could only be authorized by retyping `--client-id` on every
  login.
  - `clientId` and `clientSecret` name the OAuth app. `${VAR}` is expanded, and
    `login` names a variable that is not set instead of sending it literally.
  - `callbackPort` sets the loopback redirect port.
  - `authServerMetadataUrl` (https only) replaces the discovery chain, for
    login and for background reconnects.
  - `scopes` pins what a login requests. `--read-only` narrows inside the pin,
    `--all-scopes` cannot widen past it, and an `insufficient_scope` failure
    points at the pin rather than at `--all-scopes`.

  The configured client outranks a stored registration, and a `--client-id`
  that contradicts it is refused. Duplicate registrations of one URL keep the
  block whichever name survives.
- `autorouter login` works for local (stdio) servers, which it used to refuse.
  `autorouter login <server> -- <command>` runs the server's own sign-in
  command (`-- railway login`) attached to the terminal, with the server's
  `env` and `cwd`, then checks the server starts and reindexes. With no
  command it starts the server in the foreground, stderr visible, and waits up
  to five minutes so a first-run browser sign-in can finish. A `login` key on
  a server entry in the router's config saves retyping the command; it is
  ignored in harness and `.mcp.json` entries. OAuth-only flags on a local
  server are refused by name. The router stores no credentials for these.
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
- Claude Code's routine rewrites of `~/.claude.json` no longer trigger a
  rebuild. Every few minutes the next search waited while the router
  reconnected to every server; now only a change to what the catalog reads from
  that file (its servers, this project's entry, trust and `.mcp.json`
  approvals) counts, and the same goes for `~/.claude/settings.json` (for an
  install under `CLAUDE_CONFIG_DIR`, that install's own two files). Existing
  catalogs rebuild once to pick up the new fingerprint.
- A stale cached catalog is rebuilt once at startup, not twice. `serve` used to
  discard the background rebuild and run another on the first search.
- Searches, slash-command lookups and `tools/list` check for changes once per
  request instead of two or three times.
- Catalog builds read skills, plugin commands and agents, and harness configs
  concurrently, and connect to servers while the files are still being read.
  The resulting catalog is unchanged, ordering included.
- With embeddings configured, `serve` answers before the catalog is embedded
  (searches are lexical until it is), embedding requests time out (a stalled
  query falls back to lexical search instead of hanging), batches run a few at
  a time, and the vector cache drops superseded and long-unused entries.
- `doctor` runs its read-only checks alongside the catalog build, `adopt`
  resolves the config once, `add` no longer starts the new server a second time
  to rebuild the catalog, and `login` reuses discovery it already performed.
- Large results are serialised once rather than several times, and paging
  through a saved file no longer rereads the whole file for every page.
- Per-directory catalog files untouched for 30 days are deleted from the cache,
  including those orphaned by the cache-file rename.

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
