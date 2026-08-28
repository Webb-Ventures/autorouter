# Contributing

Thanks for taking a look. Bug reports, small fixes and new harness adapters are
all welcome.

## Setup

```sh
bun install
bun test
bun run typecheck
bun run src/cli.ts doctor      # what your machine's catalog actually looks like
```

The project runs on [Bun](https://bun.sh). The published build targets Node so
that `npx autorouter-mcp` works for people who do not have Bun installed — if you
touch the build, check both:

```sh
bun run build
node dist/cli.js --version
```

**Nothing under `src/` may use a Bun global.** `Bun.spawn`, `Bun.which`,
`Bun.file` and friends compile fine and test green under Bun, then throw
`Bun is not defined` for exactly the users who need the Node build. Use
`src/util/fs.ts` and `src/util/proc.ts` instead, and add to them rather than
reaching for the Bun API. A test in `test/proc.test.ts` enforces this.

## Before opening a PR

```sh
bun test
bun run typecheck
```

CI runs both on Ubuntu and macOS, plus `npm pack --dry-run` and a metadata check
that keeps `package.json`, `server.json` and `src/cli.ts`'s `VERSION` in sync.

## Things worth knowing

- **Nothing is spawned at startup.** The catalog is built once and cached to
  `~/.cache/autorouter/catalog.json`; downstream servers are cold-started on
  first call. If you add a provider, keep that property — startup cost is the
  whole reason this tool exists.
- **`AUTOROUTER_HOME` redirects every home-relative path.** Tests rely on it, so
  read paths through the config layer rather than touching `os.homedir()`
  directly, or you will write into the developer's real config during a test run.
- **`adopt` edits files people also edit by hand** (`~/.claude.json`,
  `~/.claude/settings.json`, `~/.codex/config.toml`). Every write is backed up
  verbatim to `~/.autorouter/adopted/` first and `restore` must be able to put it
  back byte for byte. A change that cannot be restored exactly is a bug.
- **Refuse rather than silently degrade.** `adopt` leaves a server registered
  when the router cannot reach it, because moving it would delete a working
  capability. Prefer a `skip` line with a reason over a quiet best-effort.
- **The selector runs with no tools** (`--tools ""`, `mcp_servers={}`). That is a
  correctness property, not an optimization: a reranker that could edit files
  would be a different program.

## Adding a harness adapter

Adapters live in `src/config/adapters/`. One needs to: read the harness's server
config, write an entry for the router (`init`), move the other entries into the
router's own config with a restorable backup (`adopt`/`restore`), and report what
it found (`doctor`). `src/config/adapters/cursor.ts` is the smallest complete
example.

## Reporting a bug

`autorouter doctor --json` output is the most useful thing to attach — it shows
which servers are reachable, what the catalog contains, and where the context is
actually going. Redact any tokens before pasting.

## Security

Please do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).

## Licence

Contributions are accepted under the MIT licence of this project.
