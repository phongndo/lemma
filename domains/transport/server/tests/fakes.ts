import { Deferred, Effect, Layer } from "effect";
import { HostControl, Interaction, InteractionError, InteractionHook, Paths, PluginsChanged, WebChanged } from "@lemma/contracts";
import { Commands } from "@lemma/commands";
import { pathsPlugin } from "@lemma/contracts/testing";
import type { ChangeReport, ConfigScope, InteractionAnswer, InteractionRequest, PluginInfo, WebComposition } from "@lemma/contracts";
import { definePlugin, Diagnostic, Events, Hooks, PluginContext, ReloadError } from "@lemma/core";
import type { Core } from "@lemma/core";

/** Runs `InteractionHook` the way the host's `Interaction` does: with no handler answering, `Unavailable`. */
export const fakeInteraction = definePlugin({
  id: "interaction",
  provides: [Interaction],
  layer: Layer.effect(
    Interaction,
    Effect.gen(function* () {
      const hooks = yield* Hooks;
      let count = 0;
      const ask = <V>(request: InteractionRequest, pick: (answer: InteractionAnswer) => V) =>
        hooks
          .invoke(InteractionHook, request, () => Effect.fail(new InteractionError({ reason: "Unavailable", message: "No answerer is attached" })))
          .pipe(Effect.map(pick), Effect.catchTags({ HookError: Effect.die, CoreClosed: Effect.die }));
      return {
        confirm: (title, detail) =>
          ask({ type: "confirm", id: `i${++count}`, title, ...(detail === undefined ? {} : { detail }) }, (answer) => answer.value === true),
        ask: (title) => ask({ type: "ask", id: `i${++count}`, title }, (answer) => String(answer.value)),
        select: (title, options) => ask({ type: "select", id: `i${++count}`, title, options }, (answer) => answer.value as never),
      };
    }),
  ),
});

/** Contributes one command that asks a question, as any plugin adding to the palette would. */
export const fakeGreeter = definePlugin({
  id: "greeter",
  requires: [Interaction],
  layer: Layer.effectDiscard(
    Effect.gen(function* () {
      const [owner, interaction] = yield* Effect.all([PluginContext, Interaction]);
      yield* owner.add(Commands, {
        id: "test.greet",
        title: "Greet…",
        category: "Test",
        run: ({ cwd, sessionId }) =>
          Effect.map(interaction.ask("Name?"), (name) => ({ message: `Hello, ${name}, in ${cwd}${sessionId === undefined ? "" : ` (${sessionId})`}` })),
      });
    }),
  ),
});

export interface ControlHolder {
  /** The test's core, once `makeCore` has returned it: what the host app's loader is to its handle. */
  readonly core: Deferred.Deferred<Core<any>>;
  /** Restarted ids; a forced restart is suffixed with `!`. */
  readonly restarted: string[];
  /** Plugins `configure` turned off, with the scope written. */
  readonly off: Record<string, ConfigScope>;
  /** What the web app plans from: the rows (`configure` merges its rows in and publishes it, as the host app does) and files. */
  web: WebComposition;
  /** What `reload` does instead of reporting a fixed change, when a test sets it. */
  reload?: Effect.Effect<ChangeReport, ReloadError>;
}

/** Delegates to the test's core, waiting until it exists, as the host app does with its loader. */
export const fakeHostControl = (holder: ControlHolder) =>
  definePlugin({
    id: "host",
    provides: [HostControl],
    layer: Layer.effect(
      HostControl,
      Effect.gen(function* () {
        const events = yield* Events;
        const core = Deferred.await(holder.core);
        // Every running plugin as a bundled catalog entry; one `configure` turned off is reported disabled (it keeps running here).
        const plugins = Effect.flatMap(core, (core) =>
          Effect.map(core.inspect, (snapshot): PluginInfo[] =>
            snapshot.plugins.map(({ id, version, provides, requires, ...rest }) => {
              const scope = holder.off[id];
              const base = { id, ...(version === undefined ? {} : { version }), source: "bundled" as const, provides, requires };
              return scope === undefined ? { ...base, ...rest, enabled: true } : { ...base, enabled: false, scope };
            }),
          ),
        );
        const changed = Effect.flatMap(plugins, (plugins) => events.publish(PluginsChanged, { plugins }));
        return {
          runtime: [Paths.key, HostControl.key],
          process: { pid: process.pid, startedAt: 0 },
          plugins,
          // Up once the core is, which the transport's startup gate waits for.
          composition: Effect.as(core, { id: "c0ffee", plugins: [{ id: "transport.server", version: "0.1.0" }] }),
          restart: (pluginId, options) =>
            Effect.gen(function* () {
              // As a bug in the host would.
              if (pluginId === "defect") return yield* Effect.die(new Error("restart bug"));
              const runtime = yield* core;
              if (!(yield* runtime.inspect).plugins.some((plugin) => plugin.id === pluginId)) {
                return yield* new ReloadError({
                  diagnostics: [new Diagnostic({ severity: "error", pluginId, message: `No plugin "${pluginId}"`, suggestion: "Check the id" })],
                });
              }
              holder.restarted.push(options?.force ? `${pluginId}!` : pluginId);
              yield* changed;
              return {};
            }),
          reload: Effect.suspend(
            () => holder.reload ?? Effect.succeed({ started: ["x"], stopped: [], restarted: [], unchanged: [], failed: [], interrupted: 0, faults: [] }),
          ),
          configure: (rows, options) =>
            Effect.gen(function* () {
              if (rows["transport.server"]?.enabled === false) {
                return yield* new ReloadError({
                  diagnostics: [
                    new Diagnostic({ severity: "error", pluginId: "transport.server", message: `"transport.server" cannot be turned off: serves the clients` }),
                  ],
                });
              }
              const scope = options?.scope ?? "user";
              for (const [id, row] of Object.entries(rows)) {
                if (row.enabled === false) holder.off[id] = scope;
                else if (row.enabled === true) delete holder.off[id];
              }
              // Every row is the web app's to read too: a plugin's one row decides both its halves.
              const written = { ...holder.web.plugins };
              for (const [id, row] of Object.entries(rows)) written[id] = { ...written[id], ...(row.enabled === undefined ? {} : { enabled: row.enabled }) };
              holder.web = { ...holder.web, plugins: written };
              yield* events.publish(WebChanged, holder.web);
              yield* changed;
              const ids = Object.keys(rows);
              return { started: [], stopped: ids.filter((id) => holder.off[id]), restarted: [], unchanged: [], failed: [], interrupted: 0, faults: [] };
            }),
          web: Effect.sync(() => holder.web),
        };
      }),
    ),
  });

export const fakePaths = (home: string) => pathsPlugin(home, { cwd: "/work" });
