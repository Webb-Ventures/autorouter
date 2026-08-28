# Releasing

Publishing is driven entirely by a version tag. Pushing `vX.Y.Z` runs
[`.github/workflows/publish.yml`](.github/workflows/publish.yml), which publishes
to npm, then to the [MCP registry](https://registry.modelcontextprotocol.io), then
cuts a GitHub release.

## One-time setup

Publishing uses **npm trusted publishing** (OIDC) and the MCP registry's
`github-oidc` login, so there is no long-lived credential in this repository at
all — no `NPM_TOKEN`, no registry PAT.

### 1. Bootstrap the npm package (once, by hand)

Trusted publishing cannot perform a package's *first* publish: npmjs.com only
exposes the Trusted Publisher setting on a package that already exists, and the
package cannot exist until something publishes it. npm tracks this in
[npm/cli#8544](https://github.com/npm/cli/issues/8544). So version 0.1.0 goes out
manually:

```sh
npm login
bun run build
npm publish --access public      # from a clean checkout of the tag
```

`autorouter-mcp` is unclaimed as of writing, so this also reserves the name.

### 2. Register the trusted publisher

On npmjs.com → the package → **Settings → Trusted Publisher → GitHub Actions**:

| field | value |
|---|---|
| Organization or user | `Webb-Ventures` |
| Repository | `autorouter` |
| Workflow filename | `publish.yml` |
| Environment | *(leave empty)* |
| Allowed actions | `npm publish` |

Every field is case-sensitive and matched exactly, the workflow filename is a
bare filename (no `.github/workflows/` prefix), and npm does **not** validate any
of it when you save — a typo only surfaces as a failed release. A package can
have only one trusted publisher at a time.

`package.json`'s `repository.url` must also match the GitHub repository exactly;
it is already `git+https://github.com/Webb-Ventures/autorouter.git`.

### 3. Lock out tokens

Once a tagged release has published successfully, set **Settings → Publishing
access → "Require two-factor authentication and disallow tokens"**. OIDC keeps
working; this only closes the token path. Then revoke the automation token used
for the bootstrap publish, if you made one.

### 4. MCP registry

Nothing to configure. `mcp-publisher login github-oidc` authenticates from the
repository's own GitHub identity, which is why `server.json`'s name must stay
under `io.github.webb-ventures/`.

### What the workflow relies on

- `permissions: id-token: write` — the OIDC token is the credential for both npm
  and the MCP registry.
- **Node 24** — trusted publishing needs >= 22.14.0.
- **npm >= 11.5.1** — the first version that can exchange an OIDC token.
  `setup-node` ships whatever npm came with that Node release, which is often
  older, so the workflow runs `npm install -g npm@latest` and then asserts the
  version. Skipping that assert is how you get an `ENEEDAUTH` or `E404` that
  points nowhere near the real cause.
- **GitHub-hosted runners only** — self-hosted runners cannot use trusted publishing.
- No `--provenance` flag and no `publishConfig.provenance`: provenance is
  generated automatically on a trusted publish from a public repo. (Setting it
  explicitly would also break a local `npm publish`, which is what step 1 needs.)

## Cutting a release

Three files carry the version and all three must agree — CI enforces this on
every PR via `.github/scripts/check-release-metadata.mjs`:

| file | field |
|---|---|
| `package.json` | `version` |
| `server.json` | `version` **and** `packages[0].version` |
| `src/cli.ts` | `const VERSION` |

```sh
VERSION=0.2.0

# 1. bump all three
npm version "$VERSION" --no-git-tag-version
jq --arg v "$VERSION" '.version = $v | .packages[0].version = $v' server.json > tmp && mv tmp server.json
sed -i '' "s/const VERSION = \".*\"/const VERSION = \"$VERSION\"/" src/cli.ts

# 2. move the Unreleased section of CHANGELOG.md under a new heading

# 3. check locally exactly as CI will
node .github/scripts/check-release-metadata.mjs "v$VERSION"
bun test && bun run typecheck && bun run build

# 4. commit, then tag
git commit -am "Release v$VERSION"
git push
git tag "v$VERSION" && git push origin "v$VERSION"
```

The workflow re-runs the metadata check, the tests and the build *before*
publishing anything, because both an npm version and a git tag are immutable
once out.

## If it fails halfway

- **Failed before `npm publish`** — fix, delete the tag (`git push --delete origin vX.Y.Z`),
  re-tag. Nothing was published.
- **npm succeeded, the registry step failed** — do not bump the npm version. Fix
  `server.json` and re-run the workflow via **Actions → Publish → Run workflow**
  with the same tag; `mcp-publisher` is idempotent for a version it has not
  accepted yet. Note the re-run publishes to npm again and that step will fail on
  the already-published version, so re-run only after the npm step is expected
  to be a no-op, or run `mcp-publisher` locally.
- **`ENEEDAUTH` or `E404` on `npm publish`** — almost always trusted publishing,
  not a missing token. Check, in order: the workflow filename registered on
  npmjs.com is exactly `publish.yml`; `id-token: write` is present; npm is
  >= 11.5.1 (the workflow asserts this); the runner is GitHub-hosted; and
  `repository.url` matches the repo.
- **"Package validation failed"** from the registry — the registry could not find
  `autorouter-mcp@X.Y.Z` on npm with a matching `mcpName`. The workflow already
  waits up to 5 minutes for npm to serve the new version; if it still fails,
  check `mcpName` in the published tarball (`npm view autorouter-mcp@X.Y.Z`).

## Verifying

```sh
npx autorouter-mcp@latest --version
curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=io.github.webb-ventures/autorouter" | jq
```
