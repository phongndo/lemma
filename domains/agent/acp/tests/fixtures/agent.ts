/*
 * A fake ACP agent for the tests, run as a process: it answers every prompt by
 * echoing its text, asks to run one command (a permission request), reports the
 * call's result, and says it is done. `FAKE_ACP_AUTH=1` makes it want signing
 * in until `authenticate` is called; `FAKE_ACP_RESUME=1` lets sessions resume.
 */
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

let signedIn = process.env["FAKE_ACP_AUTH"] !== "1";
let sessions = 0;
const known = new Set<string>();
/** Each session's mode. */
const modes = new Map<string, string>();
const MODES = [
  { id: "default", name: "Manual" },
  { id: "acceptEdits", name: "Accept edits" },
  { id: "bypassPermissions", name: "Bypass permissions" },
];
/** Each session's model, of those it offers. */
const models = new Map<string, string>();
const modelOption = (current: string): acp.SessionConfigOption => ({
  type: "select",
  id: "model",
  name: "Model",
  category: "model",
  currentValue: current,
  options: [
    { value: "fast", name: "Fast", description: "Quick answers" },
    { value: "smart", name: "Smart" },
  ],
});
/** The MCP servers each session was handed, by name. */
const servers = new Map<string, string>();
/** A prompt waiting for `session/cancel`, by session. */
const cancels = new Map<string, () => void>();

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>);
acp
  .agent({ name: "fake" })
  .onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentInfo: { name: "fake-agent", version: "1.2.3" },
    agentCapabilities: {
      promptCapabilities: { image: false },
      mcpCapabilities: { http: true },
      ...(process.env["FAKE_ACP_RESUME"] === "1" ? { sessionCapabilities: { resume: {} } } : {}),
    },
    authMethods: [{ id: "browser", name: "Sign in with a browser" }],
  }))
  .onRequest(acp.methods.agent.authenticate, () => {
    signedIn = true;
    return {};
  })
  .onRequest(acp.methods.agent.session.new, ({ params }) => {
    if (!signedIn) throw acp.RequestError.authRequired();
    const sessionId = `fake-${++sessions}`;
    known.add(sessionId);
    servers.set(sessionId, params.mcpServers.map((server) => server.name).join(","));
    modes.set(sessionId, "default");
    models.set(sessionId, "fast");
    process.stderr.write(`new ${sessionId} ${params.cwd} ${JSON.stringify(params.mcpServers)}\n`);
    return { sessionId, modes: { currentModeId: "default", availableModes: MODES }, configOptions: [modelOption("fast")] };
  })
  .onRequest(acp.methods.agent.session.setConfigOption, ({ params }) => {
    if (params.configId === "model" && "value" in params && typeof params.value === "string") models.set(params.sessionId, params.value);
    return { configOptions: [modelOption(models.get(params.sessionId) ?? "fast")] };
  })
  .onRequest(acp.methods.agent.session.setMode, ({ params }) => {
    modes.set(params.sessionId, params.modeId);
    return {};
  })
  .onRequest(acp.methods.agent.session.resume, ({ params }) => {
    known.add(params.sessionId);
    return {};
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    const text = params.prompt.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
    const update = (value: acp.SessionUpdate) => client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update: value });
    // As an agent that cannot reach its model and says nothing of it (pi-acp, signed out).
    if (text.includes("silent")) return { stopReason: "end_turn" };
    await update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking." } });
    await update({
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: `[${params.sessionId} servers=${servers.get(params.sessionId) ?? ""}${modes.get(params.sessionId) === "default" ? "" : ` mode=${modes.get(params.sessionId)}`}${models.get(params.sessionId) === "fast" ? "" : ` model=${models.get(params.sessionId)}`}] Heard: ${text}`,
      },
    });
    if (text.includes("hang")) {
      await new Promise<void>((resolve) => cancels.set(params.sessionId, resolve));
      return { stopReason: "cancelled" };
    }
    await update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Run ls", kind: "execute", status: "pending", rawInput: { command: "ls" } });
    // In bypassPermissions it asks nothing, as Claude Code does.
    const answer =
      modes.get(params.sessionId) === "bypassPermissions"
        ? { outcome: { outcome: "selected" as const, optionId: "allow" } }
        : await client.request(acp.methods.client.session.requestPermission, {
            sessionId: params.sessionId,
            toolCall: { toolCallId: "t1", title: "Run ls" },
            options: [
              { optionId: "allow", name: "Allow once", kind: "allow_once" },
              { optionId: "reject", name: "Reject", kind: "reject_once" },
            ],
          });
    const allowed = answer.outcome.outcome === "selected" && answer.outcome.optionId === "allow";
    await update({
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: allowed ? "completed" : "failed",
      content: [{ type: "content", content: { type: "text", text: allowed ? "a.ts\nb.ts" : "Refused" } }],
    });
    await update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: " Done." } });
    return { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
  })
  .onNotification(acp.methods.agent.session.cancel, ({ params }) => {
    process.stderr.write(`cancel ${params.sessionId}\n`);
    cancels.get(params.sessionId)?.();
  })
  .connect(stream);
