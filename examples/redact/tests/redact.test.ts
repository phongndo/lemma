import { Effect, Layer, Schema } from "effect";
import { describe, expect, test } from "vitest";
import { definePlugin, makeCore, PluginContext } from "@lemma/core";
import { ToolInvocation, ToolResult, ToolRunner, Tools } from "@lemma/tools";
import tools from "@lemma/tools-registry";
import redact, { redactText, SECRETS } from "../redact.ts";

const key = "AKIAABCDEFGHIJKLMNOP";
const token = `ghp_${"a1".repeat(18)}`;

describe("a secret", () => {
  test("of each common kind is redacted, and the rest of the text kept", () => {
    expect(redactText(`id ${key} and ${token}.`, SECRETS)).toBe("id [redacted] and [redacted].");
    expect(redactText("export OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx", SECRETS)).toBe("export OPENAI_API_KEY=[redacted]");
    const pem = ["-----BEGIN OPENSSH PRIVATE KEY-----", "b3BlbnNzaC1rZXk=", "-----END OPENSSH PRIVATE KEY-----"].join("\n");
    expect(redactText(`key:\n${pem}\ndone`, SECRETS)).toBe("key:\n[redacted]\ndone");
    expect(redactText("nothing secret here: sk-short", SECRETS)).toBe("nothing secret here: sk-short");
  });
});

/** A tool that prints back what it is given, in each place a result holds text. */
const echo = definePlugin({
  id: "echo",
  layer: Layer.effectDiscard(
    Effect.flatMap(PluginContext, (owner) =>
      owner.add(Tools, {
        name: "echo",
        description: "Prints its text",
        input: Schema.Struct({ text: Schema.String }),
        execute: async ({ text }) => new ToolResult({ content: [{ type: "text", text }], structured: { output: text }, details: { lines: [text] } }),
      }),
    ),
  ),
});

const run = (text: string, patterns: readonly string[] = []) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* makeCore([tools, echo, redact], { configs: { redact: { patterns } } });
        return yield* core.run(
          Effect.flatMap(ToolRunner, (registry) =>
            registry.execute(new ToolInvocation({ sessionId: "s1", toolCallId: "c1", name: "echo", input: { text }, cwd: "/" }), new AbortController().signal),
          ),
        );
      }),
    ),
  );

describe("around a tool call", () => {
  test("its result reaches the model, a script, and the transcript redacted", async () => {
    const result = await run(`AWS_ACCESS_KEY_ID=${key}`);
    expect(result.content).toEqual([{ type: "text", text: "AWS_ACCESS_KEY_ID=[redacted]" }]);
    expect(result.structured).toEqual({ output: "AWS_ACCESS_KEY_ID=[redacted]" });
    expect(result.details).toEqual({ lines: ["AWS_ACCESS_KEY_ID=[redacted]"] });
  });

  test("a pattern of the user's own is redacted too", async () => {
    const result = await run("ticket ACME-1234-SECRET opened", ["ACME-\\d+-SECRET"]);
    expect(result.content).toEqual([{ type: "text", text: "ticket [redacted] opened" }]);
  });
});
