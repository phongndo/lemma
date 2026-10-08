import { describe, expect, test } from "vitest";
import { Effect, Stream } from "effect";
import type { Context } from "effect";
import type { Registries } from "@lemma/core";
import { channelProblem, resultOf } from "../src/channels.ts";
import type { Channel, ChannelCall } from "../src/channels.ts";
import { CommandChannels, serveCommands } from "../src/commands.ts";
import type { Commands } from "../src/commands.ts";
import { FileChannels, serveFiles } from "../src/files.ts";
import { serveWorkspace, WorkspaceChannels } from "../src/workspace.ts";
import type { Workspace } from "../src/workspace.ts";

/** What a fake service was asked, by operation. */
const recorder = () => {
  const calls: unknown[][] = [];
  const record =
    <A>(name: string, result: A) =>
    (...args: unknown[]) =>
      Effect.sync(() => (calls.push([name, ...args]), result));
  return { calls, record };
};

const status = { path: "/w", exists: true };

const fakeWorkspace = (record: ReturnType<typeof recorder>["record"]): Context.Service.Shape<typeof Workspace> => ({
  status: record("status", status),
  browse: record("browse", { parent: "/", entries: [], truncated: false }),
  createDirectory: record("createDirectory", status),
  createWorktree: record("createWorktree", status),
  branches: record("branches", []),
  checkout: record("checkout", status),
});

const fakeCommands = {
  register: () => Effect.void,
  list: Effect.succeed([]),
  changes: Stream.make([]),
  run: () => Effect.succeed({}),
} satisfies Context.Service.Shape<typeof Commands>;

/** Registries holding nothing: no plugin searches files. */
const empty = { items: () => Effect.succeed([]) } as unknown as Context.Service.Shape<typeof Registries>;

const declared = { workspace: WorkspaceChannels, files: FileChannels, commands: CommandChannels };

const call = (channels: readonly Channel[], id: string, payload: unknown) => resultOf(channels.find((channel) => channel.id === id) as ChannelCall, payload);

describe("the subsystems' channels", () => {
  test("are named for their subsystem, in kebab case, and titled and described for clients to discover", () => {
    for (const [subsystem, channels] of Object.entries(declared)) {
      for (const channel of Object.values(channels)) {
        expect(channel.id).toMatch(new RegExp(`^${subsystem}\\.[a-z]+(-[a-z]+)*$`));
        expect(channel).toMatchObject({ title: expect.any(String), description: expect.any(String) });
      }
    }
  });

  test("each subsystem's helper serves every one of its declarations once, well formed", () => {
    const served = {
      workspace: serveWorkspace(fakeWorkspace(recorder().record)),
      files: serveFiles(empty),
      commands: serveCommands(fakeCommands, { cwd: "/" }),
    };
    for (const [subsystem, channels] of Object.entries(served)) {
      expect(channels.map(({ id, kind }) => `${kind} ${id}`)).toEqual(
        Object.values(declared[subsystem as keyof typeof declared]).map(({ id, kind }) => `${kind} ${id}`),
      );
      for (const channel of channels) expect(channelProblem(channel)).toBeUndefined();
    }
  });

  test("a workspace call passes on only the options its client gave", async () => {
    const { calls, record } = recorder();
    const channels = serveWorkspace(fakeWorkspace(record));
    await Effect.runPromise(
      Effect.all([
        call(channels, "workspace.create-worktree", { path: "/w", branch: "x" }),
        call(channels, "workspace.create-worktree", { path: "/w", branch: "x", base: "main" }),
        call(channels, "workspace.checkout", { path: "/w", branch: "x" }),
        call(channels, "workspace.checkout", { path: "/w", branch: "x", create: true }),
      ]),
    );
    expect(calls).toEqual([
      ["createWorktree", "/w", { branch: "x" }],
      ["createWorktree", "/w", { branch: "x", base: "main" }],
      ["checkout", "/w", "x", undefined],
      ["checkout", "/w", "x", { create: true }],
    ]);
  });

  test("file search fails Unavailable, naming the directory, while no plugin searches files", async () => {
    const error = await Effect.runPromise(Effect.flip(call(serveFiles(empty), "files.search", { cwd: "/w", query: "" })));
    expect(error).toMatchObject({ _tag: "FileSearchError", reason: "Unavailable", path: "/w" });
  });
});
