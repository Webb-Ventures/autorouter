import { join, basename, dirname, isAbsolute } from "node:path";
import type { Capability } from "../types.ts";
import { estimateTokens } from "../types.ts";
import { parseFrontmatter, keywordsFrom } from "../frontmatter.ts";
import { absPath, claudeInstall, inClaudeDir, type ClaudeInstall } from "../../util/paths.ts";
import { findByName, mapLimit, readText } from "../../util/fs.ts";
import { listInstalledPlugins, type InstalledPlugin } from "../../config/adapters/plugins.ts";
import { gitRoot, isHome, nestedSkillDirs, projectDirs } from "../../workspace/root.ts";

/** `plugins`: the install's plugin list, when the caller already read it for this build. */
export type SkillOpts = { includePlugins?: boolean; install?: ClaudeInstall; plugins?: InstalledPlugin[] };

export type SkillRoot = { path: string; plugin: string | null; origin: "user" | "project" | "plugin" };

/**
 * Where skills live, in precedence order.
 *
 * A relative skill path (the default ".claude/skills") is project-relative, and
 * resolved the way Claude Code reads project skills: in the working directory
 * and each parent up to the git root. Below that, every nested
 * `<subdir>/.claude/skills` is added too — Claude Code only loads those after it
 * touches a file in the subdirectory, but the router can search them for free.
 * In the home directory a relative path names user skills, not project ones.
 *
 * `~/.claude/...` paths belong to the Claude Code install: under
 * CLAUDE_CONFIG_DIR=~/.claude-bts the default `~/.claude/skills` means
 * `~/.claude-bts/skills`, and plugins come from that install too.
 */
export async function skillRoots(
  skillPaths: string[],
  cwd: string,
  opts: SkillOpts = {},
): Promise<SkillRoot[]> {
  const install = opts.install ?? claudeInstall();
  skillPaths = skillPaths.map((p) => inClaudeDir(p, install));
  const roots: SkillRoot[] = [];
  const projectRel = skillPaths.filter((p) => !isAbsolute(p) && !p.startsWith("~"));
  for (const p of skillPaths) {
    if (projectRel.includes(p)) continue;
    roots.push({ path: absPath(p, cwd), plugin: null, origin: "user" });
  }
  if (!isHome(cwd)) {
    for (const dir of await projectDirs(cwd)) {
      if (isHome(dir)) break;
      for (const p of projectRel) roots.push({ path: absPath(p, dir), plugin: null, origin: "project" });
    }
    const top = await gitRoot(cwd);
    if (top && !isHome(top) && projectRel.includes(".claude/skills")) {
      for (const nested of await nestedSkillDirs(top)) {
        if (!roots.some((r) => r.path === nested)) roots.push({ path: nested, plugin: null, origin: "project" });
      }
    }
  }
  if (opts.includePlugins !== false) {
    for (const plugin of opts.plugins ?? (await listInstalledPlugins(install))) {
      roots.push({ path: join(plugin.root, "skills"), plugin: plugin.name, origin: "plugin" });
    }
  }
  return roots;
}

/**
 * Discovers SKILL.md files under the skill roots (see skillRoots). Only the
 * frontmatter is indexed; the body is read on demand by describe_capability,
 * since reading it *is* how a skill executes.
 *
 * `sources` lists the skill files and the non-plugin root directories, present
 * or not: a directory's mtime moves when a skill is added to it, and a root
 * that appears later has to register as a change.
 */
export async function collectSkills(
  skillPaths: string[],
  cwd: string,
  opts: SkillOpts = {},
): Promise<{ capabilities: Capability[]; sources: string[] }> {
  // Plugin roots are namespaced by plugin. Keeping them separate is what lets a
  // caller that disabled the plugins importer actually see no plugin skills.
  const roots = await skillRoots(skillPaths, cwd, opts);

  const capabilities: Capability[] = [];
  const sources: string[] = roots.filter((r) => !r.plugin).map((r) => r.path);
  const seen = new Set<string>();

  // The walks and reads run concurrently; the dedupe below runs in root order,
  // which is the precedence order, so the first root to define a skill still
  // wins exactly as it did when this was one sequential loop.
  // Flattened before reading, so the bound covers the whole library rather
  // than applying per root.
  const walked = await mapLimit(roots, IO_CONCURRENCY, (root) => findByName(root.path, "SKILL.md"));
  const files = roots.flatMap((root, i) => walked[i]!.map((file) => ({ root, file })));
  const read = await mapLimit(files, IO_CONCURRENCY, ({ root, file }) =>
    readSkill(file, root.plugin, root.origin),
  );
  files.forEach(({ file }, i) => {
    const cap = read[i];
    if (!cap || seen.has(cap.id)) return;
    seen.add(cap.id);
    capabilities.push(cap);
    sources.push(file);
  });
  return { capabilities, sources };
}

/** Directory walks or file reads in flight at once; see mapLimit. */
const IO_CONCURRENCY = 16;

async function readSkill(
  file: string,
  pluginName: string | null,
  origin: SkillRoot["origin"],
): Promise<Capability | null> {
  const text = await readText(file);
  if (text === null) return null;
  const { data } = parseFrontmatter(text);
  const dirName = basename(dirname(file));
  const name = typeof data.name === "string" && data.name ? data.name : dirName;
  const description =
    typeof data.description === "string" ? data.description : `Skill: ${name}`;

  // Namespace plugin-provided skills the way Claude Code does (plugin:skill).
  const id = `skill:${pluginName ? `${pluginName}:` : ""}${name}`;

  return {
    id,
    kind: "skill",
    name,
    server: pluginName ?? undefined,
    origin,
    title: typeof data.title === "string" ? data.title : undefined,
    description,
    keywords: [...keywordsFrom(data), ...name.split(/[-_]/)],
    bodyPath: file,
    approxTokens: estimateTokens(name, description),
  };
}
