import { randomUUID } from "node:crypto";
import { Effect, Layer, Stream } from "effect";
import {
  Agent,
  AgentError,
  AssistantDelta,
  Commands,
  emptyUsage,
  HostControl,
  Interaction,
  InteractionError,
  InteractionHook,
  Llm,
  LlmError,
  Paths,
  PluginsChanged,
  SessionAppended,
  SessionChanged,
  SessionError,
  SessionRemoved,
  Sessions,
  TurnEnded,
  TurnStarted,
  UiChanged,
  Workspace,
  WorkspaceError,
} from "@lemma/contracts";
import type {
  AssistantMessage,
  ConfigScope,
  GitBranch,
  InteractionAnswer,
  InteractionRequest,
  ModelInfo,
  PluginInfo,
  PromptOptions,
  SessionEvent,
  SessionInfo,
  UiComposition,
  WorkspaceStatus,
} from "@lemma/contracts";
import { definePlugin, Events, Hooks, ReloadError, Diagnostic } from "@lemma/core";
import type { Core } from "@lemma/core";

/** In-memory session logs that publish the same events the real plugin does. */
export const fakeSessions = definePlugin({
  id: "sessions",
  provides: [Sessions],
  layer: Layer.effect(
    Sessions,
    Effect.gen(function* () {
      const events = yield* Events;
      const store = new Map<string, { info: SessionInfo; events: SessionEvent[] }>();
      let count = 0;
      const find = (sessionId: string) =>
        Effect.suspend(() => {
          const session = store.get(sessionId);
          return session === undefined
            ? Effect.fail(new SessionError({ sessionId, reason: "NotFound", message: `No session "${sessionId}"` }))
            : Effect.succeed(session);
        });
      return {
        create: (options) =>
          Effect.gen(function* () {
            const now = Date.now();
            const info: SessionInfo = { id: `s${++count}`, cwd: options?.cwd ?? "/default", createdAt: now, updatedAt: now, lastSeq: 0 };
            store.set(info.id, { info, events: [] });
            yield* events.publish(SessionChanged, { info });
            return info;
          }),
        list: (options) =>
          Effect.sync(() => [...store.values()].map((session) => session.info).filter((info) => options?.cwd === undefined || info.cwd === options.cwd)),
        get: (sessionId) => Effect.map(find(sessionId), (session) => session.info),
        append: (sessionId, data, options) =>
          Effect.gen(function* () {
            const session = yield* find(sessionId);
            const event: SessionEvent = {
              seq: session.events.length + 1,
              id: randomUUID(),
              parent: options?.parent ?? session.info.leaf ?? null,
              at: Date.now(),
              data,
            };
            session.events.push(event);
            session.info = {
              ...session.info,
              leaf: event.id,
              lastSeq: event.seq,
              updatedAt: event.at,
              ...(data.type === "title" ? { title: data.title } : {}),
            };
            yield* events.publish(SessionAppended, { sessionId, event });
            yield* events.publish(SessionChanged, { info: session.info });
            return event;
          }),
        events: (sessionId, options) => Effect.map(find(sessionId), (session) => session.events.filter((event) => event.seq > (options?.after ?? 0))),
        branch: (sessionId) => Effect.map(find(sessionId), (session) => session.events),
        checkout: (sessionId, eventId) =>
          Effect.gen(function* () {
            const session = yield* find(sessionId);
            if (!session.events.some((event) => event.id === eventId)) {
              return yield* new SessionError({ sessionId, reason: "InvalidParent", message: `No event "${eventId}"` });
            }
            session.info = { ...session.info, leaf: eventId };
            return session.info;
          }),
        mark: (sessionId, marks) =>
          Effect.gen(function* () {
            const session = yield* find(sessionId);
            const { pinned: _pinned, archived: _archived, ...rest } = session.info;
            const pinned = marks.pinned ?? session.info.pinned === true;
            const archived = marks.archived ?? session.info.archived === true;
            session.info = { ...rest, ...(pinned ? { pinned } : {}), ...(archived ? { archived } : {}) };
            yield* events.publish(SessionChanged, { info: session.info });
            return session.info;
          }),
        remove: (sessionId) =>
          Effect.gen(function* () {
            yield* find(sessionId);
            store.delete(sessionId);
            yield* events.publish(SessionRemoved, { sessionId });
          }),
      };
    }),
  ),
});

const reply = (text: string): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "fake",
  provider: "fake",
  model: "echo",
  usage: emptyUsage,
  stopReason: "stop",
  timestamp: Date.now(),
});

/** The options of every prompt the fake agent received, for checking what the transport passes on. */
export const prompted: PromptOptions[] = [];

/** Echoes the prompt in two deltas and records both messages. */
export const fakeAgent = definePlugin({
  id: "agent",
  provides: [Agent],
  requires: [Sessions],
  layer: Layer.effect(
    Agent,
    Effect.gen(function* () {
      const events = yield* Events;
      const sessions = yield* Sessions;
      const running = new Set<string>();
      let turns = 0;
      const session = (sessionId: string) => (error: SessionError) => new AgentError({ sessionId, reason: "Session", message: error.message, cause: error });
      return {
        prompt: (sessionId, content, options) =>
          Effect.gen(function* () {
            prompted.push(options ?? {});
            if (running.has(sessionId)) return yield* new AgentError({ sessionId, reason: "Busy", message: "A turn is running" });
            running.add(sessionId);
            const turnId = `t${++turns}`;
            yield* sessions
              .append(sessionId, { type: "message", message: { role: "user", content, timestamp: Date.now() } })
              .pipe(Effect.mapError(session(sessionId)));
            yield* events.publish(TurnStarted, { sessionId, turnId });
            const text = `echo: ${content.map((part) => (part.type === "text" ? part.text : "")).join("")}`;
            for (const [index, delta] of [text.slice(0, 6), text.slice(6)].entries()) {
              yield* events.publish(AssistantDelta, { sessionId, turnId, stepId: "p1", seq: index + 1, event: { type: "text-delta", index, delta } });
            }
            yield* sessions.append(sessionId, { type: "message", message: reply(text), turnId }).pipe(Effect.mapError(session(sessionId)));
            yield* events.publish(TurnEnded, { sessionId, turnId, usage: emptyUsage, reason: "done" as const });
          }).pipe(Effect.ensuring(Effect.sync(() => running.delete(sessionId)))),
        cancel: () => Effect.void,
        busy: (sessionId) => Effect.sync(() => running.has(sessionId)),
        running: Effect.sync(() => [...running]),
        queue: () => Effect.succeed([]),
        withdraw: () => Effect.succeed(false),
        view: () => Effect.succeed({ output: [], queue: [], queueRevision: 0 }),
      };
    }),
  ),
});

const model: ModelInfo = {
  ref: "fake/echo",
  provider: "fake",
  id: "echo",
  name: "Echo",
  api: "fake",
  reasoning: false,
  thinkingLevels: [],
  input: ["text"],
  contextWindow: 1000,
  maxTokens: 100,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

/** Login asks through `Interaction`, so a login RPC exercises the interaction round trip. */
export const fakeLlm = definePlugin({
  id: "llm",
  provides: [Llm],
  requires: [Interaction],
  layer: Layer.effect(
    Llm,
    Effect.map(Interaction, (interaction) => ({
      providers: Effect.succeed([{ id: "fake", name: "Fake", auth: [{ type: "api_key" as const, name: "API key", interactive: true }], configured: true }]),
      models: (options) => Effect.succeed(options?.available === false ? [] : [model]),
      model: (ref) => (ref === model.ref ? Effect.succeed(model) : Effect.fail(new LlmError({ reason: "UnknownModel", message: `No model ${ref}` }))),
      stream: () => Stream.empty,
      login: (provider) =>
        provider !== "fake"
          ? Effect.fail(new LlmError({ reason: "UnknownProvider", message: `No provider "${provider}"` }))
          : interaction.ask("API key", { secret: true }).pipe(
              Effect.flatMap((key) => (key === "good" ? Effect.void : Effect.fail(new LlmError({ reason: "LoginFailed", message: "bad key" })))),
              Effect.mapError((error) => (error instanceof LlmError ? error : new LlmError({ reason: "LoginFailed", message: error.message, cause: error }))),
            ),
      logout: () => Effect.void,
      addCustom: (spec) => Effect.succeed(spec.name.toLowerCase()),
      removeCustom: () => Effect.void,
      setLogo: () => Effect.void,
    })),
  ),
});

/** Runs `InteractionHook` the way the interaction plugin does: with no handler answering, `Unavailable`. */
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
  requires: [Commands, Interaction],
  layer: Layer.scopedDiscard(
    Effect.gen(function* () {
      const [commands, interaction] = yield* Effect.all([Commands, Interaction]);
      yield* commands.register({
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
  core?: Core<any>;
  /** Restarted ids; a forced restart is suffixed with `!`. */
  readonly restarted: string[];
  /** Plugins `configure` turned off, with the scope written. */
  readonly off: Record<string, ConfigScope>;
  /** The web app's rows and files; `configureUi` merges rows in and publishes it, as the host app does. */
  ui: UiComposition;
}

/** Delegates to the test's core once it exists, as the host app does with its loader. */
export const fakeHostControl = (holder: ControlHolder) =>
  definePlugin({
    id: "host",
    provides: [HostControl],
    layer: Layer.effect(
      HostControl,
      Effect.gen(function* () {
        const events = yield* Events;
        const core = Effect.suspend(() => (holder.core === undefined ? Effect.dieMessage("core not attached") : Effect.succeed(holder.core)));
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
          plugins,
          composition: Effect.succeed({ id: "c0ffee", plugins: [{ id: "transport", version: "0.1.0" }] }),
          restart: (pluginId, options) =>
            Effect.gen(function* () {
              const runtime = yield* core;
              if (!(yield* runtime.inspect).plugins.some((plugin) => plugin.id === pluginId)) {
                return yield* new ReloadError({
                  diagnostics: [new Diagnostic({ severity: "error", pluginId, message: `No plugin "${pluginId}"`, suggestion: "Check the id" })],
                });
              }
              holder.restarted.push(options?.force ? `${pluginId}!` : pluginId);
              yield* changed;
            }),
          reload: Effect.succeed({ started: ["x"], stopped: [], restarted: [], unchanged: [], failed: [], interrupted: 0, faults: [] }),
          configure: (rows, options) =>
            Effect.gen(function* () {
              if (rows.transport?.enabled === false) {
                return yield* new ReloadError({
                  diagnostics: [new Diagnostic({ severity: "error", pluginId: "transport", message: `"transport" cannot be turned off: serves the clients` })],
                });
              }
              const scope = options?.scope ?? "user";
              for (const [id, row] of Object.entries(rows)) {
                if (row.enabled === false) holder.off[id] = scope;
                else if (row.enabled === true) delete holder.off[id];
              }
              yield* changed;
              const ids = Object.keys(rows);
              return { started: [], stopped: ids.filter((id) => holder.off[id]), restarted: [], unchanged: [], failed: [], interrupted: 0, faults: [] };
            }),
          ui: Effect.sync(() => holder.ui),
          configureUi: (rows) =>
            Effect.gen(function* () {
              const plugins = { ...holder.ui.plugins };
              for (const [id, row] of Object.entries(rows)) plugins[id] = { ...plugins[id], ...(row.enabled === undefined ? {} : { enabled: row.enabled }) };
              holder.ui = { ...holder.ui, plugins };
              yield* events.publish(UiChanged, holder.ui);
              return holder.ui;
            }),
        };
      }),
    ),
  });

export const fakePaths = (home: string) =>
  definePlugin({
    id: "paths",
    provides: [Paths],
    layer: Layer.succeed(Paths, {
      home,
      userConfig: `${home}/config.jsonc`,
      projectConfig: "/work/.lemma/config.jsonc",
      auth: `${home}/auth.json`,
      sessions: `${home}/sessions`,
      cwd: "/work",
    }),
  });

/** `/work` is a repository with branches `main` (current) and `dev`; every other path is a plain directory. */
export const fakeWorkspace = definePlugin({
  id: "workspace",
  provides: [Workspace],
  layer: Layer.sync(Workspace, () => {
    let current = "main";
    const known = ["main", "dev"];
    const status = (path: string): WorkspaceStatus =>
      path !== "/work"
        ? { path, exists: true }
        : {
            path,
            exists: true,
            git: { root: "/work", branch: current, head: "abc1234", changes: 0, ahead: 0, behind: 0 },
          };
    const repository = (path: string) =>
      path === "/work" ? Effect.void : Effect.fail(new WorkspaceError({ path, reason: "NotRepository", message: `"${path}" is not in a git work tree` }));
    return {
      status: (path) => Effect.sync(() => status(path)),
      browse: (partialPath) =>
        Effect.succeed({
          parent: "/",
          entries: partialPath.startsWith("/w") ? [{ name: "work", path: "/work", git: true, matches: [0] }] : [],
          truncated: false,
        }),
      createDirectory: (path) => Effect.succeed({ path, exists: true }),
      createWorktree: (path, options) =>
        Effect.succeed({
          path: `/worktrees/${options.branch}`,
          exists: true,
          git: { root: `/worktrees/${options.branch}`, branch: options.branch, changes: 0, ahead: 0, behind: 0, worktreeOf: path },
        }),
      branches: (path) =>
        Effect.as(
          repository(path),
          known.map((name): GitBranch => ({ name, current: name === current, remote: false, updatedAt: 0 })),
        ),
      checkout: (path, branch, options) =>
        Effect.flatMap(repository(path), () =>
          Effect.suspend(() => {
            if (options?.create === true) known.push(branch);
            else if (!known.includes(branch)) {
              return Effect.fail(new WorkspaceError({ path, reason: "Failed", message: `fatal: invalid reference: ${branch}` }));
            }
            current = branch;
            return Effect.succeed(status(path));
          }),
        ),
    };
  }),
});
