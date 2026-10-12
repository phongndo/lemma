// An MCP server for the tests, over stdio, speaking both the 2026-07-28 protocol and the earlier ones (`serveStdio`):
// what it offers is what they check against.
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const make = () => {
  const server = new McpServer({ name: "fixture", version: "1.2.3" }, { instructions: "Tools for the tests.", capabilities: { tools: { listChanged: true } } });

  server.registerTool("echo", { title: "Echo", description: "Says its text back", inputSchema: z.object({ text: z.string() }) }, async ({ text }) => ({
    content: [{ type: "text", text }],
  }));

  server.registerTool(
    "add-numbers",
    { description: "Adds two numbers", inputSchema: z.object({ a: z.number(), b: z.number() }), outputSchema: z.object({ sum: z.number() }) },
    async ({ a, b }) => ({ content: [{ type: "text", text: JSON.stringify({ sum: a + b }) }], structuredContent: { sum: a + b } }),
  );

  server.registerTool("fail", { description: "Always fails", inputSchema: z.object({}) }, async () => ({
    content: [{ type: "text", text: "it failed" }],
    isError: true,
  }));

  server.registerTool("big", { description: "Says a lot", inputSchema: z.object({ chars: z.number() }) }, async ({ chars }) => ({
    content: [{ type: "text", text: `start${"x".repeat(chars)}end` }],
  }));

  server.registerTool("grow", { description: "Adds a tool named later", inputSchema: z.object({}) }, async () => {
    server.registerTool("later", { description: "Came later", inputSchema: z.object({}) }, async () => ({ content: [{ type: "text", text: "late" }] }));
    return { content: [{ type: "text", text: "grown" }] };
  });

  return server;
};

console.error("fixture: started");
serveStdio(make);
