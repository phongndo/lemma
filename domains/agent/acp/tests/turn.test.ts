import { describe, expect, it } from "vitest";
import { Effect, Fiber, Stream } from "effect";
import type { AgentProcess } from "../src/connection.ts";
import { mcpServersFor, promptBlocks, resultText, runTurn, UpdateMapper } from "../src/turn.ts";

describe("an agent's updates", () => {
  it("become text, thinking, and calls under acp.<kind>, a call's running output, and its result once it is done", () => {
    const mapper = new UpdateMapper();
    expect(mapper.map({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Hm." } })).toEqual([{ type: "thinking", delta: "Hm." }]);
    expect(
      mapper.map({
        sessionUpdate: "tool_call",
        toolCallId: "e",
        title: "Edit a.ts",
        kind: "edit",
        status: "pending",
        locations: [{ path: "/w/a.ts", line: 3 }],
      }),
    ).toEqual([{ type: "tool-call", id: "e", name: "acp.edit", arguments: { title: "Edit a.ts", locations: [{ path: "/w/a.ts", line: 3 }] } }]);
    // The same again: nothing new.
    expect(mapper.map({ sessionUpdate: "tool_call_update", toolCallId: "e", title: "Edit a.ts" })).toEqual([]);
    expect(
      mapper.map({
        sessionUpdate: "tool_call_update",
        toolCallId: "e",
        status: "in_progress",
        content: [{ type: "content", content: { type: "text", text: "work" } }],
      }),
    ).toEqual([{ type: "tool-output", id: "e", chunk: "work" }]);
    const done = mapper.map({
      sessionUpdate: "tool_call_update",
      toolCallId: "e",
      status: "completed",
      content: [{ type: "diff", path: "/w/a.ts", oldText: "a", newText: "b" }],
    });
    expect(done).toEqual([
      {
        type: "tool-result",
        id: "e",
        content: [{ type: "text", text: "Edited /w/a.ts:\nb" }],
        isError: false,
        details: { title: "Edit a.ts", diffs: [{ path: "/w/a.ts", oldText: "a", newText: "b" }] },
      },
    ]);
    // A finished call hears no more.
    expect(mapper.map({ sessionUpdate: "tool_call_update", toolCallId: "e", status: "failed" })).toEqual([]);
    expect(mapper.map({ sessionUpdate: "plan", entries: [] })).toEqual([]);
  });

  it("reports a failed call as an error, its raw output when it gave no content", () => {
    const mapper = new UpdateMapper();
    mapper.map({ sessionUpdate: "tool_call", toolCallId: "x", title: "Run it", kind: "execute", rawInput: { command: "false" } });
    expect(mapper.map({ sessionUpdate: "tool_call_update", toolCallId: "x", status: "failed", rawOutput: { exitCode: 1 } })).toMatchObject([
      { type: "tool-result", id: "x", isError: true, content: [{ type: "text", text: '{\n  "exitCode": 1\n}' }] },
    ]);
    expect(resultText([], undefined)).toBe("");
  });

  it("keeps what a call reported while it ran when its last update says only that it is done", () => {
    const mapper = new UpdateMapper();
    mapper.map({ sessionUpdate: "tool_call", toolCallId: "e", title: "Edit a.ts", kind: "edit", status: "in_progress" });
    mapper.map({ sessionUpdate: "tool_call_update", toolCallId: "e", content: [{ type: "diff", path: "/w/a.ts", oldText: "a", newText: "b" }] });
    expect(mapper.map({ sessionUpdate: "tool_call_update", toolCallId: "e", status: "completed" })).toMatchObject([
      {
        type: "tool-result",
        id: "e",
        isError: false,
        content: [{ type: "text", text: "Edited /w/a.ts:\nb" }],
        details: { diffs: [{ path: "/w/a.ts", oldText: "a", newText: "b" }] },
      },
    ]);
  });
});

describe("a session's servers", () => {
  const launches = [
    { name: "local", transport: "stdio" as const, command: "srv", args: ["--x"], env: { A: "1" }, headers: {} },
    { name: "remote", transport: "http" as const, args: [], env: {}, url: "https://x/mcp", headers: { Authorization: "Bearer t" } },
  ];
  it("are the local ones, and the remote ones when the agent takes them", () => {
    expect(mcpServersFor(launches, false)).toEqual([{ name: "local", command: "srv", args: ["--x"], env: [{ name: "A", value: "1" }] }]);
    expect(mcpServersFor(launches, true)[1]).toEqual({
      type: "http",
      name: "remote",
      url: "https://x/mcp",
      headers: [{ name: "Authorization", value: "Bearer t" }],
    });
  });

  it("start a local one with a folder through sh, which changes to it first", () => {
    const [server] = mcpServersFor([{ ...launches[0]!, cwd: "/data dir" }], false);
    expect(server).toEqual({
      name: "local",
      command: "/bin/sh",
      args: ["-c", 'cd "$1" && shift && exec "$@"', "sh", "/data dir", "srv", "--x"],
      env: [{ name: "A", value: "1" }],
    });
  });
});

describe("a prompt", () => {
  it("tells an agent what it has not seen first, and leaves out images it does not take", () => {
    const blocks = promptBlocks(
      {
        prompts: [
          [
            { type: "text", text: "go" },
            { type: "image", data: "AA", mimeType: "image/png" },
          ],
        ],
      },
      "<user>\nhi\n</user>",
      false,
    );
    expect(blocks.map((block) => (block.type === "text" ? block.text.slice(0, 22) : block.type))).toEqual([
      "<conversation>\n<user>\n",
      "go",
      "[An image was attached",
    ]);
    expect(promptBlocks({ prompts: [[{ type: "image", data: "AA", mimeType: "image/png" }]] }, "", true)).toEqual([
      { type: "image", data: "AA", mimeType: "image/png" },
    ]);
  });
});

describe("a turn cancelled while the agent starts", () => {
  it("sends no prompt once the agent is up", async () => {
    let started!: () => void;
    let asked!: () => void;
    const starting = new Promise<void>((resolve) => (asked = resolve));
    const calls: string[] = [];
    const process = {
      spec: { id: "slow", title: "Slow", command: "slow", args: [], env: {} },
      token: "t",
      modes: [],
      models: undefined,
      start: () =>
        new Promise((resolve) => {
          started = () => resolve({ protocolVersion: 1, agentCapabilities: {} });
          asked();
        }),
      knows: () => false,
      newSession: async () => {
        calls.push("new");
        return { sessionId: "s" };
      },
      useAccess: async () => {},
      useModel: async () => {},
      prompt: async () => {
        calls.push("prompt");
        return { stopReason: "end_turn" };
      },
      cancel: () => calls.push("cancel"),
    } as unknown as AgentProcess;
    const turn = {
      sessionId: "l",
      turnId: "t1",
      cwd: "/w",
      prompts: [[{ type: "text" as const, text: "hi" }]],
      history: [],
      signal: new AbortController().signal,
    };
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(Stream.runDrain(runTurn({ process, mcpServers: async () => [] }, turn)));
        yield* Effect.promise(() => starting);
        yield* Fiber.interrupt(fiber);
      }),
    );
    started();
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toEqual([]);
  });
});
