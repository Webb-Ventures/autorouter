import { join, basename } from "node:path";
import type { Capability } from "../types.ts";
import { estimateTokens } from "../types.ts";
import { parseFrontmatter, keywordsFrom } from "../frontmatter.ts";
import { listInstalledPlugins } from "../../config/adapters/plugins.ts";
import { listFiles, readText } from "../../util/fs.ts";

/**
 * Plugin slash-commands (commands/*.md) and subagents (agents/*.md). Both are
 * markdown-with-frontmatter and are invoked by reading their body, so they are
 * indexed the same way skills are.
 */
export async function collectPluginAssets(): Promise<{
  capabilities: Capability[];
  sources: string[];
}> {
  const capabilities: Capability[] = [];
  const sources: string[] = [];

  for (const plugin of await listInstalledPlugins()) {
    for (const [dir, kind] of [
      ["commands", "command"],
      ["agents", "agent"],
    ] as const) {
      const root = join(plugin.root, dir);
      for (const file of await listFiles(root, ".md")) {
        const text = await readText(file);
        if (text === null) continue;
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
      }
    }
  }
  return { capabilities, sources };
}

function firstProse(body: string): string {
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (t && !t.startsWith("#") && !t.startsWith("---")) return t.slice(0, 300);
  }
  return "";
}
