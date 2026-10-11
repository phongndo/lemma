import { describe, expect, test } from "vitest";
import { Effect, Schema } from "effect";
import { definePlugin } from "@lemma/core/plain";
import { PromptSections } from "@lemma/agent";
import { Sessions } from "@lemma/sessions";
import { Tools, ToolResult } from "@lemma/tools";
import { call, callTools, reply, testHost } from "../src/index.ts";

/** A plugin as a user writes one: a tool, and a line in the system prompt. */
const greet = definePlugin({
  id: "greet",
  setup: (_, { add }) => {
    add(Tools, {
      name: "greet",
      description: "Greets someone",
      input: Schema.Struct({ name: Schema.String }),
      execute: ({ name }) => new ToolResult({ content: [{ type: "text", text: `Hello, ${name}!` }] }),
    });
    add(PromptSections, { id: "greet.manners", text: () => "Greet people by name." });
  },
});

describe("testHost", () => {
  test("runs a plugin in real turns against a scripted model: what it was sent, what the tools did, what was logged", async () => {
    const host = await testHost({ plugins: [greet], model: [callTools(call("greet", { name: "Ada" }, "c1")), reply("Greeted Ada.")] });
    try {
      const turn = await host.prompt("greet Ada");
      expect(turn.outcome).toEqual({ kind: "placed" });
      expect(turn.answer).toBe("Greeted Ada.");
      expect(turn.requests).toHaveLength(2);
      expect(turn.requests[0]!.system).toContain("Greet people by name.");
      expect(turn.requests[0]!.tools?.map((tool) => tool.name)).toContain("greet");
      const result = turn.requests[1]!.messages.find((message) => message.role === "toolResult");
      expect(result).toMatchObject({ toolCallId: "c1", content: [{ type: "text", text: "Hello, Ada!" }], isError: false });
      expect(turn.events.at(-1)?.data).toMatchObject({ type: "turn-end", reason: "done" });
      // A script that runs out fails the next turn, saying so.
      const extra = await host.prompt("again");
      expect(extra.events.at(-1)?.data).toMatchObject({ type: "turn-end", reason: "error" });
    } finally {
      await host.close();
    }
  });

  test("refuses a bundled plugin it does not have", async () => {
    await expect(testHost({ plugins: [], model: [], bundled: ["no.such"] })).rejects.toThrow('No bundled plugin "no.such"');
  });

  test("runs what a test asks with the composition's services", async () => {
    const host = await testHost({ plugins: [greet], model: [reply("Hi.")] });
    try {
      const turn = await host.prompt("hi");
      const listed = await host.run(Effect.flatMap(Sessions, (sessions) => sessions.list()));
      expect(listed.map((session) => session.id)).toEqual([turn.sessionId]);
    } finally {
      await host.close();
    }
  });
});
