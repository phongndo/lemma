import { Effect } from "effect";
import type { Context } from "effect";
import { definePlugin } from "@lemma/core";
import { Interaction } from "@lemma/contracts";
import { CommandError, Commands } from "@lemma/commands";
import type { Command } from "@lemma/commands";
import { Workspace } from "@lemma/workspace";

type Ask = Context.Service.Shape<typeof Interaction>;

/** A command's own dead end: nothing to choose from. Reported like any failure. */
const nothing = (command: string, message: string) => new CommandError({ command, reason: "Failed", message });

export const workspaceCommands = (workspace: Context.Service.Shape<typeof Workspace>, ask: Ask): readonly Command[] => [
  {
    id: "workspace.checkout",
    title: "Switch branch…",
    category: "Git",
    description: "Check out another branch in the working directory",
    keywords: ["checkout", "git"],
    run: ({ cwd }) =>
      Effect.gen(function* () {
        // A branch checked out in another worktree cannot be checked out here too.
        const branches = (yield* workspace.branches(cwd)).filter((branch) => !branch.current && branch.worktree === undefined);
        if (branches.length === 0) return yield* nothing("workspace.checkout", `No other branch to switch to in ${cwd}`);
        const name = yield* ask.select(
          "Switch to which branch?",
          branches.map((branch) => ({ value: branch.name, label: branch.name, ...(branch.remote ? { description: "remote" } : {}) })),
        );
        const status = yield* workspace.checkout(cwd, name);
        return { message: `Switched to ${status.git?.branch ?? name}` };
      }),
  },
  {
    id: "workspace.new-branch",
    title: "Create branch…",
    category: "Git",
    description: "Create a branch from HEAD and switch to it",
    keywords: ["checkout", "git"],
    run: ({ cwd }) =>
      Effect.gen(function* () {
        const name = (yield* ask.ask("New branch name", { placeholder: "feature/name" })).trim();
        if (name === "") return yield* nothing("workspace.new-branch", "A branch needs a name");
        const status = yield* workspace.checkout(cwd, name, { create: true });
        return { message: `Created and switched to ${status.git?.branch ?? name}` };
      }),
  },
];

/** The workspace's git commands, on the caller's `cwd`: switch branch, create a branch. */
export default definePlugin({
  id: "workspace.commands",
  version: "0.1.0",
  requires: { registry: Commands, ask: Interaction, dependency: Workspace },
  setup: ({ registry, ask, dependency }) => Effect.forEach(workspaceCommands(dependency, ask), registry.register, { discard: true }),
});
