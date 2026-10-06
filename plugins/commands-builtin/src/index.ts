import { Effect, Layer } from "effect";
import type { Context } from "effect";
import { definePlugin } from "@lemma/core";
import { CommandError, Commands, describeReload, HostControl, Interaction, Llm, recoverable, Workspace } from "@lemma/contracts";
import type { Command } from "@lemma/contracts";

type Ask = Context.Tag.Service<typeof Interaction>;

/** A command's own dead end: nothing to choose from. Reported like any failure. */
const nothing = (command: string, message: string) => new CommandError({ command, reason: "Failed", message });

export const hostCommands = (control: Context.Tag.Service<typeof HostControl>, ask: Ask): readonly Command[] => [
  {
    id: "host.reload",
    title: "Reload config",
    category: "Host",
    description: "Re-read the config files and apply them",
    keywords: ["plugins", "composition", "settings"],
    run: () =>
      Effect.map(control.reload, (report) => {
        const summary = describeReload(report);
        return { message: summary === undefined ? "Config reloaded; nothing changed" : `Config reloaded: ${summary}` };
      }),
  },
  {
    id: "host.restart-plugin",
    title: "Restart plugin…",
    category: "Host",
    description: "Restart a failed plugin and what it halted, or a running plugin the host does not depend on",
    run: () =>
      Effect.gen(function* () {
        // Restarting a running plugin restarts its dependents; excluded when those include the transport serving this call.
        const plugins = (yield* control.plugins).filter((plugin) => recoverable(plugin) || (plugin.state === "active" && plugin.locked === undefined));
        if (plugins.length === 0) return yield* nothing("host.restart-plugin", "No plugin can be restarted");
        const id = yield* ask.select(
          "Restart which plugin?",
          plugins.map((plugin) => ({ value: plugin.id, label: plugin.id, description: plugin.state! })),
        );
        const chosen = plugins.find((plugin) => plugin.id === id)!;
        yield* control.restart(id, chosen.state === "active" ? { force: true } : undefined);
        return { message: `Restarted ${id}` };
      }),
  },
  {
    id: "host.toggle-plugin",
    title: "Turn plugin on or off…",
    category: "Host",
    description: "Change a plugin's `enabled` row in the config file that decides it, and apply",
    keywords: ["enable", "disable", "plugins"],
    run: () =>
      Effect.gen(function* () {
        const plugins = (yield* control.plugins).filter((plugin) => plugin.locked === undefined);
        if (plugins.length === 0) return yield* nothing("host.toggle-plugin", "Every plugin is needed by the host");
        const id = yield* ask.select(
          "Turn which plugin on or off?",
          plugins.map((plugin) => ({ value: plugin.id, label: plugin.id, description: plugin.enabled ? `on · turn off` : `off · turn on` })),
        );
        const chosen = plugins.find((plugin) => plugin.id === id)!;
        const enabled = !chosen.enabled;
        const verb = enabled ? "on" : "off";
        const report = yield* control.configure({ [id]: { enabled } }, chosen.scope === "project" ? { scope: "project" } : undefined);
        // It restarts the transport, so it applies once this answer is out.
        if (report.deferred) return { message: `Turning ${id} ${verb}: the host restarts the plugins that use it, and clients reconnect` };
        // What runs is what the files say; if another file still decides the other way, say so rather than claim success.
        const after = (yield* control.plugins).find((plugin) => plugin.id === id);
        if (after !== undefined && after.enabled !== enabled) {
          return yield* nothing("host.toggle-plugin", `${id} is still ${after.enabled ? "on" : "off"}: the ${after.scope ?? "user"} config decides it`);
        }
        const also = describeReload(report, id);
        // On but not loaded: a plugin it needs is off, and it starts when that one does.
        const waiting = enabled && after?.state === undefined && after?.haltedBy !== undefined ? `; it starts when ${after.haltedBy} is on` : "";
        return { message: `Turned ${id} ${verb}${waiting}${also === undefined ? "" : `; ${also}`}` };
      }),
  },
];

export const llmCommands = (llm: Context.Tag.Service<typeof Llm>, ask: Ask): readonly Command[] => [
  {
    id: "llm.logout",
    title: "Log out of a provider…",
    category: "Providers",
    keywords: ["sign out", "credentials", "api key"],
    run: () =>
      Effect.gen(function* () {
        const providers = (yield* llm.providers).filter((provider) => provider.configured);
        if (providers.length === 0) return yield* nothing("llm.logout", "No provider is logged in");
        const id = yield* ask.select(
          "Log out of which provider?",
          providers.map((provider) => ({
            value: provider.id,
            label: provider.name,
            ...(provider.source === undefined ? {} : { description: provider.source }),
          })),
        );
        yield* llm.logout(id);
        return { message: `Logged out of ${providers.find((provider) => provider.id === id)?.name ?? id}` };
      }),
  },
];

export const workspaceCommands = (workspace: Context.Tag.Service<typeof Workspace>, ask: Ask): readonly Command[] => [
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

/**
 * One plugin per area, so a composition without `Llm` (say) still gets the
 * host and git commands. A reload swaps in the new commands without a gap: the
 * registry lets a plugin's replacement take over its ids.
 */
const commandsPlugin = <I, S>(id: string, service: Context.Tag<I, S>, commands: (service: S, ask: Ask) => readonly Command[]) =>
  definePlugin({
    id,
    version: "0.1.0",
    requires: [Commands, Interaction, service],
    layer: Layer.scopedDiscard(
      Effect.gen(function* () {
        const [registry, ask, dependency] = yield* Effect.all([Commands, Interaction, service]);
        yield* Effect.forEach(commands(dependency, ask), registry.register, { discard: true });
      }),
    ),
  });

export const host = commandsPlugin("commands-host", HostControl, hostCommands);
export const llm = commandsPlugin("commands-llm", Llm, llmCommands);
export const workspace = commandsPlugin("commands-workspace", Workspace, workspaceCommands);
