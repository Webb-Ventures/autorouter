import { resolve } from "node:path";
import { applyProjectAdopt, planProjectAdopt, restoreProject } from "../workspace/project.ts";
import { approveServers, mcpjsonApproval } from "../workspace/trust.ts";
import { loadMcpjson } from "../config/adapters/claude.ts";
import { applyRepair, formatRepairPlan, planRepair } from "./repair.ts";

type Flags = Record<string, string | boolean | undefined>;

/** `--project` with or without a value: the given directory, else the current one. */
export function projectFlag(flags: Flags): string | null {
  if (!("project" in flags)) return null;
  const v = flags.project;
  return resolve(typeof v === "string" && v ? v : process.cwd());
}

/** `autorouter adopt --project [dir]`: the repo half of adopt, on demand. */
export async function cmdAdoptProject(root: string, dryRun: boolean): Promise<number> {
  const plan = await planProjectAdopt(root);
  if (!plan) {
    console.log(`Nothing to adopt in ${root} (home directory, or settings.local.json is not valid JSON).`);
    return 0;
  }
  if (!plan.servers.length && !plan.skills.length) {
    console.log(`Nothing to adopt in ${root}.`);
  } else {
    console.log(plan.file);
    for (const s of plan.servers) console.log(`  disable .mcp.json server  ${s}   → routed`);
    for (const s of plan.skills) console.log(`  hide project skill        ${s}   → user-invocable-only`);
  }
  for (const s of plan.unapproved) {
    console.log(`  leave     ${s}   (not approved for the router: autorouter approve ${s})`);
  }
  if (dryRun || (!plan.servers.length && !plan.skills.length)) return 0;
  for (const note of await applyProjectAdopt(plan)) console.log(`✓ ${note}`);
  console.log("Restart Claude Code in this repo to reclaim the context.");
  return 0;
}

/** `autorouter approve <server...> [--project dir]`: let the router launch repo stdio servers. */
export async function cmdApprove(names: string[], flags: Flags): Promise<number> {
  const root = projectFlag(flags) ?? process.cwd();
  const approval = await mcpjsonApproval(root);
  if (!approval.trusted) {
    console.error(`${root} is not a trusted folder in Claude Code. Open it in Claude Code and accept the trust prompt first.`);
    return 1;
  }
  const all = await loadMcpjson(root);
  const wanted = names.length ? names : all.filter((e) => !e.approved).map((e) => e.entry.name);
  const entries = all.filter((e) => wanted.includes(e.entry.name)).map((e) => e.entry);
  const unknown = wanted.filter((n) => !entries.some((e) => e.name === n));
  if (unknown.length) {
    console.error(`Not in ${root}/.mcp.json: ${unknown.join(", ")}`);
    return 1;
  }
  if (!entries.length) {
    console.log("Every .mcp.json server here is already approved.");
    return 0;
  }
  for (const e of entries) {
    const what = e.transport === "stdio" ? `${e.command} ${e.args.join(" ")}` : e.url;
    console.log(`  approve  ${e.name}   ${what}`);
  }
  await approveServers(root, entries);
  console.log("Approved for this exact command; editing the entry needs approving again.");
  return 0;
}

export async function cmdRestoreProject(root: string): Promise<number> {
  for (const note of await restoreProject(root)) console.log(note);
  return 0;
}

/** `autorouter repair [--apply]`: undo the old adopt's moves of repo servers. */
export async function cmdRepair(flags: Flags): Promise<number> {
  const plan = await planRepair();
  const lines = formatRepairPlan(plan);
  if (!lines.length) {
    console.log("Nothing to repair: no repo servers were moved into the global router config.");
    return 0;
  }
  console.log("Earlier versions of adopt moved these project servers into the global router config:\n");
  for (const line of lines) console.log(line);
  if (!flags.apply) {
    console.log("\nDry run. Run `autorouter repair --apply` to make these changes.");
    return 0;
  }
  console.log("");
  for (const note of await applyRepair(plan)) console.log(`✓ ${note}`);
  return 0;
}
