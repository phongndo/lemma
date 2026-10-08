import { describe, expect, test } from "vitest";
import { Effect } from "effect";
import type { Context } from "effect";
import type { Registries } from "@lemma/core";
import { channelProblem, resultOf } from "../src/channels.ts";
import type { ChannelCall } from "../src/channels.ts";
import { FileChannels, serveFiles } from "../src/files.ts";

describe("serveFiles", () => {
  /** Registries holding nothing: no plugin searches files. */
  const empty = { items: () => Effect.succeed([]) } as unknown as Context.Service.Shape<typeof Registries>;

  test("serves each declaration once, well formed, named for the subsystem and described for clients to discover", () => {
    const channels = serveFiles(empty);
    expect(channels.map(({ id, kind }) => `${kind} ${id}`)).toEqual(Object.values(FileChannels).map(({ id, kind }) => `${kind} ${id}`));
    for (const channel of channels) {
      expect(channelProblem(channel)).toBeUndefined();
      expect(channel.id).toMatch(/^files\.[a-z]+(-[a-z]+)*$/);
      expect(channel).toMatchObject({ title: expect.any(String), description: expect.any(String) });
    }
  });

  test("fails a search Unavailable, naming the directory, while no plugin searches files", async () => {
    const [search] = serveFiles(empty);
    const error = await Effect.runPromise(Effect.flip(resultOf(search as ChannelCall, { cwd: "/w", query: "" })));
    expect(error).toMatchObject({ _tag: "FileSearchError", reason: "Unavailable", path: "/w" });
  });
});
