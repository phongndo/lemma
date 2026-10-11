import { describe, expect, test } from "vitest";
import { Effect } from "effect";
import type { Context } from "effect";
import { awaitable } from "@lemma/core";
import type { Interaction } from "@lemma/contracts";
import type { Command } from "@lemma/commands";
import type { Llm } from "@lemma/llm";
import { llmCommands } from "../src/index.ts";

type Ask = Context.Service.Shape<typeof Interaction>;

/** Answers every question with the scripted value, recording what was asked. */
const scripted = (answer: string) => {
  const asked: { title: string; options?: readonly string[] }[] = [];
  const ask: Ask = {
    confirm: (title) => Effect.sync(() => (asked.push({ title }), true)),
    ask: (title) => Effect.sync(() => (asked.push({ title }), answer)),
    select: (title, options) => Effect.sync(() => (asked.push({ title, options: options.map((option) => option.value) }), answer as never)),
  };
  return { ask, asked };
};

const find = (commands: readonly Command[], id: string) => commands.find((command) => command.id === id)!;
const run = (command: Command, cwd = "/repo") => Effect.runPromise(Effect.result(awaitable(() => command.run({ cwd }))));

describe("llm commands", () => {
  test("log out offers only configured providers, and fails when there are none", async () => {
    const loggedOut: string[] = [];
    const llm = (configured: boolean) =>
      ({
        providers: Effect.succeed([
          { id: "a", name: "Alpha", auth: [], configured, source: "auth.json" },
          { id: "b", name: "Beta", auth: [], configured: false },
        ]),
        logout: (id: string) => Effect.sync(() => void loggedOut.push(id)),
      }) as unknown as Context.Service.Shape<typeof Llm>;

    const { ask, asked } = scripted("a");
    expect(await run(find(llmCommands(llm(true), ask), "llm.logout"))).toMatchObject({ success: { message: "Logged out of Alpha" } });
    expect(asked[0]?.options).toEqual(["a"]);
    expect(loggedOut).toEqual(["a"]);

    expect(await run(find(llmCommands(llm(false), ask), "llm.logout"))).toMatchObject({ failure: { reason: "Failed", message: "No provider is logged in" } });
  });
});
