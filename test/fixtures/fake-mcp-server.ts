#!/usr/bin/env bun
/**
 * A tiny downstream MCP server used by the router's end-to-end tests. It
 * deliberately paginates tools/list so the router's cursor-following is
 * exercised — Claude Code itself only fetches the first page, and the router
 * must not inherit that behaviour.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const TOOLS = [
  {
    name: "run_sql_query",
    description: "Execute a read-only SQL query against the Postgres database and return rows.",
    inputSchema: {
      type: "object",
      properties: { sql: { type: "string", description: "The SQL to run" } },
      required: ["sql"],
    },
  },
  {
    name: "render_bar_chart",
    description: "Render a bar chart image from a series of labelled numeric values.",
    inputSchema: {
      type: "object",
      properties: { labels: { type: "array" }, values: { type: "array" } },
      required: ["labels", "values"],
    },
  },
  {
    name: "restart_container",
    description: "Restart a running container by name. Interrupts live traffic.",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  {
    name: "list_backups",
    description: "List database backup snapshots with their timestamps and sizes.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "bloated_report",
    description: "Build a wide analytics report. Deliberately enormous, to exercise the router's token budget.",
    // Structure, not prose: compaction trims descriptions but must never drop a
    // property, so this stays huge on the far side of it. That is what makes it
    // a real test of the budget rather than of the compactor.
    inputSchema: {
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 400 }, (_, i) => [
          `dimension_${i}`,
          { type: "string", description: `Grouping dimension number ${i} for the report.` },
        ]),
      ),
    },
  },
];

const server = new Server(
  { name: "fake-server", version: "1.0.0" },
  { capabilities: { tools: {}, prompts: {} } },
);

// One tool per page, so a complete catalog requires following every cursor.
server.setRequestHandler(ListToolsRequestSchema, async (req) => {
  const start = req.params?.cursor ? Number.parseInt(req.params.cursor, 10) : 0;
  const tool = TOOLS[start];
  if (!tool) return { tools: [] };
  const next = start + 1;
  return { tools: [tool], ...(TOOLS[next] ? { nextCursor: String(next) } : {}) };
});

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [
    { name: "explain_query_plan", description: "Walk through an EXPLAIN ANALYZE output step by step." },
  ],
}));

server.setRequestHandler(GetPromptRequestSchema, async (req) => ({
  messages: [
    { role: "user", content: { type: "text", text: `prompt:${req.params.name}` } },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => ({
  content: [
    { type: "text", text: `called ${req.params.name} with ${JSON.stringify(req.params.arguments ?? {})}` },
  ],
}));

await server.connect(new StdioServerTransport());
