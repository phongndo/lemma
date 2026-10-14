import { resolve } from "node:path";
import { Effect } from "effect";
import type { Context } from "effect";
import { definePlugin, Registries } from "@lemma/core";
import { InteractionOrigin } from "@lemma/contracts";
import { CommandChannels } from "@lemma/commands";
import type { CommandInfo } from "@lemma/commands";
import { callHere, CliCommands, defineCliCommand, table } from "@lemma/cli";

type Reader = Context.Service.Shape<typeof Registries>;

export const formatCommands = (commands: readonly CommandInfo[]): string =>
  commands.length === 0
    ? "No commands."
    : table([["command", "title", "category", "from"], ...commands.map((command) => [command.id, command.title, command.category ?? "", command.source])]);

export const paletteCommands = (registries: Reader) => [
  defineCliCommand({
    path: ["commands"],
    summary: "The commands plugins add for any client (the web app's palette): id, title, category, and the plugin that added it",
    run: () =>
      Effect.map(callHere(registries, CommandChannels.list, undefined), (commands) => ({
        json: commands,
        text: formatCommands(commands),
        ids: commands.map((command) => command.id),
      })),
  }),
  defineCliCommand({
    path: ["commands", "run"],
    summary: "Run one of them in a directory (default: here); its questions are answered as --questions says",
    args: [{ name: "id", description: "Its id (lemma commands lists them)", required: true }],
    flags: {
      cwd: { type: "string", placeholder: "dir", description: "The directory it runs in, on the host's machine (default: here)" },
      session: { type: "string", placeholder: "id", description: "The session it runs for, when it acts on one" },
    },
    run: ({ args, flags, cwd }) =>
      Effect.gen(function* () {
        // Its questions carry this invocation's origin, which the client answers.
        const origin = yield* InteractionOrigin;
        const result = yield* callHere(registries, CommandChannels.run, {
          id: args.id,
          cwd: resolve(cwd, flags.cwd ?? "."),
          ...(origin === undefined ? {} : { origin }),
          ...(flags.session === undefined ? {} : { sessionId: flags.session }),
        });
        return { json: { command: args.id, ...result }, text: result.message ?? `${args.id}: done` };
      }),
  }),
];

/**
 * The palette's commands for the `lemma` command (`CliCommands`): `commands`
 * lists what plugins add to `Commands`, and `commands run <id>` runs one. It
 * reaches them through their channels, so it requires nothing.
 */
export default definePlugin({
  id: "commands.cli",
  version: "0.1.0",
  setup: function* (_, owner) {
    const registries = yield* Registries;
    for (const command of paletteCommands(registries)) yield* owner.add(CliCommands, command);
  },
});
