// The MCP server the plugin's tests talk to, on the official server SDK: `makeFixture` builds it, `stdio.ts` serves it
// over stdio and `http.ts` over Streamable HTTP. `legacy` offers only the 2025 protocol.
import { acceptedContent, inputRequired, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";

export function makeFixture(options: { readonly legacy?: boolean } = {}): McpServer {
  const legacy = options.legacy === true;
  const server = new McpServer(
    { name: "fixture", version: "1.2.3", title: "Fixture" },
    {
      instructions: "Use echo to test.",
      ...(legacy ? { supportedProtocolVersions: ["2025-11-25", "2025-06-18"] } : {}),
    },
  );

  server.registerTool(
    "echo",
    { title: "Echo", description: "Says the text back.", inputSchema: z.object({ text: z.string() }), annotations: { readOnlyHint: true } },
    async ({ text }) => ({ content: [{ type: "text", text }] }),
  );

  server.registerTool(
    "add",
    { description: "Adds two numbers.", inputSchema: z.object({ a: z.number(), b: z.number() }), outputSchema: z.object({ sum: z.number() }) },
    async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }], structuredContent: { sum: a + b } }),
  );

  server.registerTool("image", { description: "Returns a one-pixel PNG." }, async () => ({
    content: [
      { type: "image", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", mimeType: "image/png" },
    ],
  }));

  server.registerTool("fail", { description: "Always fails." }, async () => ({ content: [{ type: "text", text: "it failed" }], isError: true }));

  server.registerTool("big", { description: "Returns n characters.", inputSchema: z.object({ n: z.number() }) }, async ({ n }) => ({
    content: [{ type: "text", text: "x".repeat(n) }],
  }));

  server.registerTool("slow", { description: "Reports progress, then answers.", inputSchema: z.object({ steps: z.number() }) }, async ({ steps }, ctx) => {
    const token = ctx.mcpReq._meta?.progressToken;
    for (let step = 1; step <= steps; step++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (token !== undefined)
        await ctx.mcpReq.notify({ method: "notifications/progress", params: { progressToken: token, progress: step, total: steps, message: `step ${step}` } });
    }
    return { content: [{ type: "text", text: "done" }] };
  });

  server.registerTool("hang", { description: "Never answers." }, async () => new Promise(() => {}));

  const Form = z.object({ name: z.string(), ok: z.boolean() });
  server.registerTool("ask", { description: "Asks the user a question.", inputSchema: z.object({}) }, async (_args, ctx) => {
    const message = "Who are you?";
    if (legacy) {
      const result = await ctx.mcpReq.elicitInput({
        message,
        requestedSchema: { type: "object", properties: { name: { type: "string", title: "Name" }, ok: { type: "boolean", title: "OK" } }, required: ["name"] },
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
    const answer = acceptedContent(ctx.mcpReq.inputResponses, "form", Form);
    if (answer === undefined) return inputRequired({ inputRequests: { form: inputRequired.elicit({ message, requestedSchema: Form }) } });
    return { content: [{ type: "text", text: JSON.stringify({ action: "accept", content: answer }) }] };
  });

  server.registerTool("grow", { description: "Adds a tool named extra." }, async () => {
    server.registerTool("extra", { description: "Added later." }, async () => ({ content: [{ type: "text", text: "extra" }] }));
    server.sendToolListChanged();
    return { content: [{ type: "text", text: "grown" }] };
  });

  server.registerTool("env", { description: "Reads an environment variable.", inputSchema: z.object({ name: z.string() }) }, async ({ name }) => ({
    content: [{ type: "text", text: process.env[name] ?? "(unset)" }],
  }));

  server.registerTool("pid", { description: "The server's process id." }, async () => ({ content: [{ type: "text", text: String(process.pid) }] }));

  server.registerTool("crash", { description: "Exits the process." }, async () => {
    setTimeout(() => process.exit(3), 10);
    return { content: [{ type: "text", text: "bye" }] };
  });

  server.registerResource("readme", "fixture://readme", { description: "The fixture's readme", mimeType: "text/plain" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "text/plain", text: "Fixture readme" }],
  }));
  return server;
}
