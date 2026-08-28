/**
 * Minimal YAML frontmatter reader. Skill and command files only use scalars,
 * one or two levels of nesting, and dashed/inline lists, so a full YAML
 * dependency is not worth pulling in.
 */
export type Frontmatter = { data: Record<string, any>; body: string };

export function parseFrontmatter(text: string): Frontmatter {
  if (!text.startsWith("---")) return { data: {}, body: text };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { data: {}, body: text };
  const firstNewline = text.indexOf("\n");
  const raw = text.slice(firstNewline + 1, end);
  const afterFence = text.indexOf("\n", end + 1);
  const body = afterFence === -1 ? "" : text.slice(afterFence + 1);
  return { data: parseSimpleYaml(raw), body };
}

type Node = { indent: number; obj: Record<string, any> };

function parseSimpleYaml(src: string): Record<string, any> {
  const root: Record<string, any> = {};
  const stack: Node[] = [{ indent: -1, obj: root }];
  // The key most recently seen with an empty value; a following "- " line
  // turns it into an array, a following nested "k: v" line into an object.
  let pending: { key: string; indent: number; parent: Record<string, any> } | null = null;

  const rawLines = src.split("\n");
  for (let i = 0; i < rawLines.length; i++) {
    const rawLine = rawLines[i]!;
    const line = rawLine.replace(/\s+$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    if (trimmed.startsWith("- ")) {
      if (pending) {
        const arr = (pending.parent[pending.key] ??= []) as any[];
        if (Array.isArray(arr)) arr.push(coerce(trimmed.slice(2)));
      }
      continue;
    }

    const sep = trimmed.indexOf(":");
    if (sep === -1) continue;
    const key = trimmed.slice(0, sep).trim();
    const value = trimmed.slice(sep + 1).trim();

    if (pending && indent > pending.indent) {
      // Nested mapping under the pending key.
      const child = (pending.parent[pending.key] ??= {}) as Record<string, any>;
      // Node indent is the *parent key's* indent, so children at deeper
      // indentation resolve into it rather than immediately popping it.
      if (!Array.isArray(child)) stack.push({ indent: pending.indent, obj: child });
      pending = null;
    }

    while (stack.length > 1 && indent <= stack[stack.length - 1]!.indent) stack.pop();
    const parent = stack[stack.length - 1]!.obj;

    // Block scalars ("description: >" / "|") are common in skill frontmatter —
    // long descriptions wrap. Without this the value parses as the literal ">"
    // and the skill becomes unsearchable, since description is the main field
    // the index ranks on.
    if (value === ">" || value === "|" || /^[>|][-+]?\d*$/.test(value)) {
      const fold = value.startsWith(">");
      const raw: string[] = [];
      while (i + 1 < rawLines.length) {
        const next = rawLines[i + 1]!;
        const nextIndent = next.length - next.trimStart().length;
        if (next.trim() && nextIndent <= indent) break;
        raw.push(next);
        i++;
      }
      // YAML strips the block's own indentation, which is however deep the
      // first content line happens to sit — not simply one past the key.
      // Slicing a fixed amount leaves stray leading spaces on every line.
      const base = raw.reduce(
        (min, l) => (l.trim() ? Math.min(min, l.length - l.trimStart().length) : min),
        Number.POSITIVE_INFINITY,
      );
      const lines = raw.map((l) => (l.trim() ? l.slice(base) : ""));
      const text = fold
        ? lines.reduce((acc, l) => (l.trim() === "" ? `${acc}\n` : acc ? `${acc} ${l.trim()}` : l.trim()), "")
        : lines.join("\n");
      parent[key] = text.trim();
      pending = null;
      continue;
    }

    if (!value) {
      pending = { key, indent, parent };
      continue;
    }
    parent[key] = coerce(value);
    pending = null;
  }
  return root;
}

function coerce(v: string): any {
  const s = v.trim();
  if (s.startsWith("[") && s.endsWith("]")) {
    return s
      .slice(1, -1)
      .split(",")
      .map((x) => coerce(x))
      .filter((x) => x !== "");
  }
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  if (s === "true") return true;
  if (s === "false") return false;
  return s;
}

/** Frontmatter values that plausibly carry search keywords. */
export function keywordsFrom(data: Record<string, any>): string[] {
  const out: string[] = [];
  const visit = (value: any, depth: number) => {
    if (depth > 3 || value == null) return;
    if (typeof value === "string") {
      out.push(...value.split(/[,\s]+/).filter(Boolean));
    } else if (Array.isArray(value)) {
      for (const v of value) visit(v, depth + 1);
    } else if (typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        if (/tag|keyword|categor|topic/i.test(k)) visit(v, depth + 1);
      }
    }
  };
  for (const [key, value] of Object.entries(data)) {
    if (/tag|keyword|categor|topic/i.test(key)) visit(value, 0);
    else if (key === "metadata") visit(value, 0);
  }
  return [...new Set(out.map((s) => s.toLowerCase()))];
}
