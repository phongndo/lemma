// A server that speaks only the 2025 protocol, written by hand: `initialize` first, and an error for any method it
// does not know, `server/discover` included, as servers from before 2026-07-28 answer.
import { createInterface } from "node:readline";

const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
const tools = [{ name: "ping", description: "Answers pong", inputSchema: { type: "object", properties: {} } }];

for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line) as { id?: number; method: string; params?: { name?: string } };
  if (message.id === undefined) continue;
  const reply = (result: unknown) => send({ jsonrpc: "2.0", id: message.id, result });
  if (message.method === "initialize") reply({ protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "legacy", version: "0.9.0" } });
  else if (message.method === "tools/list") reply({ tools });
  else if (message.method === "tools/call") reply({ content: [{ type: "text", text: "pong" }] });
  else if (message.method === "ping") reply({});
  else send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
}
