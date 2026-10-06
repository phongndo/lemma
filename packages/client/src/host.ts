import { Cause, Deferred, Duration, Effect, Exit, Fiber, Scope, Stream } from "effect";
import type { Layer } from "effect";
import type { Socket } from "effect/socket";
import { HostError, SUBSCRIBED_HEADER } from "@lemma/contracts";
import type {
  AgentView,
  AuthType,
  CustomProviderSpec,
  CommandInfo,
  CommandResult,
  ConfigScope,
  DirectoryListing,
  FileSearchOptions,
  FileSearchResult,
  GitBranch,
  HostEvent,
  HostInfo,
  InteractionAnswer,
  InteractionRequest,
  ModelInfo,
  PluginChange,
  InspectorInfo,
  PluginStatus,
  PromptContent,
  ProviderInfo,
  QueuedPrompt,
  ReloadResult,
  SessionEvent,
  SessionInfo,
  SessionMarks,
  TurnOptions,
  UiComposition,
  WhenBusy,
  WorkspaceStatus,
} from "@lemma/contracts";
import { makeHostRpc, rpcUrl } from "./rpc.ts";
import type { HostRpcClient } from "./rpc.ts";

export type ConnectionState = "connecting" | "connected" | "reconnecting" | "closed";

export interface ConnectionStatus {
  readonly state: ConnectionState;
  /** Increments on every successful (re)connect; resync when it changes. */
  readonly generation: number;
  /** Failed attempts since the last successful connect. */
  readonly attempts: number;
  /** Epoch ms of the next attempt while reconnecting. */
  readonly retryAt?: number;
  readonly error?: string;
}

/**
 * Promise-returning facade over `HostRpcs`. Methods reject with `HostError`
 * for domain failures and a plain `Error` for transport failures. The web app
 * depends on this interface only, so a fake can stand in for it.
 */
export interface Host {
  readonly session: {
    readonly list: (cwd?: string) => Promise<readonly SessionInfo[]>;
    readonly get: (sessionId: string) => Promise<SessionInfo>;
    readonly create: (cwd?: string) => Promise<SessionInfo>;
    readonly events: (sessionId: string, after?: number) => Promise<readonly SessionEvent[]>;
    readonly checkout: (sessionId: string, eventId: string) => Promise<SessionInfo>;
    readonly setTitle: (sessionId: string, title: string) => Promise<SessionInfo>;
    readonly mark: (sessionId: string, marks: SessionMarks) => Promise<SessionInfo>;
    /** Deletes it for good; rejects `Busy` while a turn runs in it. */
    readonly remove: (sessionId: string) => Promise<void>;
  };
  readonly agent: {
    /**
     * Resolves when the turn that places the prompt ends. While a turn runs,
     * `whenBusy` says whether it steers that turn, follows it (the default),
     * or is refused; `requestId` makes it exactly-once (see `Agent.prompt`).
     */
    readonly prompt: (
      sessionId: string,
      content: PromptContent,
      options?: TurnOptions,
      submit?: { readonly requestId?: string; readonly whenBusy?: WhenBusy },
    ) => Promise<void>;
    readonly cancel: (sessionId: string) => Promise<void>;
    readonly running: () => Promise<readonly string[]>;
    /** Prompts waiting for a turn, oldest first. */
    readonly queue: (sessionId: string) => Promise<readonly QueuedPrompt[]>;
    /** Takes a queued prompt out; false when a turn had placed it already. */
    readonly withdraw: (sessionId: string, requestId: string) => Promise<boolean>;
    /** The session as a client joining now shows it: model and tool output so far, and the queue. */
    readonly view: (sessionId: string) => Promise<AgentView>;
  };
  readonly llm: {
    readonly providers: () => Promise<readonly ProviderInfo[]>;
    readonly models: (available?: boolean) => Promise<readonly ModelInfo[]>;
    readonly login: (provider: string, type: AuthType) => Promise<void>;
    readonly logout: (provider: string) => Promise<void>;
    /** Adds a provider of the user's; resolves with its id once saved (listed once `providers` lists it). */
    readonly addCustom: (spec: CustomProviderSpec) => Promise<string>;
    readonly removeCustom: (provider: string) => Promise<void>;
    readonly setLogo: (provider: string, svg: string | undefined) => Promise<void>;
  };
  readonly interaction: {
    /** Questions still waiting on an answer. */
    readonly list: () => Promise<readonly InteractionRequest[]>;
    readonly answer: (id: string, answer: InteractionAnswer) => Promise<void>;
    readonly dismiss: (id: string) => Promise<void>;
  };
  readonly workspace: {
    readonly status: (path: string) => Promise<WorkspaceStatus>;
    readonly browse: (partialPath: string) => Promise<DirectoryListing>;
    readonly createDirectory: (path: string) => Promise<WorkspaceStatus>;
    readonly createWorktree: (path: string, options: { branch: string; base?: string }) => Promise<WorkspaceStatus>;
    readonly branches: (path: string) => Promise<readonly GitBranch[]>;
    readonly checkout: (path: string, branch: string, options?: { create?: boolean }) => Promise<WorkspaceStatus>;
  };
  readonly files: {
    /** Entries in `cwd` matching `query`, best first (see `FileSearcher` in the contracts); rejects `NotFound` or `Unavailable`. */
    readonly search: (cwd: string, query: string, options?: FileSearchOptions) => Promise<FileSearchResult>;
  };
  readonly commands: {
    readonly list: () => Promise<readonly CommandInfo[]>;
    /** Resolves when the command ends; its questions arrive as `interaction` events. */
    readonly run: (id: string, context?: { cwd?: string; sessionId?: string }) => Promise<CommandResult>;
  };
  readonly host: {
    readonly info: () => Promise<HostInfo>;
    /** Every known plugin, enabled or not. */
    readonly plugins: () => Promise<readonly PluginStatus[]>;
    /** What host plugins let you look into, and one's snapshot (plain JSON). */
    readonly inspectors: () => Promise<readonly InspectorInfo[]>;
    readonly inspect: (id: string) => Promise<unknown>;
    /** A failed or halted plugin and its dependents; `force` also replaces a running one. */
    readonly restartPlugin: (pluginId: string, options?: { force?: boolean }) => Promise<void>;
    readonly reload: () => Promise<ReloadResult>;
    /** Write plugin rows into the user (default) or project config file and apply them; a rejected change is undone. */
    readonly configure: (plugins: Readonly<Record<string, PluginChange>>, options?: { scope?: ConfigScope }) => Promise<ReloadResult>;
  };
  readonly ui: {
    /** The web app's `ui` rows and UI files, which it plans and runs itself. */
    readonly composition: () => Promise<UiComposition>;
    /** Write `ui` rows; every client hears `ui-changed`. */
    readonly configure: (plugins: Readonly<Record<string, PluginChange>>, options?: { scope?: ConfigScope }) => Promise<UiComposition>;
  };
  readonly status: () => ConnectionStatus;
  /** Called immediately with the current status, then on every change. */
  readonly onStatus: (listener: (status: ConnectionStatus) => void) => () => void;
  /** Live `Host.Events`. Losable: repair from `Session.Events` (see `SessionLog`). */
  readonly onEvent: (listener: (event: HostEvent) => void) => () => void;
  readonly close: () => Promise<void>;
}

export interface ConnectOptions {
  /** Page or host base URL; `/rpc` is resolved against it. */
  readonly url: string;
  readonly token?: string | undefined;
  /** Delay before reconnect attempt `n` (1-based). Default: 250ms doubling, capped at 5s. */
  readonly backoff?: (attempt: number) => number;
  /** How long a connect probe may take before the attempt counts as failed. Default 8s. */
  readonly probeTimeoutMs?: number;
  /** The WebSocket implementation; default the platform's (tests script one). */
  readonly webSocket?: Layer.Layer<Socket.WebSocketConstructor>;
}

export const defaultBackoff = (attempt: number): number => Math.min(5_000, 250 * 2 ** Math.max(0, attempt - 1));

/** Runs an effect to a promise that rejects with the squashed failure rather than a FiberFailure wrapper. */
export const runPromise = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromiseExit(effect).then((exit) => (Exit.isSuccess(exit) ? exit.value : Promise.reject(toError(Cause.squash(exit.cause)))));

const toError = (error: unknown): unknown => {
  if (error instanceof HostError || error instanceof Error) return error;
  if (typeof error === "object" && error !== null && "message" in error) return new Error(String(error.message));
  return new Error(String(error));
};

export const describeError = (error: unknown): string => {
  if (error instanceof HostError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
};

/**
 * Opens the connection and keeps a `Host.Events` subscription alive with
 * backoff. Each (re)connect is confirmed with `Host.Info`, and by the host's
 * `subscribed` (not passed to listeners), before the status turns `connected`,
 * so `generation` changes only when calls can succeed and events arrive. A host
 * from before `subscribed` sends none: the wait for it then ends at the probe's
 * timeout.
 */
export const connect = async (options: ConnectOptions): Promise<Host> => {
  const scope = await runPromise(Scope.make());
  const rpc: HostRpcClient = await runPromise(Scope.provide(makeHostRpc(rpcUrl(options.url, options.token), options.webSocket), scope));
  const backoff = options.backoff ?? defaultBackoff;
  const probeTimeout = Duration.millis(options.probeTimeoutMs ?? 8_000);

  let status: ConnectionStatus = { state: "connecting", generation: 0, attempts: 0 };
  const statusListeners = new Set<(status: ConnectionStatus) => void>();
  const eventListeners = new Set<(event: HostEvent) => void>();
  const setStatus = (next: ConnectionStatus) => {
    status = next;
    for (const listener of statusListeners) listener(next);
  };
  const emit = (event: HostEvent) => {
    for (const listener of eventListeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("Host event listener failed", error);
      }
    }
  };

  const attempt = Effect.gen(function* () {
    // Subscribe first so nothing published after the probe is missed.
    const subscribed = yield* Deferred.make<void>();
    const events = yield* rpc["Host.Events"](undefined, { headers: { [SUBSCRIBED_HEADER]: "1" } }).pipe(
      Stream.runForEach((event) => (event.type === "subscribed" ? Deferred.succeed(subscribed, undefined) : Effect.sync(() => emit(event)))),
      Effect.forkChild({ startImmediately: true }),
    );
    const probe = yield* rpc["Host.Info"]().pipe(
      Effect.timeoutOrElse({ duration: probeTimeout, orElse: () => Effect.fail(new Error("Timed out")) }),
      Effect.result,
    );
    if (probe._tag === "Failure") {
      yield* Fiber.interrupt(events);
      return describeError(toError(probe.failure));
    }
    // Connected once `subscribed` arrives, not on a subscription that ended before it did.
    const ready = yield* Effect.raceFirst(
      Deferred.await(subscribed).pipe(Effect.timeoutOrElse({ duration: probeTimeout, orElse: () => Effect.void }), Effect.as(true)),
      Effect.as(Fiber.await(events), false),
    );
    // The acknowledgement may have come before the subscription ended: connected only while it still runs.
    if (!ready || events.pollUnsafe() !== undefined) {
      const exit = yield* Fiber.await(events);
      return Exit.isFailure(exit) ? describeError(toError(Cause.squash(exit.cause))) : "Event stream ended";
    }
    setStatus({ state: "connected", generation: status.generation + 1, attempts: 0 });
    const exit = yield* Fiber.await(events);
    return Exit.isFailure(exit) ? describeError(toError(Cause.squash(exit.cause))) : "Event stream ended";
  });

  const loop = Effect.gen(function* () {
    for (;;) {
      const error = yield* attempt;
      const attempts = status.attempts + 1;
      const delay = backoff(attempts);
      setStatus({
        state: status.generation === 0 ? "connecting" : "reconnecting",
        generation: status.generation,
        attempts,
        retryAt: Date.now() + delay,
        error,
      });
      yield* Effect.sleep(Duration.millis(delay));
    }
  });
  const fiber = Effect.runFork(loop);

  const unit = <E>(effect: Effect.Effect<unknown, E>) => runPromise(Effect.asVoid(effect));

  return {
    session: {
      list: (cwd) => runPromise(rpc["Session.List"](cwd === undefined ? {} : { cwd })),
      get: (sessionId) => runPromise(rpc["Session.Get"]({ sessionId })),
      create: (cwd) => runPromise(rpc["Session.Create"](cwd === undefined ? {} : { cwd })),
      events: (sessionId, after) => runPromise(rpc["Session.Events"](after === undefined ? { sessionId } : { sessionId, after })),
      checkout: (sessionId, eventId) => runPromise(rpc["Session.Checkout"]({ sessionId, eventId })),
      setTitle: (sessionId, title) => runPromise(rpc["Session.SetTitle"]({ sessionId, title })),
      mark: (sessionId, marks) => runPromise(rpc["Session.Mark"]({ sessionId, ...marks })),
      remove: (sessionId) => unit(rpc["Session.Delete"]({ sessionId })),
    },
    agent: {
      prompt: (sessionId, content, turn, submit) =>
        unit(
          rpc["Agent.Prompt"]({
            sessionId,
            content,
            ...(turn === undefined ? {} : { options: turn }),
            ...(submit?.requestId === undefined ? {} : { requestId: submit.requestId }),
            ...(submit?.whenBusy === undefined ? {} : { whenBusy: submit.whenBusy }),
          }),
        ),
      cancel: (sessionId) => unit(rpc["Agent.Cancel"]({ sessionId })),
      running: () => runPromise(rpc["Agent.Running"]()),
      queue: (sessionId) => runPromise(rpc["Agent.Queue"]({ sessionId })),
      withdraw: (sessionId, requestId) => runPromise(rpc["Agent.Withdraw"]({ sessionId, requestId })),
      view: (sessionId) => runPromise(rpc["Agent.View"]({ sessionId })),
    },
    llm: {
      providers: () => runPromise(rpc["Llm.Providers"]()),
      models: (available) => runPromise(rpc["Llm.Models"](available === undefined ? {} : { available })),
      login: (provider, type) => unit(rpc["Llm.Login"]({ provider, type })),
      logout: (provider) => unit(rpc["Llm.Logout"]({ provider })),
      addCustom: (spec) => runPromise(rpc["Llm.AddCustom"]({ spec })),
      removeCustom: (provider) => unit(rpc["Llm.RemoveCustom"]({ provider })),
      setLogo: (provider, svg) => unit(rpc["Llm.SetLogo"]({ provider, ...(svg === undefined ? {} : { svg }) })),
    },
    interaction: {
      list: () => runPromise(rpc["Interaction.List"]()),
      answer: (id, answer) => unit(rpc["Interaction.Answer"]({ id, answer })),
      dismiss: (id) => unit(rpc["Interaction.Dismiss"]({ id })),
    },
    workspace: {
      status: (path) => runPromise(rpc["Workspace.Status"]({ path })),
      browse: (partialPath) => runPromise(rpc["Workspace.Browse"]({ partialPath })),
      createDirectory: (path) => runPromise(rpc["Workspace.CreateDirectory"]({ path })),
      createWorktree: (path, options) =>
        runPromise(
          rpc["Workspace.CreateWorktree"](options.base === undefined ? { path, branch: options.branch } : { path, branch: options.branch, base: options.base }),
        ),
      branches: (path) => runPromise(rpc["Workspace.Branches"]({ path })),
      checkout: (path, branch, options) =>
        runPromise(rpc["Workspace.Checkout"](options?.create === undefined ? { path, branch } : { path, branch, create: options.create })),
    },
    files: {
      search: (cwd, query, options) => runPromise(rpc["Files.Search"]({ cwd, query, ...options })),
    },
    commands: {
      list: () => runPromise(rpc["Command.List"]()),
      run: (id, context) =>
        runPromise(
          rpc["Command.Run"]({
            id,
            ...(context?.cwd === undefined ? {} : { cwd: context.cwd }),
            ...(context?.sessionId === undefined ? {} : { sessionId: context.sessionId }),
          }),
        ),
    },
    host: {
      info: () => runPromise(rpc["Host.Info"]()),
      plugins: () => runPromise(rpc["Host.Plugins"]()),
      inspectors: () => runPromise(rpc["Host.Inspectors"]()),
      inspect: (id) => runPromise(rpc["Host.Inspect"]({ id })),
      restartPlugin: (pluginId, options) => unit(rpc["Host.RestartPlugin"](options?.force === undefined ? { pluginId } : { pluginId, force: options.force })),
      reload: () => runPromise(rpc["Host.Reload"]()),
      configure: (plugins, options) => runPromise(rpc["Host.Configure"](options?.scope === undefined ? { plugins } : { plugins, scope: options.scope })),
    },
    ui: {
      composition: () => runPromise(rpc["Ui.Composition"]()),
      configure: (plugins, options) => runPromise(rpc["Ui.Configure"](options?.scope === undefined ? { plugins } : { plugins, scope: options.scope })),
    },
    status: () => status,
    onStatus: (listener) => {
      statusListeners.add(listener);
      listener(status);
      return () => {
        statusListeners.delete(listener);
      };
    },
    onEvent: (listener) => {
      eventListeners.add(listener);
      return () => {
        eventListeners.delete(listener);
      };
    },
    close: async () => {
      await runPromise(Fiber.interrupt(fiber));
      await runPromise(Scope.close(scope, Exit.void));
      setStatus({ ...status, state: "closed" });
      statusListeners.clear();
      eventListeners.clear();
    },
  };
};
