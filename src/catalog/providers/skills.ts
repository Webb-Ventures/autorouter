import { join, basename, dirname } from "node:path";
import type { Capability } from "../types.ts";
import { estimateTokens } from "../types.ts";
import { parseFrontmatter, keywordsFrom } from "../frontmatter.ts";
import { absPath } from "../../util/paths.ts";
import { findByName, readText } from "../../util/fs.ts";
import { listInstalledPlugins } from "../../config/adapters/plugins.ts";

/**
 * Discovers SKILL.md files under the configured skill roots plus every
 * installed plugin's skills/ directory. Only the frontmatter is indexed; the
 * body is read on demand by describe_capability, since reading it *is* how a
 * skill executes.
 */
export async function collectSkills(
  skillPaths: string[],
  cwd: string,
  opts: { includePlugins?: boolean } = {},
): Promise<{ capabilities: Capability[]; sources: string[] }> {
  // Configured roots hold user skills; plugin roots are namespaced by plugin.
  // Keeping the two lists separate is what lets a caller that disabled the
  // plugins importer actually see no plugin skills.
  const roots: { path: string; plugin: string | null }[] = [];
  for (const p of skillPaths) roots.push({ path: absPath(p, cwd), plugin: null });
  if (opts.includePlugins !== false) {
    for (const plugin of await listInstalledPlugins()) {
      roots.push({ path: join(plugin.root, "skills"), plugin: plugin.name });
    }
  }

  const capabilities: Capability[] = [];
  const sources: string[] = [];
  const seen = new Set<string>();

  for (const root of roots) {
    const files = await findByName(root.path, "SKILL.md");
    for (const file of files) {
      const cap = await readSkill(file, root.plugin);
      if (!cap || seen.has(cap.id)) continue;
      seen.add(cap.id);
      capabilities.push(cap);
      sources.push(file);
    }
  }
  return { capabilities, sources };
}

async function readSkill(file: string, pluginName: string | null): Promise<Capability | null> {
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
    title: typeof data.title === "string" ? data.title : undefined,
    description,
    keywords: [...keywordsFrom(data), ...name.split(/[-_]/)],
    bodyPath: file,
    approxTokens: estimateTokens(name, description),
  };
}
