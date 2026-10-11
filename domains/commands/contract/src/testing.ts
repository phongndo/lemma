/** `@lemma/commands/testing`: runs a command as the registry would, with a script for its questions, for a command's own tests. */
import { Effect } from "effect";
import type { Context } from "effect";
import { awaitable } from "@lemma/core";
import type { Interaction } from "@lemma/contracts";
import type { Command } from "./commands.ts";

/** Answers every question with `answer`, recording what was asked. */
export const scripted = (answer: string) => {
  const asked: { title: string; options?: readonly string[] }[] = [];
  const ask: Context.Service.Shape<typeof Interaction> = {
    confirm: (title) => Effect.sync(() => (asked.push({ title }), true)),
    ask: (title) => Effect.sync(() => (asked.push({ title }), answer)),
    select: (title, options) => Effect.sync(() => (asked.push({ title, options: options.map((option) => option.value) }), answer as never)),
  };
  return { ask, asked };
};

/** The command with `id`. */
export const find = (commands: readonly Command[], id: string): Command => commands.find((command) => command.id === id)!;

/** Runs `command` in `cwd`, as its result: what it said, or how it failed. */
export const run = (command: Command, cwd = "/repo") => Effect.runPromise(Effect.result(awaitable(() => command.run({ cwd }))));
