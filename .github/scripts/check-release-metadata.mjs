#!/usr/bin/env node
// Keeps package.json and server.json from drifting apart.
//
// The MCP registry verifies ownership by matching server.json's `name` against
// `mcpName` in the npm package, and rejects a package version it cannot find on
// npm. Both failures happen at publish time, after the npm release has already
// gone out and the tag is immutable. Checking on every PR instead.
//
// With an argument, also asserts both versions equal that tag (e.g. "v1.2.3").
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const server = JSON.parse(readFileSync("server.json", "utf8"));
const errors = [];

if (!pkg.mcpName) errors.push("package.json is missing `mcpName`.");
else if (pkg.mcpName !== server.name) {
  errors.push(`package.json mcpName (${pkg.mcpName}) != server.json name (${server.name}).`);
}

const repositoryUrl = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
const githubOwner = repositoryUrl?.match(/github\.com[/:]([^/]+)\//)?.[1];
if (githubOwner && pkg.mcpName && !pkg.mcpName.startsWith(`io.github.${githubOwner}/`)) {
  errors.push(
    `package.json mcpName (${pkg.mcpName}) must preserve the GitHub owner casing: io.github.${githubOwner}/*.`,
  );
}

if (pkg.version !== server.version) {
  errors.push(`package.json version (${pkg.version}) != server.json version (${server.version}).`);
}

const npmPackages = (server.packages ?? []).filter((p) => p.registryType === "npm");
if (npmPackages.length === 0) errors.push("server.json declares no npm package.");
for (const p of npmPackages) {
  if (p.identifier !== pkg.name) {
    errors.push(`server.json npm identifier (${p.identifier}) != package.json name (${pkg.name}).`);
  }
  if (p.version !== pkg.version) {
    errors.push(`server.json package version (${p.version}) != package.json version (${pkg.version}).`);
  }
}

// `autorouter --version` is a literal in src/cli.ts; nothing makes it follow
// package.json, so a release can otherwise ship reporting the previous version.
const cli = readFileSync("src/cli.ts", "utf8");
const declared = cli.match(/const VERSION = "([^"]+)"/)?.[1];
if (!declared) errors.push("could not find `const VERSION` in src/cli.ts.");
else if (declared !== pkg.version) {
  errors.push(`src/cli.ts VERSION (${declared}) != package.json version (${pkg.version}).`);
}

const tag = process.argv[2];
if (tag) {
  const expected = tag.replace(/^v/, "");
  if (pkg.version !== expected) {
    errors.push(`tag ${tag} does not match package.json version ${pkg.version}.`);
  }
}

if (errors.length > 0) {
  console.error("Release metadata is inconsistent:");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log(`Release metadata OK: ${pkg.name}@${pkg.version} as ${server.name}`);
