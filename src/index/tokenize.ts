const STOPWORDS = new Set([
  "a","an","and","are","as","at","be","by","can","do","for","from","get","how",
  "i","if","in","is","it","me","my","of","on","or","that","the","this","to",
  "use","using","want","was","what","when","where","which","with","you","your",
]);

/**
 * Splits on non-alphanumerics *and* camelCase/snake_case boundaries so that
 * "execute_sql" and "listDeployments" match the words a user would type.
 * Compound identifiers also keep their joined form ("executesql") so exact
 * tool-name queries still hit.
 */
export function tokenize(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  const chunks = text.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  // "execute_sql" and "listDeployments" should both also yield "executesql":
  // a single identifier keeps its separator-free form regardless of which
  // boundary (punctuation or case) it was split on.
  if (chunks.length > 1 && !/\s/.test(text.trim())) {
    out.push(chunks.join("").toLowerCase());
  }
  for (const chunk of chunks) {
    const parts = chunk
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .split(" ")
      .filter(Boolean);
    for (const p of parts) {
      const lower = p.toLowerCase();
      if (lower.length < 2 || STOPWORDS.has(lower)) continue;
      out.push(stem(lower));
    }
    if (parts.length > 1) {
      const joined = chunk.toLowerCase();
      if (joined.length >= 2 && !STOPWORDS.has(joined)) out.push(joined);
    }
  }
  return out;
}

/**
 * Crude suffix stripping — enough to unify plural/gerund forms.
 *
 * Every inflection of a word has to land on the same stem as its base form,
 * or a query for "issues" misses a tool named "create_issue". So "-es" is only
 * a suffix after a sibilant ("boxes", "searches"); elsewhere the plural is a
 * bare "-s" ("issues" -> "issue"), and a final "e" is then dropped from both
 * forms so "create", "created" and "creating" agree.
 */
export function stem(word: string): string {
  if (word.length <= 4) return word;
  let base = word;
  if (word.endsWith("ies") && word.length >= 6) base = `${word.slice(0, -3)}y`;
  else if (word.endsWith("ing") && word.length >= 6) base = word.slice(0, -3);
  else if (word.endsWith("ed") && word.length >= 5) base = word.slice(0, -2);
  else if (/(?:ss|x|z|ch|sh)es$/.test(word)) base = word.slice(0, -2);
  else if (word.endsWith("s") && !/(?:ss|us|is)$/.test(word)) base = word.slice(0, -1);
  if (base.length > 4 && base.endsWith("e") && !base.endsWith("ee")) base = base.slice(0, -1);
  return base;
}
