import { describe, expect, test } from "vitest";
import { Effect, Stream } from "effect";
import type { Context } from "effect";
import type { Events } from "@lemma/core";
import { channelProblem } from "@lemma/contracts";
import { CommandChannels, serveCommands } from "../src/commands.ts";
import type { Commands } from "../src/commands.ts";

describe("serveCommands", () => {
  const commands = {
    register: () => Effect.void,
    list: Effect.succeed([]),
    run: () => Effect.succeed({}),
  } satisfies Context.Service.Shape<typeof Commands>;
  const events: Context.Service.Shape<typeof Events> = { publish: () => Effect.void, stream: () => Stream.empty };

  // How a run's options reach the command, and what `commands.changes` sends, is tested where the plugin serves them (domains/commands/registry, and over the wire in domains/transport/server).
  test("serves each declaration once, well formed, named for the domain and described for clients to discover", () => {
    const channels = serveCommands(commands, events, { cwd: "/" });
    expect(channels.map(({ id, kind }) => `${kind} ${id}`)).toEqual(Object.values(CommandChannels).map(({ id, kind }) => `${kind} ${id}`));
    for (const channel of channels) {
      expect(channelProblem(channel)).toBeUndefined();
      expect(channel.id).toMatch(/^commands\.[a-z]+(-[a-z]+)*$/);
      expect(channel).toMatchObject({ title: expect.any(String), description: expect.any(String) });
    }
  });
});
