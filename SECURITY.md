# Security Policy

## Reporting a vulnerability

Please report security issues privately, not as a public issue:

- [Open a private advisory](https://github.com/Webb-Ventures/autorouter/security/advisories/new) (preferred), or
- email **riley@webbventures.com.au**

Include what you did, what happened, and what you expected. We aim to acknowledge
within 3 working days and to ship a fix or a mitigation plan within 30 days.

## Supported versions

The latest published version on npm receives fixes. Given the project's age,
older versions are not patched — upgrade instead.

## What this tool touches

autorouter has more reach than most MCP servers, so it is worth being specific
about where the risk sits.

**It reads and rewrites harness config.** `adopt` edits `~/.claude.json`,
`~/.claude/settings.json`, `~/.codex/config.toml`, `~/.cursor/mcp.json` and
`.mcp.json`. Every file is backed up verbatim to `~/.autorouter/adopted/` before
a write, and `restore` rewrites it byte for byte. Report anything that writes
outside those paths, or that cannot be restored exactly, as a bug in this
category.

**It holds OAuth tokens.** Grants obtained by `autorouter login` live in
`~/.autorouter/oauth/<server>.json` at mode `0600`. Report a token that lands
anywhere else, is written world-readable, or appears in logs, `doctor` output or
an error message.

**Scopes are the security boundary, not the prompt.** A dynamically registered
client defaults to every scope a provider advertises, which for some providers
includes write access. `--read-only` and `--scopes` narrow that, and `--read-only`
is explicitly a heuristic over scope naming — it cannot see through an opaque
name like GitHub's `repo`, which grants write while reading as neutral. That
limitation is documented rather than fixed; a case where `--scopes` itself fails
to restrict a grant is a vulnerability.

**It executes downstream capabilities on the model's behalf.** Because calls are
proxied, your host's permission prompt names `call_capability` rather than the
resolved tool. This is a documented trade-off, mitigated by `exclude` (never
surfaced), `confirm` (first call rejected, must be re-issued) and the resolved
`server/tool` prefix on every result. A way to bypass `exclude` or `confirm` is a
vulnerability; the coarse permission prompt itself is a known design limitation.

**The selector subprocess runs with no tools** (`--tools ""`, `--strict-mcp-config`,
`mcp_servers={}`). Any path by which a searched-for capability's text can cause
the selector to gain tools, reach the network, or execute code is a
vulnerability.

**Capability metadata is untrusted input.** Names, descriptions and schemas come
from third-party servers and land in the model's context. Treat a report of
injected instructions surviving into a result as in scope.

## Out of scope

- Vulnerabilities in downstream MCP servers themselves — report those upstream.
- The coarse permission prompt described above, absent a bypass of `exclude` or `confirm`.
- Attacks that require an attacker to already have write access to your config files or shell.
