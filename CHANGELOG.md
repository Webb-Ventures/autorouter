# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
