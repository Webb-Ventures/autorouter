import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, sep } from "node:path";
import { runStreaming } from "../util/proc.ts";
import { readJson } from "../util/paths.ts";

/**
 * `autorouter update` — upgrade in place, using whichever package manager put
 * this copy on disk.
 *
 * The router is installed four or five different ways and the wrong upgrade
 * command is worse than none: `npm i -g` against a pnpm-managed global writes a
 * second copy that shadows the first, and the user is then updating one install
 * while running the other. So nothing is guessed from what happens to be on
 * PATH — the decision comes from where this file actually sits, which is the
 * only evidence that cannot disagree with itself.
 *
 * Two of the cases are "do not run a package manager at all": a checkout being
 * run from source, and the throwaway directory `npx` unpacks into. Both are
 * reported rather than papered over, because in both the user's next action is
 * something other than an install.
 */

export const PACKAGE_NAME = "autorouter-mcp";

/** Package managers with a distinguishable global install layout. */
export type Manager = "npm" | "pnpm" | "yarn" | "bun";

export type Install =
  /** A global install; `command` upgrades it in place. */
  | { kind: "global"; manager: Manager; dir: string }
  /** A dependency of some project; upgrading means upgrading it there. */
  | { kind: "project"; manager: Manager; dir: string; projectDir: string }
  /** npx / bunx / pnpm dlx — unpacked per run, so there is nothing to upgrade. */
  | { kind: "transient"; runner: string; dir: string }
  /** A git checkout run from source. */
  | { kind: "source"; dir: string }
  | { kind: "unknown"; dir: string };

/** The file this process is actually executing, with symlinks resolved. */
export function entryPath(): string {
  // A global install is reached through a symlink in the bin directory, and the
  // bin directory is identical across package managers — it is the link target
  // that says who owns this copy. import.meta.url survives bundling; argv[1] is
  // the fallback for a CommonJS build or an odd launcher.
  let raw: string;
  try {
    raw = fileURLToPath(import.meta.url);
  } catch {
    raw = process.argv[1] ?? "";
  }
  try {
    return realpathSync(raw);
  } catch {
    return raw;
  }
}

/** Nearest ancestor holding a package.json — the installed package's root. */
function packageRoot(from: string, exists: (p: string) => boolean): string | undefined {
  let dir = dirname(from);
  for (let i = 0; i < 12; i++) {
    if (exists(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * Which package manager owns a directory, by the lockfile sitting in it.
 *
 * Only meaningful for a project install. A global install has no lockfile to
 * read, so that case reads the path layout instead.
 */
function managerFromLockfile(dir: string, exists: (p: string) => boolean): Manager {
  if (exists(join(dir, "bun.lock")) || exists(join(dir, "bun.lockb"))) return "bun";
  if (exists(join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (exists(join(dir, "yarn.lock"))) return "yarn";
  return "npm";
}

/**
 * Classifies an install from the path of its entry point.
 *
 * `exists` is injected so the table of layouts can be tested without building
 * five real installs. Matching is on `/`-separated text: every layout below is
 * a directory naming convention, and Windows differs only in the separator.
 */
export function detectInstall(
  entry: string,
  exists: (p: string) => boolean = existsSync,
): Install {
  const root = packageRoot(entry, exists);
  if (!root) return { kind: "unknown", dir: dirname(entry) };
  const path = root.split(sep).join("/");

  // A checkout is the one case with its own history in it. Checked before the
  // node_modules layouts because a developer's checkout may well sit inside
  // some parent project's tree.
  if (exists(join(root, ".git"))) return { kind: "source", dir: root };

  // Unpacked per invocation. npm uses ~/.npm/_npx/<hash>, pnpm a `dlx`
  // directory in its store, bun a versioned folder in its install cache.
  // Upgrading any of them writes to a directory the next run will not look at.
  const transient =
    (path.includes("/_npx/") && "npx") ||
    (/\/dlx(-|\/)/.test(path) && "pnpm dlx") ||
    (path.includes("/.bun/install/cache/") && "bunx") ||
    null;
  if (transient) return { kind: "transient", runner: transient, dir: root };

  // Global layouts, each unmistakable. npm is deliberately last: it is the
  // default rather than a match, because its global root is just
  // `<prefix>/lib/node_modules` and prefixes are arbitrary.
  const nodeModules = dirname(root);
  const parent = dirname(nodeModules);
  const globalManager: Manager | null =
    path.includes("/.bun/install/global/")
      ? "bun"
      : /\/pnpm\/global\/|\/pnpm\/[0-9]+\/node_modules\//.test(path)
        ? "pnpm"
        : /\/\.config\/yarn\/global\/|\/\.yarn\/global\//.test(path)
          ? "yarn"
          : null;
  if (globalManager) return { kind: "global", manager: globalManager, dir: root };

  if (nodeModules.split(sep).pop() === "node_modules") {
    // A project install has a package.json one level above its node_modules; a
    // global root does not. That single file is the whole distinction, and it
    // decides between `add -g` and an install run inside the project.
    if (exists(join(parent, "package.json"))) {
      return {
        kind: "project",
        manager: managerFromLockfile(parent, exists),
        dir: root,
        projectDir: parent,
      };
    }
    return { kind: "global", manager: "npm", dir: root };
  }
  return { kind: "unknown", dir: root };
}

/** The argv that upgrades this install, for the kinds that can be upgraded. */
export function updateCommand(install: Install, pkg: string, version = "latest"): string[] | null {
  const spec = `${pkg}@${version}`;
  if (install.kind === "global") {
    switch (install.manager) {
      case "bun":
        return ["bun", "add", "-g", spec];
      case "pnpm":
        return ["pnpm", "add", "-g", spec];
      case "yarn":
        // Yarn 1 only. Berry has no global install, so a berry user is running
        // this from a project install and takes the branch below instead.
        return ["yarn", "global", "add", spec];
      default:
        return ["npm", "install", "-g", spec];
    }
  }
  if (install.kind === "project") {
    switch (install.manager) {
      case "bun":
        return ["bun", "add", spec];
      case "pnpm":
        return ["pnpm", "add", spec];
      case "yarn":
        return ["yarn", "add", spec];
      default:
        return ["npm", "install", spec];
    }
  }
  return null;
}

/** Numeric precedence, with any prerelease sorting below its release. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [core = "", pre] = v.replace(/^v/, "").split("-", 2);
    const parts = core.split(".").map((n) => Number.parseInt(n, 10) || 0);
    return { parts, pre };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.parts[i] ?? 0) - (y.parts[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (x.pre && !y.pre) return -1;
  if (!x.pre && y.pre) return 1;
  if (x.pre && y.pre && x.pre !== y.pre) return x.pre < y.pre ? -1 : 1;
  return 0;
}

/** The published version, from whichever registry this install would use. */
export async function latestVersion(
  pkg: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ version: string } | { error: string }> {
  // npm_config_registry is set by every manager while running a script, and is
  // the setting a user behind a private mirror has already configured.
  const base = (
    process.env.npm_config_registry ??
    process.env.NPM_CONFIG_REGISTRY ??
    "https://registry.npmjs.org"
  ).replace(/\/+$/, "");
  try {
    const res = await fetchFn(`${base}/${encodeURIComponent(pkg)}/latest`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { error: `registry returned ${res.status}` };
    const body = (await res.json()) as { version?: string };
    return body.version ? { version: body.version } : { error: "registry returned no version" };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** Explains a kind that has no upgrade command, and what to do instead. */
function cannotUpdate(install: Install, pkg: string): string {
  if (install.kind === "transient") {
    return (
      `This copy was unpacked by ${install.runner}, which fetches the package fresh on every run —\n` +
      `  there is no install here to upgrade. You are already getting the latest each time.\n` +
      `  To keep a copy that does not re-download: npm install -g ${pkg}`
    );
  }
  if (install.kind === "source") {
    return (
      `This is a checkout running from source (${install.dir}), not a package install.\n` +
      `  Update it with: git -C ${install.dir} pull && bun install && bun run build`
    );
  }
  return (
    `Could not tell which package manager installed this copy (${install.dir}).\n` +
    `  Upgrade it the way you installed it, e.g. npm install -g ${pkg}@latest`
  );
}

/** How the install is described in output, so `--check` is auditable. */
function describe(install: Install): string {
  switch (install.kind) {
    case "global":
      return `${install.manager} global install at ${install.dir}`;
    case "project":
      return `${install.manager} dependency of ${install.projectDir}`;
    case "transient":
      return `${install.runner} temporary copy at ${install.dir}`;
    case "source":
      return `source checkout at ${install.dir}`;
    default:
      return `unrecognized install at ${install.dir}`;
  }
}

export async function runUpdate(opts: {
  /** The running build's version, so the check can be skipped when current. */
  current: string;
  /** Report the available version and the command, change nothing. */
  check?: boolean;
  /** Print the command that would run, without running it. */
  dryRun?: boolean;
  /** Upgrade even when the running version is already the latest. */
  force?: boolean;
  entry?: string;
  fetchFn?: typeof fetch;
  exists?: (p: string) => boolean;
}): Promise<{ ok: boolean; message: string }> {
  const entry = opts.entry ?? entryPath();
  const install = detectInstall(entry, opts.exists);

  // The package name comes from the install being upgraded rather than a
  // constant, so a fork or a privately republished build upgrades itself and
  // not the upstream it was forked from.
  const manifest =
    install.kind === "unknown" ? null : await readJson<{ name?: string }>(join(install.dir, "package.json"));
  const pkg = manifest?.name ?? PACKAGE_NAME;

  const latest = await latestVersion(pkg, opts.fetchFn);
  if ("error" in latest) {
    return { ok: false, message: `Could not reach the registry to check for updates: ${latest.error}` };
  }

  const behind = compareVersions(opts.current, latest.version) < 0;
  const status = behind
    ? `autorouter ${opts.current} → ${latest.version} available`
    : `autorouter ${opts.current} is up to date (latest is ${latest.version})`;

  const command = updateCommand(install, pkg, latest.version);
  if (!command) {
    // Still worth reporting whether a newer version exists — knowing that is
    // the reason to go and do the manual step.
    return { ok: !behind, message: `${status}\n\n${cannotUpdate(install, pkg)}` };
  }

  const printable = command.join(" ");
  if (opts.check) {
    return { ok: true, message: `${status}\n  ${describe(install)}\n  Update with: ${printable}` };
  }
  if (!behind && !opts.force) {
    return { ok: true, message: `${status}\n  ${describe(install)}\n  Re-install anyway with: --force` };
  }
  if (opts.dryRun) {
    return { ok: true, message: `${status}\n  ${describe(install)}\n  Would run: ${printable}` };
  }

  console.log(`${status}\n  ${describe(install)}\n  Running: ${printable}\n`);
  // Streamed rather than captured: an install can take a minute, and a silent
  // process that long reads as a hang.
  const code = await runStreaming(command[0]!, command.slice(1), {
    cwd: install.kind === "project" ? install.projectDir : undefined,
  }).catch((err: Error) => err);

  if (code instanceof Error) {
    return {
      ok: false,
      message:
        `Could not run ${command[0]}: ${code.message}\n` +
        `  Run it yourself: ${printable}`,
    };
  }
  if (code !== 0) {
    return { ok: false, message: `${command[0]} exited with code ${code}. Nothing was changed by autorouter.` };
  }
  return {
    ok: true,
    message:
      `\nUpdated to ${latest.version}. Restart any harness with the router running to pick it up` +
      `\n(it is a long-lived stdio server, so an open session keeps the old build).`,
  };
}

/** Resolves a path the way the CLI would, for tests and for `--check` output. */
export function installDir(entry = entryPath()): string {
  return resolve(dirname(entry));
}
