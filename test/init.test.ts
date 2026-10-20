import { test, expect } from "bun:test";
import { stripPrimer } from "../src/cli/init.ts";

const BLOCK = "<!-- autorouter -->\n## Capability router\n\nSearch first.\n<!-- /autorouter -->";

/**
 * Claude Code injects the router's server instructions into every request, so
 * an older init's CLAUDE.md primer only repeats them; init takes it out again.
 */
test("stripPrimer removes the block and keeps the rest", () => {
  expect(stripPrimer(`# Mine\n\nkeep\n\n${BLOCK}\n`)).toBe("# Mine\n\nkeep\n");
  expect(stripPrimer(`# Mine\n\n${BLOCK}\n\n## After\n`)).toBe("# Mine\n\n## After\n");
  expect(stripPrimer(`${BLOCK}\n`)).toBe("");
  expect(stripPrimer("# Mine\n")).toBeNull();
});
