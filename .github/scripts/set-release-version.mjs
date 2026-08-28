#!/usr/bin/env bun

import { readFileSync, writeFileSync } from "node:fs";

const input = process.argv[2];
const version = input?.replace(/^v/, "");

if (!version || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("Usage: set-release-version.mjs vX.Y.Z");
  process.exit(1);
}

function updateJsonVersions(path) {
  const source = readFileSync(path, "utf8");
  JSON.parse(source);

  const versionField = /("version"\s*:\s*")[^"]+(")/g;
  if (!versionField.test(source)) {
    console.error(`Could not find a version field in ${path}`);
    process.exit(1);
  }

  const updated = source.replace(versionField, `$1${version}$2`);
  JSON.parse(updated);
  if (updated !== source) writeFileSync(path, updated);
}

updateJsonVersions("package.json");
updateJsonVersions("server.json");

const cliPath = "src/cli.ts";
const cli = readFileSync(cliPath, "utf8");
const versionDeclaration = /const VERSION = "[^"]+"/;
if (!versionDeclaration.test(cli)) {
  console.error(`Could not find const VERSION in ${cliPath}`);
  process.exit(1);
}
const updatedCli = cli.replace(versionDeclaration, `const VERSION = "${version}"`);
if (updatedCli !== cli) writeFileSync(cliPath, updatedCli);

console.log(`Release metadata set to ${version}`);
