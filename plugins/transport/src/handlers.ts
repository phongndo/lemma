import { Cause, Effect } from "effect";
import type { Context } from "effect";
import type { Registries } from "@lemma/core";
import { HostError, HostRpcs, Inspectors, InteractionOrigin, searchFiles } from "@lemma/contracts";
import type { Agent, Commands, ConfigureReport, HostControl, Llm, Paths, ReloadResult, Sessions, Workspace } from "@lemma/contracts";
import { toHostError, toPluginStatus } from "./errors.ts";
import type { Hub } from "./hub.ts";
import type { Interactions } from "./interactions.ts";
import type { makeLogins } from "./logins.ts";

interface HandlerServices {
  readonly version: string;
  readonly hub: Hub;
  readonly interactions: Interactions;
  readonly paths: Context.Tag.Service<Paths>;
  readonly sessions: Context.Tag.Service<Sessions>;
  readonly agent: Context.Tag.Service<Agent>;
  readonly llm: Context.Tag.Service<Llm>;
  readonly control: Context.Tag.Service<HostControl>;
  readonly workspace: Context.Tag.Service<Workspace>;
  readonly commands: Context.Tag.Service<Commands>;
  /** The core's registries: host plugins' `Inspectors` and `FileSearchers` are read from them. */
  readonly registries: Context.Tag.Service<Registries>;
  /** Runs `Llm.login` in the plugin's scope; see `makeLogins`. */
  readonly login: ReturnType<typeof makeLogins>;
}

const cwdOption = (cwd: string | undefined) => (cwd === undefined ? undefined : { cwd });

/** Every RPC maps to one capability call; only the error boundary is transport-specific. */
export const makeHandlers = ({ version, hub, interactions, paths, sessions, agent, llm, control, workspace, commands, registries, login }: HandlerServices) =>
  HostRpcs.of({
    "Session.List": ({ cwd }) => sessions.list(cwdOption(cwd)).pipe(Effect.mapError(toHostError)),
    "Session.Get": ({ sessionId }) => sessions.get(sessionId).pipe(Effect.mapError(toHostError)),
    "Session.Create": ({ cwd }) => sessions.create({ cwd: cwd ?? paths.cwd }).pipe(Effect.mapError(toHostError)),
    "Session.Events": ({ sessionId, after }) => sessions.events(sessionId, after === undefined ? undefined : { after }).pipe(Effect.mapError(toHostError)),
    "Session.Checkout": ({ sessionId, eventId }) => sessions.checkout(sessionId, eventId).pipe(Effect.mapError(toHostError)),
    "Session.SetTitle": ({ sessionId, title }) =>
      sessions.append(sessionId, { type: "title", title }).pipe(Effect.zipRight(sessions.get(sessionId)), Effect.mapError(toHostError)),
    "Session.Mark": ({ sessionId, pinned, archived }) =>
      sessions
        .mark(sessionId, { ...(pinned === undefined ? {} : { pinned }), ...(archived === undefined ? {} : { archived }) })
        .pipe(Effect.mapError(toHostError)),
    "Session.Delete": ({ sessionId }) =>
      Effect.gen(function* () {
        if ((yield* agent.running).includes(sessionId)) {
          return yield* new HostError({ code: "Busy", subject: sessionId, message: "A turn is running in this session; stop it before deleting" });
        }
        yield* sessions.remove(sessionId).pipe(Effect.mapError(toHostError));
      }),

    // The agent owns the turn's lifetime; this call only waits for it.
    "Agent.Prompt": ({ sessionId, content, options, requestId, whenBusy }) =>
      agent
        .prompt(sessionId, content, {
          ...options,
          ...(requestId === undefined ? {} : { requestId }),
          ...(whenBusy === undefined ? {} : { whenBusy }),
        })
        .pipe(Effect.mapError(toHostError)),
    "Agent.Cancel": ({ sessionId }) => agent.cancel(sessionId),
    "Agent.Running": () => agent.running,
    "Agent.Queue": ({ sessionId }) => agent.queue(sessionId),
    "Agent.Withdraw": ({ sessionId, requestId }) => agent.withdraw(sessionId, requestId),
    "Agent.View": ({ sessionId }) => agent.view(sessionId),

    "Llm.Providers": () => llm.providers,
    "Llm.Models": ({ available }) => llm.models(available === undefined ? undefined : { available }),
    // Like a turn, the login outlives this call: a dropped client can return and answer its questions.
    "Llm.Login": ({ provider, type }) => login(provider, type).pipe(Effect.mapError(toHostError)),
    "Llm.Logout": ({ provider }) => llm.logout(provider).pipe(Effect.mapError(toHostError)),
    "Llm.AddCustom": ({ spec }) => llm.addCustom(spec).pipe(Effect.mapError(toHostError)),
    "Llm.RemoveCustom": ({ provider }) => llm.removeCustom(provider).pipe(Effect.mapError(toHostError)),
    "Llm.SetLogo": ({ provider, svg }) => llm.setLogo(provider, svg).pipe(Effect.mapError(toHostError)),

    "Interaction.List": () => Effect.sync(() => [...interactions.open()]),
    "Interaction.Answer": ({ id, answer }) => interactions.answer(id, answer),
    "Interaction.Dismiss": ({ id }) => interactions.dismiss(id),

    "Workspace.Status": ({ path }) => workspace.status(path),
    "Workspace.Browse": ({ partialPath }) => workspace.browse(partialPath),
    "Workspace.CreateDirectory": ({ path }) => workspace.createDirectory(path).pipe(Effect.mapError(toHostError)),
    "Workspace.CreateWorktree": ({ path, branch, base }) =>
      workspace.createWorktree(path, base === undefined ? { branch } : { branch, base }).pipe(Effect.mapError(toHostError)),
    "Workspace.Branches": ({ path }) => workspace.branches(path).pipe(Effect.mapError(toHostError)),
    "Workspace.Checkout": ({ path, branch, create }) =>
      workspace.checkout(path, branch, create === undefined ? undefined : { create }).pipe(Effect.mapError(toHostError)),

    // Read at each call, not required: turning file search off leaves the transport, and everything else, running.
    "Files.Search": ({ cwd, query, limit, kind, within }) =>
      searchFiles(registries, cwd, query, {
        ...(limit === undefined ? {} : { limit }),
        ...(kind === undefined ? {} : { kind }),
        ...(within === undefined ? {} : { within }),
      }).pipe(Effect.mapError(toHostError)),

    "Command.List": () => commands.list,
    "Command.Run": ({ id, cwd, sessionId, origin }) =>
      commands
        .run(id, { cwd: cwd ?? paths.cwd, ...(sessionId === undefined ? {} : { sessionId }) })
        .pipe((run) => (origin === undefined ? run : Effect.locally(run, InteractionOrigin, origin)), Effect.mapError(toHostError)),

    "Host.Info": () => Effect.map(control.composition, (composition) => ({ version, cwd: paths.cwd, home: paths.home, composition })),
    "Host.Events": () => hub.events,
    "Host.Plugins": () => Effect.map(control.plugins, (plugins) => plugins.map(toPluginStatus)),
    "Host.Inspectors": () =>
      Effect.map(registries.items(Inspectors), (items) =>
        items.map(({ item, pluginId }) => ({
          id: item.id,
          title: item.title,
          ...(item.description === undefined ? {} : { description: item.description }),
          source: pluginId,
        })),
      ),
    "Host.Inspect": ({ id }) =>
      Effect.flatMap(registries.items(Inspectors), (items) => {
        const found = items.find((contribution) => contribution.item.id === id)?.item;
        if (found === undefined) return Effect.fail(new HostError({ code: "NotFound", subject: id, message: `No inspector "${id}"` }));
        // An inspector that fails or dies says so; it never takes the transport with it.
        return found.snapshot.pipe(
          Effect.catchAllCause((cause) => {
            const error = Cause.squash(cause);
            return Effect.fail(new HostError({ code: "Failed", subject: id, message: error instanceof Error ? error.message : String(error) }));
          }),
        );
      }),
    "Host.RestartPlugin": ({ pluginId, force }) => control.restart(pluginId, force === undefined ? undefined : { force }).pipe(Effect.mapError(toHostError)),
    "Host.Reload": () => control.reload.pipe(Effect.map(toReloadResult), Effect.mapError(toHostError)),
    "Host.Configure": ({ plugins, scope }) =>
      control.configure(plugins, scope === undefined ? undefined : { scope }).pipe(Effect.map(toReloadResult), Effect.mapError(toHostError)),

    "Ui.Composition": () => control.ui,
    "Ui.Configure": ({ plugins, scope }) => control.configureUi(plugins, scope === undefined ? undefined : { scope }).pipe(Effect.mapError(toHostError)),
  });

const toReloadResult = (report: ConfigureReport): ReloadResult => ({
  started: report.started,
  restarted: report.restarted,
  stopped: report.stopped,
  ...(report.failed.length > 0 ? { failed: report.failed } : {}),
  ...(report.deferred ? { deferred: true } : {}),
});
