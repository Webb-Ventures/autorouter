#!/usr/bin/env bun

import { readFileSync, writeFileSync } from "node:fs";

const input = process.argv[2];
const version = input?.replace(/^v/, "");

if (!version || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("Usage: set-release-version.mjs vX.Y.Z");
  process.exit(1);
}

const packagePath = "package.json";
const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
packageJson.version = version;
writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

const serverPath = "server.json";
const serverJson = JSON.parse(readFileSync(serverPath, "utf8"));
serverJson.version = version;
for (const pkg of serverJson.packages ?? []) {
  if (pkg.registryType === "npm") pkg.version = version;
}
writeFileSync(serverPath, `${JSON.stringify(serverJson, null, 2)}\n`);

const cliPath = "src/cli.ts";
const cli = readFileSync(cliPath, "utf8");
const versionDeclaration = /const VERSION = "[^"]+"/;
if (!versionDeclaration.test(cli)) {
  console.error(`Could not find const VERSION in ${cliPath}`);
  process.exit(1);
}
writeFileSync(cliPath, cli.replace(versionDeclaration, `const VERSION = "${version}"`));

console.log(`Release metadata set to ${version}`);
