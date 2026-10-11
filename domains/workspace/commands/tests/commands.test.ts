import { describe, expect, test } from "vitest";
import { Effect } from "effect";
import type { Context } from "effect";
import type { Workspace } from "@lemma/workspace";
import { workspaceCommands } from "../src/index.ts";
import { find, run, scripted } from "@lemma/commands/testing";

describe("workspace commands", () => {
  const calls: unknown[] = [];
  const workspace = {
    branches: () =>
      Effect.succeed([
        { name: "main", current: true, remote: false, updatedAt: 3 },
        { name: "feature", current: false, remote: false, updatedAt: 2 },
        { name: "elsewhere", current: false, remote: false, updatedAt: 1, worktree: "/other" },
        { name: "origin/fix", current: false, remote: true, updatedAt: 0 },
      ]),
    checkout: (path: string, branch: string, options?: { create?: boolean }) =>
      Effect.sync(() => {
        calls.push({ path, branch, options });
        return { path, exists: true, git: { root: path, branch: branch.replace(/^origin\//, ""), changes: 0, ahead: 0, behind: 0 } };
      }),
  } as unknown as Context.Service.Shape<typeof Workspace>;

  test("switch branch offers every branch it could check out here", async () => {
    calls.length = 0;
    const { ask, asked } = scripted("origin/fix");
    const result = await run(find(workspaceCommands(workspace, ask), "workspace.checkout"));
    expect(asked).toEqual([{ title: "Switch to which branch?", options: ["feature", "origin/fix"] }]);
    expect(calls).toEqual([{ path: "/repo", branch: "origin/fix", options: undefined }]);
    expect(result).toMatchObject({ success: { message: "Switched to fix" } });
  });

  test("create branch creates the named branch from HEAD", async () => {
    calls.length = 0;
    const { ask } = scripted("  topic  ");
    const result = await run(find(workspaceCommands(workspace, ask), "workspace.new-branch"));
    expect(calls).toEqual([{ path: "/repo", branch: "topic", options: { create: true } }]);
    expect(result).toMatchObject({ success: { message: "Created and switched to topic" } });
  });
});
