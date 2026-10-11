import { Effect } from "effect";
import type { Context } from "effect";
import { definePlugin } from "@lemma/core";
import { describeReload, HostControl, Interaction, recoverable } from "@lemma/contracts";
import { CommandError, Commands } from "@lemma/commands";
import type { Command } from "@lemma/commands";

type Ask = Context.Service.Shape<typeof Interaction>;

/** A command's own dead end: nothing to choose from. Reported like any failure. */
const nothing = (command: string, message: string) => new CommandError({ command, reason: "Failed", message });

export const hostCommands = (control: Context.Service.Shape<typeof HostControl>, ask: Ask): readonly Command[] => [
  {
    id: "host.reload",
    title: "Reload config",
    category: "Host",
    description: "Re-read the config files and apply them",
    keywords: ["plugins", "composition", "settings"],
    run: () =>
      Effect.map(control.reload, (report) => {
        // It restarts what runs this command, so it applies once this answer is out.
        if (report.deferred) return { message: "Reloading config: the host restarts the plugins it changes once this command has ended" };
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
        // A running plugin restarts with its dependents, so one the host pins, or that a pinned plugin needs, is left out.
        const plugins = (yield* control.plugins).filter((plugin) => recoverable(plugin) || (plugin.state === "active" && plugin.locked === undefined));
        if (plugins.length === 0) return yield* nothing("host.restart-plugin", "No plugin can be restarted");
        const id = yield* ask.select(
          "Restart which plugin?",
          plugins.map((plugin) => ({ value: plugin.id, label: plugin.id, description: plugin.state! })),
        );
        const chosen = plugins.find((plugin) => plugin.id === id)!;
        const report = yield* control.restart(id, chosen.state === "active" ? { force: true } : undefined);
        // It restarts what runs this command, so it applies once this answer is out.
        return { message: report.deferred ? `Restarting ${id} once this command has ended` : `Restarted ${id}` };
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
        // It restarts what runs this command, so it applies once this answer is out.
        if (report.deferred) return { message: `Turning ${id} ${verb} once this command has ended` };
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

/** The host's own commands: reload the config, restart a plugin, turn one on or off. */
export default definePlugin({
  id: "commands.host",
  version: "0.1.0",
  requires: { ask: Interaction, dependency: HostControl },
  setup: ({ ask, dependency }, owner) => Effect.forEach(hostCommands(dependency, ask), (command) => owner.add(Commands, command), { discard: true }),
});
