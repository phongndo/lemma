import { describe, expect, test } from "vitest";
import { Effect } from "effect";
import type { Context } from "effect";
import { channelProblem, resultOf } from "../src/channels.ts";
import type { Channel, ChannelCall } from "../src/channels.ts";
import { serveWorkspace, WorkspaceChannels } from "../src/workspace.ts";
import type { Workspace } from "../src/workspace.ts";

describe("serveWorkspace", () => {
  /** A workspace that records what each channel asked of it. */
  const recording = () => {
    const asked: unknown[][] = [];
    const answer =
      <A>(name: string, value: A) =>
      (...args: unknown[]) =>
        Effect.sync(() => (asked.push([name, ...args]), value));
    const status = { path: "/w", exists: true };
    const workspace: Context.Service.Shape<typeof Workspace> = {
      status: answer("status", status),
      browse: answer("browse", { parent: "/", entries: [], truncated: false }),
      createDirectory: answer("createDirectory", status),
      createWorktree: answer("createWorktree", status),
      branches: answer("branches", []),
      checkout: answer("checkout", status),
    };
    return { asked, channels: serveWorkspace(workspace) };
  };
  const call = (channels: readonly Channel[], id: string, payload: unknown) => resultOf(channels.find((channel) => channel.id === id) as ChannelCall, payload);

  test("serves each declaration once, well formed, named for the subsystem and described for clients to discover", () => {
    const { channels } = recording();
    expect(channels.map(({ id, kind }) => `${kind} ${id}`)).toEqual(Object.values(WorkspaceChannels).map(({ id, kind }) => `${kind} ${id}`));
    for (const channel of channels) {
      expect(channelProblem(channel)).toBeUndefined();
      expect(channel.id).toMatch(/^workspace\.[a-z]+(-[a-z]+)*$/);
      expect(channel).toMatchObject({ title: expect.any(String), description: expect.any(String) });
    }
  });

  test("passes on only the options its client gave", async () => {
    const { asked, channels } = recording();
    await Effect.runPromise(
      Effect.all([
        call(channels, "workspace.create-worktree", { path: "/w", branch: "x" }),
        call(channels, "workspace.create-worktree", { path: "/w", branch: "x", base: "main" }),
        call(channels, "workspace.checkout", { path: "/w", branch: "x" }),
        call(channels, "workspace.checkout", { path: "/w", branch: "x", create: true }),
      ]),
    );
    // Strictly: an option the client left out is no key at all, not one set to undefined.
    expect(asked).toStrictEqual([
      ["createWorktree", "/w", { branch: "x" }],
      ["createWorktree", "/w", { branch: "x", base: "main" }],
      ["checkout", "/w", "x", undefined],
      ["checkout", "/w", "x", { create: true }],
    ]);
  });
});
