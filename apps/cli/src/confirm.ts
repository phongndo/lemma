import { Effect } from "effect";
import type { Io } from "./command.ts";

/** Asks at the terminal whether to go on; no when there is none. */
export const confirm = (io: Io, question: string): Effect.Effect<boolean> =>
  io.ask === undefined ? Effect.succeed(false) : Effect.promise(() => io.ask!(`${question} [y/N] `, false).then((answer) => /^y(es)?$/i.test(answer.trim())));
