import { describe, expect, test } from "vitest";
import { Effect } from "effect";
import type { Context } from "effect";
import { awaitable } from "@lemma/core";
import type { Command, HostControl, Interaction, Llm, Workspace } from "@lemma/contracts";
import { hostCommands, llmCommands, workspaceCommands } from "../src/index.ts";

type Ask = Context.Service.Shape<typeof Interaction>;

/** Answers every question with the scripted value, recording what was asked. */
const scripted = (answer: string) => {
  const asked: { title: string; options?: readonly string[] }[] = [];
  const ask: Ask = {
    confirm: (title) => Effect.sync(() => (asked.push({ title }), true)),
    ask: (title) => Effect.sync(() => (asked.push({ title }), answer)),
    select: (title, options) => Effect.sync(() => (asked.push({ title, options: options.map((option) => option.value) }), answer as never)),
  };
  return { ask, asked };
};

const find = (commands: readonly Command[], id: string) => commands.find((command) => command.id === id)!;
const run = (command: Command, cwd = "/repo") => Effect.runPromise(Effect.result(awaitable(() => command.run({ cwd }))));

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

describe("host commands", () => {
  const restarted: unknown[] = [];
  const configured: unknown[] = [];
  // Plugins as the host reports them; `configure` changes `enabled`, except for "stuck", which the project file decides.
  const initial = [
    { id: "agent", state: "active", enabled: true, locked: "Needed by transport" },
    { id: "llm", state: "failed", enabled: true, locked: "Needed by transport" },
    { id: "bash", state: "active", enabled: true },
    { id: "project-context", enabled: false, haltedBy: "workspace" },
    { id: "stuck", enabled: false, scope: "project" },
    { id: "my-llm", enabled: false },
  ];
  let plugins = initial;
  const control = {
    plugins: Effect.sync(() => plugins),
    reload: Effect.succeed({ started: ["x"], restarted: [], stopped: ["y"], unchanged: [], failed: [], interrupted: 0, faults: [] }),
    restart: (id: string, options: unknown) => Effect.sync(() => void restarted.push([id, options])),
    configure: (rows: Record<string, { enabled?: boolean }>, options: unknown) =>
      Effect.sync(() => {
        configured.push([rows, options]);
        const ids = Object.keys(rows).filter((id) => id !== "stuck");
        plugins = plugins.map((plugin) => (ids.includes(plugin.id) ? { ...plugin, enabled: rows[plugin.id]?.enabled ?? plugin.enabled } : plugin));
        const empty = { started: [], restarted: [], stopped: [], unchanged: [], failed: [], interrupted: 0, faults: [] };
        // my-llm replaces a provider the transport needs: written now, applied after the reply.
        if (ids.includes("my-llm")) return { ...empty, deferred: true };
        // project-context turns on but cannot load: workspace, which it needs, is off.
        const started = ids.filter((id) => rows[id]?.enabled === true && id !== "project-context");
        const stopped = ids.filter((id) => rows[id]?.enabled === false);
        return { ...empty, started, stopped: stopped.includes("bash") ? [...stopped, "edit"] : stopped };
      }),
  } as unknown as Context.Service.Shape<typeof HostControl>;

  test("reload describes what changed", async () => {
    const result = await run(find(hostCommands(control, scripted("").ask), "host.reload"));
    expect(result).toMatchObject({ success: { message: "Config reloaded: started x; stopped y" } });
  });

  test("restart plugin offers failed plugins and running ones the host does not depend on, forcing only the latter", async () => {
    restarted.length = 0;
    const failed = scripted("llm");
    expect(await run(find(hostCommands(control, failed.ask), "host.restart-plugin"))).toMatchObject({ success: { message: "Restarted llm" } });
    expect(failed.asked[0]?.options).toEqual(["llm", "bash"]);
    const running = scripted("bash");
    expect(await run(find(hostCommands(control, running.ask), "host.restart-plugin"))).toMatchObject({ success: { message: "Restarted bash" } });
    expect(restarted).toEqual([
      ["llm", undefined],
      ["bash", { force: true }],
    ]);
  });

  test("toggle plugin offers only unlocked plugins, writes the file that decides, and reports what happened", async () => {
    configured.length = 0;
    const { ask, asked } = scripted("bash");
    const result = await run(find(hostCommands(control, ask), "host.toggle-plugin"));
    expect(asked[0]?.options).toEqual(["bash", "project-context", "stuck", "my-llm"]);
    expect(configured).toEqual([[{ bash: { enabled: false } }, undefined]]);
    expect(result).toMatchObject({ success: { message: "Turned bash off; stopped edit" } });

    configured.length = 0;
    const stuck = await run(find(hostCommands(control, scripted("stuck").ask), "host.toggle-plugin"));
    expect(configured).toEqual([[{ stuck: { enabled: true } }, { scope: "project" }]]);
    expect(stuck).toMatchObject({ failure: { reason: "Failed", message: "stuck is still off: the project config decides it" } });
  });

  test("toggle plugin reports a plugin that is on but waiting, and a change applied after the reply, as done", async () => {
    const waiting = await run(find(hostCommands(control, scripted("project-context").ask), "host.toggle-plugin"));
    expect(waiting).toMatchObject({ success: { message: "Turned project-context on; it starts when workspace is on" } });
    const deferred = await run(find(hostCommands(control, scripted("my-llm").ask), "host.toggle-plugin"));
    expect(deferred).toMatchObject({ success: { message: "Turning my-llm on: the host restarts the plugins that use it, and clients reconnect" } });
  });
});

describe("llm commands", () => {
  test("log out offers only configured providers, and fails when there are none", async () => {
    const loggedOut: string[] = [];
    const llm = (configured: boolean) =>
      ({
        providers: Effect.succeed([
          { id: "a", name: "Alpha", auth: [], configured, source: "auth.json" },
          { id: "b", name: "Beta", auth: [], configured: false },
        ]),
        logout: (id: string) => Effect.sync(() => void loggedOut.push(id)),
      }) as unknown as Context.Service.Shape<typeof Llm>;

    const { ask, asked } = scripted("a");
    expect(await run(find(llmCommands(llm(true), ask), "llm.logout"))).toMatchObject({ success: { message: "Logged out of Alpha" } });
    expect(asked[0]?.options).toEqual(["a"]);
    expect(loggedOut).toEqual(["a"]);

    expect(await run(find(llmCommands(llm(false), ask), "llm.logout"))).toMatchObject({ failure: { reason: "Failed", message: "No provider is logged in" } });
  });
});
