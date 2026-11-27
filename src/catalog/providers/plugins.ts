import { join, basename } from "node:path";
import type { Capability } from "../types.ts";
import { estimateTokens } from "../types.ts";
import { parseFrontmatter, keywordsFrom } from "../frontmatter.ts";
import { listInstalledPlugins, type InstalledPlugin } from "../../config/adapters/plugins.ts";
import { claudeInstall, type ClaudeInstall } from "../../util/paths.ts";
import { listFiles, mapLimit, readText } from "../../util/fs.ts";

/**
 * Plugin slash-commands (commands/*.md) and subagents (agents/*.md). Both are
 * markdown-with-frontmatter and are invoked by reading their body, so they are
 * indexed the same way skills are.
 */
export async function collectPluginAssets(
  install: ClaudeInstall = claudeInstall(),
  /** That install's plugin list, when the caller already read it for this build. */
  installed?: InstalledPlugin[],
): Promise<{
  capabilities: Capability[];
  sources: string[];
}> {
  const capabilities: Capability[] = [];
  const sources: string[] = [];

  // Listed and read concurrently, then assembled in plugin, directory and file
  // order, so the capability list comes out exactly as the sequential loop
  // produced it (search breaks score ties by position).
  const dirs = (installed ?? (await listInstalledPlugins(install))).flatMap((plugin) =>
    ([
      ["commands", "command"],
      ["agents", "agent"],
    ] as const).map(([dir, kind]) => ({ plugin, kind, root: join(plugin.root, dir) })),
  );
  const listed = await mapLimit(dirs, IO_CONCURRENCY, (d) => listFiles(d.root, ".md"));
  const files = dirs.flatMap((d, i) => listed[i]!.map((file) => ({ ...d, file })));
  const texts = await mapLimit(files, IO_CONCURRENCY, (f) => readText(f.file));

  files.forEach(({ plugin, kind, file }, i) => {
    const text = texts[i];
    if (text === null || text === undefined) return;
    const { data, body } = parseFrontmatter(text);
    const name =
      typeof data.name === "string" && data.name ? data.name : basename(file, ".md");
    const description =
      typeof data.description === "string"
        ? data.description
        : firstProse(body) || `${kind} ${name} from the ${plugin.name} plugin`;
    const argumentHint =
      typeof data["argument-hint"] === "string" ? data["argument-hint"] : undefined;
    capabilities.push({
      id: `${kind}:${plugin.name}:${name}`,
      kind,
      name,
      server: plugin.name,
      description,
      keywords: [...keywordsFrom(data), plugin.name, ...name.split(/[-_]/)],
      bodyPath: file,
      ...(argumentHint ? { argumentHint } : {}),
      approxTokens: estimateTokens(name, description),
    });
    sources.push(file);
  });
  return { capabilities, sources };
}

/** Directory listings or file reads in flight at once; see mapLimit. */
const IO_CONCURRENCY = 16;

function firstProse(body: string): string {
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (t && !t.startsWith("#") && !t.startsWith("---")) return t.slice(0, 300);
  }
  return "";
}
