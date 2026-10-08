import { describe, expect, test } from "vitest";
import { Effect, Stream } from "effect";
import type { Context } from "effect";
import { channelProblem } from "../src/channels.ts";
import { CommandChannels, serveCommands } from "../src/commands.ts";
import type { Commands } from "../src/commands.ts";

describe("serveCommands", () => {
  const commands = {
    register: () => Effect.void,
    list: Effect.succeed([]),
    changes: Stream.make([]),
    run: () => Effect.succeed({}),
  } satisfies Context.Service.Shape<typeof Commands>;

  // How a run's options reach the command is tested where the plugin serves them (plugins/commands, and over the wire in plugins/transport).
  test("serves each declaration once, well formed, named for the subsystem and described for clients to discover", () => {
    const channels = serveCommands(commands, { cwd: "/" });
    expect(channels.map(({ id, kind }) => `${kind} ${id}`)).toEqual(Object.values(CommandChannels).map(({ id, kind }) => `${kind} ${id}`));
    for (const channel of channels) {
      expect(channelProblem(channel)).toBeUndefined();
      expect(channel.id).toMatch(/^commands\.[a-z]+(-[a-z]+)*$/);
      expect(channel).toMatchObject({ title: expect.any(String), description: expect.any(String) });
    }
  });
});
