import {
  Cause,
  Context,
  Data,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  PubSub,
  Result,
  Schedule,
  Scope,
  Semaphore,
  Stream,
  Tracer,
} from "effect";
import type { Pull } from "effect";
import type { ApplicationServices, Core, CoreOptions, CoreSnapshot, PluginSnapshot, PluginState } from "../core.ts";
import { CapabilityMismatch, CompositionError, CoreClosed, DeadlineExceeded, Diagnostic, PluginFault, ReloadError, ShutdownTimeout } from "../errors.ts";
import type { ReportedFault } from "../errors.ts";
import { Events } from "../events.ts";
import { Hooks, PluginContext } from "../hooks.ts";
import { Registries } from "../registries.ts";
import type { PluginIdentity } from "../hooks.ts";
import type { ReloadReport } from "../loader.ts";
import type { Capability, Plugin } from "../plugin.ts";
import { EventBus } from "./events.ts";
import type { ObserverHandle } from "./events.ts";
import { plan, reservedByApplication } from "./graph.ts";
import { attributes, HookRegistry } from "./hooks.ts";
import type { OwnerHandle } from "./hooks.ts";
import { makeOwnServices } from "./own.ts";
import type { OwnServices } from "./own.ts";
import { RegistryStore } from "./registries.ts";
import { runtimeSettings } from "./settings.ts";
import type { ContributorHandle } from "./registries.ts";

/** A plugin and its raw (undecoded) config. */
export interface Member {
  readonly plugin: Plugin;
  readonly config?: unknown;
}

/** Planning found problems; nothing was activated. */
export class PlanError extends Data.TaggedError("PlanError")<{
  readonly errors: readonly [CompositionError, ...CompositionError[]];
}> {}

type ApplyError = PlanError | PluginFault;

/** A change that tolerates activation failures: only `required` plugins (and what they need) must activate. */
export interface PartialStart {
  readonly required: ReadonlySet<string>;
}

interface Runtime {
  readonly core: Core<any>;
  /**
   * Transactional change to the running composition; see DESIGN.md. With
   * `partial`, a plugin that fails to activate is left failed instead, unless
   * it is required or something required needs it.
   */
  readonly apply: (members: readonly Member[], onApplied?: () => void, partial?: PartialStart) => Effect.Effect<ReloadReport, ApplyError>;
  /** Begin shutdown now and wait within the closing-caller deadline. */
  readonly shutdown: Effect.Effect<void>;
}

const DEFAULTS = { activate: Duration.seconds(30), dispose: Duration.seconds(10) };

interface Instance {
  readonly id: string;
  readonly plugin: Plugin;
  readonly rawConfig: unknown;
  readonly identity: PluginIdentity;
  readonly scope: Scope.Closeable;
  readonly hooks: OwnerHandle;
  readonly observers: ObserverHandle;
  /** What its handlers and observers run with (see `OwnServices`). */
  readonly own: OwnServices;
  readonly contributions: ContributorHandle;
  output: Context.Context<never>;
  state: PluginState;
  fault?: PluginFault;
  haltedBy?: string;
  /** A fatal fault reported while it was staged: it fails once published. */
  failing?: PluginFault;
  /** What it hands its replacement (`PluginContext.handoff`). */
  handoff?: () => unknown;
}

/** One published composition. In-flight work keeps the environment it entered with. */
interface Revision {
  environment: Context.Context<never>;
  readonly fibers: Set<Fiber.Fiber<unknown, unknown>>;
  /** Admitted work whose fiber is not registered yet. */
  pending: number;
  readonly drained: Deferred.Deferred<void>;
  retired: boolean;
}

/** Track resolved services; copying a whole context conservatively leases all of it. */
class TrackedServices extends Map<string, unknown> {
  readonly read = new Set<string>();
  override get(key: string): unknown {
    this.read.add(key);
    return super.get(key);
  }
  private all(): void {
    for (const key of super.keys()) this.read.add(key);
  }
  override entries() {
    this.all();
    return super.entries();
  }
  override values() {
    this.all();
    return super.values();
  }
  override [Symbol.iterator]() {
    this.all();
    return super[Symbol.iterator]();
  }
  override forEach(callback: (value: unknown, key: string, map: Map<string, unknown>) => void, thisArg?: unknown): void {
    this.all();
    super.forEach(callback, thisArg);
  }
}

type RuntimeOptions<E> = Pick<CoreOptions<readonly Capability[], E>, "deadlines" | "shutdownTimeout" | "provide">;

/**
 * A runtime with the application's services built. They are refused (a
 * `PlanError`) when they name a runtime capability, and fail it with their
 * layer's error. Only their build can be interrupted: once built, they are
 * released by the runtime's finalizer, which an interruption before it is
 * registered would skip.
 */
export function makeRuntime<E = never>(options: RuntimeOptions<E> = {}): Effect.Effect<Runtime, PlanError | E, Scope.Scope> {
  return Effect.uninterruptibleMask((restore) => assemble(options, restore));
}

function assemble<E>(
  options: RuntimeOptions<E>,
  restore: <A, E2, R>(effect: Effect.Effect<A, E2, R>) => Effect.Effect<A, E2, R>,
): Effect.Effect<Runtime, PlanError | E, Scope.Scope> {
  return Effect.gen(function* () {
    const defaults = {
      activate: Duration.fromInputUnsafe(options.deadlines?.activate ?? DEFAULTS.activate),
      dispose: Duration.fromInputUnsafe(options.deadlines?.dispose ?? DEFAULTS.dispose),
    };
    const providedKeys = options.provide?.provides.map((tag) => tag.key) ?? [];
    const providedSet: ReadonlySet<string> = new Set(providedKeys);
    // Merged over the built-ins below, an application key such as Hooks would replace the core's own.
    const refused = reservedByApplication(providedKeys);
    if (refused.length) return yield* new PlanError({ errors: refused as [CompositionError, ...CompositionError[]] });
    const faults = yield* PubSub.sliding<ReportedFault>(256);
    const shutdownLimit = Duration.fromInputUnsafe(options.shutdownTimeout ?? defaults.dispose);
    let shutdownFault: ShutdownTimeout | undefined;
    const pendingDisposals = new Set<Deferred.Deferred<void>>();
    let faultSequence = 0;
    const report = (instance: Instance, fault: PluginFault): Effect.Effect<void> =>
      Effect.suspend(() => {
        const reported = Object.assign(fault, { sequence: ++faultSequence });
        instance.fault = reported;
        return PubSub.isShutdown(faults).pipe(Effect.flatMap((closed) => (closed ? Effect.void : PubSub.publish(faults, reported).pipe(Effect.asVoid))));
      });
    const registry = new HookRegistry();
    const bus = new EventBus();
    const store = new RegistryStore();
    const builtins = Context.empty().pipe(Context.add(Hooks, registry), Context.add(Events, bus), Context.add(Registries, store)) as Context.Context<never>;
    /** Owns the application's services: closed after the last plugin is disposed. */
    const application = yield* Scope.make();
    const provided = options.provide === undefined ? Context.empty() : yield* restore(provision(options.provide, builtins, application));
    const base = Context.merge(builtins, provided);
    /** Owns lifecycle fibers: apply bodies, restart loops, background watchers. */
    const supervisor = yield* Scope.make();
    /** Owns core.run fibers. */
    const work = yield* Scope.make();
    const tasks = new Map<Fiber.Fiber<unknown, unknown>, TrackedServices>();
    const lock = yield* Semaphore.make(1);
    const closed = yield* Deferred.make<void, unknown>();
    let state: CoreSnapshot["state"] = "active";
    const instances = new Map<string, Instance>();
    let order: readonly string[] = [];
    let providers: ReadonlyMap<string, string> = new Map();
    let revision: Revision = { environment: base, fibers: new Set(), pending: 0, drained: yield* Deferred.make<void>(), retired: false };

    const environmentOf = (): Context.Context<never> => {
      let environment = base;
      for (const id of order) {
        const instance = instances.get(id);
        if (instance?.state === "active") environment = Context.merge(environment, instance.output);
      }
      return environment;
    };

    const publishRevision = Effect.gen(function* () {
      const previous = revision;
      revision = { environment: environmentOf(), fibers: new Set(), pending: 0, drained: yield* Deferred.make<void>(), retired: false };
      previous.retired = true;
      if (previous.fibers.size === 0 && previous.pending === 0) yield* Deferred.succeed(previous.drained, undefined);
      return previous;
    });

    /** Wait for work admitted under a retired revision; interrupt what outlives the dispose deadline. */
    const drain = (previous: Revision): Effect.Effect<number> =>
      withDeadline(Deferred.await(previous.drained), defaults.dispose, "abandon").pipe(
        Effect.flatMap((finished) =>
          Option.isSome(finished)
            ? Effect.succeed(0)
            : Effect.gen(function* () {
                const stale = [...previous.fibers];
                yield* withDeadline(Fiber.interruptAll(stale), defaults.dispose, "abandon");
                return stale.length;
              }),
        ),
      );

    const retire = (instance: Instance) => {
      if (instance.state !== "active") return;
      instance.state = "draining";
      instance.hooks.retire();
      instance.observers.retire();
      instance.contributions.retire();
    };

    const create = (plugin: Plugin, rawConfig: unknown): Effect.Effect<Instance> =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const identity: PluginIdentity = { id: plugin.id, ...(plugin.version === undefined ? {} : { version: plugin.version }) };
        const own = makeOwnServices();
        const instance: Instance = {
          id: plugin.id,
          plugin,
          rawConfig,
          identity,
          scope,
          own,
          hooks: registry.owner(identity, scope, false, own),
          observers: bus.owner(identity, scope, false, (fault) => report(instance, fault), own),
          contributions: store.contributor(identity, scope, false),
          output: Context.empty(),
          state: "pending",
        };
        return instance;
      });

    const background = (instance: Instance, name: string, task: Effect.Effect<unknown, unknown, unknown>, required: boolean) =>
      Effect.gen(function* () {
        if (state !== "active" || instance.state === "closed" || instance.state === "failed") return yield* new CoreClosed();
        // Interruptible explicitly: owned work must stop when its scope closes.
        const fiber = yield* Effect.forkIn(
          Effect.interruptible(task.pipe(Effect.withSpan("core.background", { attributes: { ...attributes(instance.identity), "task.name": name } }))),
          instance.scope,
        );
        const watch = Fiber.await(fiber).pipe(
          Effect.flatMap((exit) => {
            if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) return Effect.void;
            const fault = new PluginFault({ pluginId: instance.id, phase: "background", operation: name, cause: exit.cause });
            return report(instance, fault).pipe(Effect.andThen(required ? fail(instance, fault) : Effect.void));
          }),
        );
        yield* Effect.forkIn(Effect.interruptible(watch), supervisor);
      }).pipe(Effect.asVoid);

    /**
     * What a running (or draining) instance hands its replacement: a structured
     * clone of what its `save` returns, so the replacement never shares an
     * object with it (one that fails to start cannot change the state the old
     * one keeps serving with). `undefined` when it set nothing, or when `save`
     * throws or returns what cannot be cloned (a function, a socket): reported
     * as the old instance's fault.
     */
    const takeHandoff = (instance: Instance | undefined): Effect.Effect<unknown> =>
      Effect.suspend(() => {
        if (instance?.handoff === undefined || (instance.state !== "active" && instance.state !== "draining")) return Effect.void;
        const save = instance.handoff;
        try {
          return Effect.succeed(structuredClone(save()));
        } catch (error) {
          return report(instance, new PluginFault({ pluginId: instance.id, phase: "service", operation: "handoff", cause: Cause.die(error) })).pipe(
            Effect.as(undefined),
          );
        }
      });

    const activate = (instance: Instance, config: unknown, environment: Context.Context<never>, previous?: unknown): Effect.Effect<void, PluginFault> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          instance.state = "activating";
          const context: Context.Service.Shape<typeof PluginContext> = {
            ...instance.identity,
            on: instance.hooks.on,
            add: instance.contributions.add,
            observe: instance.observers.observe,
            background: <R>(name: string, task: Effect.Effect<unknown, unknown, R>, options?: { readonly required?: boolean }) =>
              background(instance, name, task, options?.required ?? false) as Effect.Effect<void, CoreClosed, R>,
            fault: (operation, cause, options) =>
              Effect.suspend(() => {
                // A retired instance's replacement owns the faults now; a staged one is live, if not yet published.
                if (instance.state === "draining" || instance.state === "closed" || instance.state === "failed") return Effect.void;
                const fault = new PluginFault({ pluginId: instance.id, phase: "service", operation, cause });
                const published = instances.get(instance.id) === instance;
                if (options?.fatal && !published) instance.failing ??= fault;
                // Reported at once; failing waits on the lifecycle lock, so it runs on its own supervised fiber.
                return report(instance, fault).pipe(
                  Effect.andThen(options?.fatal && published ? Effect.forkIn(fail(instance, fault), supervisor) : Effect.void),
                  Effect.asVoid,
                );
              }),
            trace: (name, effect) => effect.pipe(Effect.withSpan(name, { attributes: attributes(instance.identity) })),
            previous,
            handoff: (save) =>
              Effect.sync(() => {
                instance.handoff = save;
              }),
          };
          // Only declared dependencies are visible during activation, not the entire graph.
          const inputs = new Map<string, unknown>([
            [Hooks.key, registry],
            [PluginContext.key, context],
            [Events.key, bus],
            [Registries.key, store],
          ]);
          for (const tag of instance.plugin.requires) {
            if (!inputs.has(tag.key)) inputs.set(tag.key, environment.mapUnsafe.get(tag.key));
          }
          instance.own.begin(Context.makeUnsafe<never>(new Map([...inputs, [Scope.Scope.key, instance.scope]])));
          const limit = Duration.fromInputUnsafe(instance.plugin.deadlines?.activate ?? defaults.activate);
          const build = Effect.suspend(() => Layer.buildWithScope(instance.plugin.layer(config), instance.scope)).pipe(
            Effect.updateContext((caller: Context.Context<never>) => {
              // The caller's runtime settings and parent span come along; services only from the declared inputs.
              const provided = new Map([...caller.mapUnsafe].filter(([key]) => runtimeSettings.has(key) || key === Tracer.ParentSpan.key));
              for (const [key, value] of inputs) provided.set(key, value);
              return Context.makeUnsafe<unknown>(provided);
            }),
            // Building records the memo map it used in the output; that is not an export.
            Effect.map(Context.omit(Layer.CurrentMemoMap)),
            Effect.flatMap((output) => {
              const declared = new Set(instance.plugin.provides.map((tag) => tag.key));
              const missing = [...declared].filter((key) => !output.mapUnsafe.has(key));
              const undeclared = [...output.mapUnsafe.keys()].filter((key) => !declared.has(key));
              if (missing.length || undeclared.length) {
                return Effect.fail(new CapabilityMismatch({ pluginId: instance.id, missing, undeclared }));
              }
              return Effect.succeed(output);
            }),
            disconnect,
            Effect.timeoutOrElse({ duration: limit, orElse: () => Effect.fail(new DeadlineExceeded({ pluginId: instance.id, phase: "activate", limit })) }),
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause as Cause.Cause<never>)
                : Effect.fail(new PluginFault({ pluginId: instance.id, phase: "activate", cause, deadline: isDeadline(cause) })),
            ),
            Effect.withSpan("core.activate", { attributes: attributes(instance.identity) }),
          );
          // Resource bookkeeping is masked; plugin initialization remains interruptible.
          const fiber = yield* Effect.forkIn(Effect.interruptible(build), instance.scope);
          const exit = yield* Effect.exit(restore(Fiber.join(fiber)).pipe(Effect.onInterrupt(() => Fiber.interrupt(fiber))));
          instance.own.end();
          if (Exit.isSuccess(exit)) {
            instance.output = exit.value;
            instance.state = "active";
            return;
          }
          if (Cause.hasInterruptsOnly(exit.cause)) {
            yield* dispose(instance, exit, "closed");
            return yield* Effect.failCause(exit.cause as Cause.Cause<never>);
          }
          const fault = Option.getOrThrow(Cause.findErrorOption(exit.cause));
          yield* report(instance, fault);
          yield* dispose(instance, exit, "failed");
          return yield* Effect.fail(fault);
        }),
      );

    const dispose = (instance: Instance, exit: Exit.Exit<unknown, unknown>, final: "closed" | "failed"): Effect.Effect<void> =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          instance.hooks.stop();
          instance.observers.retire();
          instance.contributions.stop();
          const limit = Duration.fromInputUnsafe(instance.plugin.deadlines?.dispose ?? defaults.dispose);
          const settled = yield* Deferred.make<void>();
          pendingDisposals.add(settled);
          const close = Scope.close(instance.scope, exit).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                pendingDisposals.delete(settled);
                Deferred.doneUnsafe(settled, Effect.void);
              }),
            ),
          );
          const result = yield* withDeadline(close, limit, "continue").pipe(
            Effect.map(Option.getOrElse((): Exit.Exit<void, unknown> => Exit.fail(new DeadlineExceeded({ pluginId: instance.id, phase: "dispose", limit })))),
            Effect.withSpan("core.dispose", { attributes: attributes(instance.identity) }),
          );
          if (Exit.isFailure(result) && !Cause.hasInterruptsOnly(result.cause)) {
            const fault = new PluginFault({ pluginId: instance.id, phase: "dispose", cause: result.cause, deadline: isDeadline(result.cause) });
            yield* report(instance, fault);
          }
          if (instance.state !== "failed") instance.state = final;
        }),
      );

    /** Dependents of `id` in the current composition, transitively, in dependency order. */
    const dependentsOf = (id: string): string[] => {
      const found = new Set<string>([id]);
      for (const candidate of order) {
        const instance = instances.get(candidate);
        if (!instance || found.has(candidate)) continue;
        if (
          instance.plugin.requires.some((tag) => {
            const provider = providers.get(tag.key);
            return provider !== undefined && found.has(provider);
          })
        ) {
          found.add(candidate);
        }
      }
      found.delete(id);
      return [...found];
    };

    /** Stop a failed plugin and everything that depends on it; nothing else is touched. */
    const fail = (instance: Instance, fault: PluginFault): Effect.Effect<void> =>
      lock.withPermits(1)(
        Effect.uninterruptible(
          Effect.gen(function* () {
            if (state !== "active" || instances.get(instance.id) !== instance || instance.state !== "active") return;
            const halted = dependentsOf(instance.id).map((id) => instances.get(id)!);
            retire(instance);
            for (const dependent of halted) retire(dependent);
            // A runtime failure revokes only the affected capabilities. Track service
            // resolution so unrelated tasks are not interrupted with the failed plugin.
            revision.environment = environmentOf();
            const removed = new Set([instance, ...halted].flatMap((item) => item.plugin.provides.map((tag) => tag.key)));
            const affected: Fiber.Fiber<unknown, unknown>[] = [];
            for (const [fiber, services] of tasks) {
              if (services.read.has(Hooks.key) || [...removed].some((key) => services.read.has(key))) affected.push(fiber);
              for (const key of removed) services.delete(key);
            }
            const finished = yield* withDeadline(Effect.forEach(affected, Fiber.await, { discard: true }), defaults.dispose, "abandon");
            if (Option.isNone(finished)) yield* withDeadline(Fiber.interruptAll(affected), defaults.dispose, "abandon");
            for (const dependent of [...halted].reverse()) {
              const wasActive = dependent.state === "draining";
              yield* dispose(dependent, Exit.fail(fault), "closed");
              if (wasActive) dependent.haltedBy = instance.id;
            }
            yield* dispose(instance, Exit.fail(fault), "failed");
            instance.state = "failed";
            if (instance.plugin.restart) yield* Effect.forkIn(Effect.interruptible(restartLoop(instance, instance.plugin.restart, fault)), supervisor);
          }),
        ),
      );

    /**
     * One schedule driver per plugin id, kept across failures: a plugin that keeps
     * failing exhausts its schedule instead of restarting forever. An explicit
     * restart resets it.
     */
    const drivers = new Map<string, (input: PluginFault) => Pull.Pull<unknown, never, unknown>>();
    const restartLoop = (failed: Instance, schedule: Schedule.Schedule<unknown, PluginFault>, fault: PluginFault): Effect.Effect<void> =>
      Effect.gen(function* () {
        const id = failed.id;
        const driver = drivers.get(id) ?? (yield* Schedule.toStepWithSleep(schedule));
        drivers.set(id, driver);
        let last = fault;
        while (true) {
          // The step fails (with `Done`) once the schedule is exhausted.
          const step = yield* Effect.result(driver(last));
          if (Result.isFailure(step)) return;
          const result = yield* Effect.result(
            applyLocked(
              currentMembers(),
              new Set([id]),
              { required: new Set([id]) },
              undefined,
              () => instances.get(id) === failed && failed.state === "failed" && drivers.get(id) === driver,
            ),
          );
          if (Result.isSuccess(result)) return;
          last = instances.get(id)?.fault ?? last;
        }
      });

    const currentMembers = (): Member[] =>
      order.map((id) => {
        const instance = instances.get(id)!;
        return { plugin: instance.plugin, ...(instance.rawConfig === undefined ? {} : { config: instance.rawConfig }) };
      });

    /**
     * `partial` (a restart, or a loader's first start when asked): the required
     * plugins, and every plugin they need, must activate; another that cannot is
     * left failed, and its own dependents halted, without aborting the change.
     * Otherwise the whole composition applies or nothing does.
     */
    const applyLocked = (
      members: readonly Member[],
      force: ReadonlySet<string>,
      partial?: PartialStart,
      operation?: { committed: boolean },
      stillNeeded?: () => boolean,
    ): Effect.Effect<ReloadReport, ApplyError> =>
      lock.withPermits(1)(
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            if (state !== "active") {
              return yield* new PlanError({
                errors: [new CompositionError({ reason: "CoreClosed", message: "The core is closing or has closed", plugins: [] })],
              });
            }
            if (stillNeeded && !stillNeeded()) return { started: [], restarted: [], failed: [], stopped: [], unchanged: order, interrupted: 0, faults: [] };
            const raw = new Map(members.map((member) => [member.plugin.id, member.config]));
            const planned = plan(
              members.map((member) => member.plugin),
              (id) => raw.get(id),
              providedSet,
            );
            if (Result.isFailure(planned)) return yield* new PlanError({ errors: planned.failure });
            const { ordered, configs, providers: nextProviders } = planned.success;
            const required = partial === undefined ? undefined : requiredClosure(ordered, nextProviders, partial.required);

            // Changed: new, different definition or config, forced, or depending on a changed provider.
            const changed = new Set<string>();
            const errors: CompositionError[] = [];
            for (const plugin of ordered) {
              const instance = instances.get(plugin.id);
              const dependsOnChanged = plugin.requires.some((tag) => {
                const provider = nextProviders.get(tag.key);
                return provider !== undefined && changed.has(provider);
              });
              if (!instance || instance.plugin !== plugin || !deepEqual(instance.rawConfig, raw.get(plugin.id)) || force.has(plugin.id) || dependsOnChanged) {
                changed.add(plugin.id);
                for (const tag of plugin.requires) {
                  const provider = nextProviders.get(tag.key);
                  if (provider !== undefined && !changed.has(provider) && instances.get(provider)?.state !== "active") {
                    errors.push(
                      new CompositionError({
                        reason: "InactiveDependency",
                        capability: tag.key,
                        plugins: [plugin.id, provider],
                        message: `Plugin "${plugin.id}" requires "${tag.key}" from "${provider}", which is not active; restart "${provider}" first`,
                      }),
                    );
                  }
                }
              }
            }
            if (errors.length) return yield* new PlanError({ errors: errors as [CompositionError, ...CompositionError[]] });
            const nextIds = ordered.map((plugin) => plugin.id);
            const stops = order.filter((id) => !raw.has(id));
            const previousOrder = order;
            let interrupted = 0;
            const reloadFaults: PluginFault[] = [];

            // Exclusive plugins cannot coexist with their replacement: stop them (and their dependents) first.
            const gapped = new Set<string>();
            for (const id of changed) {
              const instance = instances.get(id);
              if (instance?.state === "active" && instance.plugin.exclusive) {
                gapped.add(id);
                for (const dependent of dependentsOf(id)) if (instances.get(dependent)?.state === "active") gapped.add(dependent);
              }
            }
            // What each running instance hands its replacement: an exclusive one's before it stops, the rest's as theirs stage.
            const carried = new Map<string, unknown>();
            if (gapped.size) {
              if (operation) operation.committed = true;
              for (const id of gapped) retire(instances.get(id)!);
              const previous = yield* publishRevision;
              interrupted += yield* drain(previous);
              // An exclusive plugin hands over once its work has drained and before it stops: everything it did is included.
              for (const id of gapped) carried.set(id, yield* takeHandoff(instances.get(id)));
              for (const id of [...previousOrder].reverse()) if (gapped.has(id)) yield* dispose(instances.get(id)!, Exit.void, "closed");
            }

            // Stage replacements while unchanged instances keep serving.
            const staged: Instance[] = [];
            const inactive = new Set<string>();
            let environment = base;
            const staging = Effect.gen(function* () {
              for (const plugin of ordered) {
                if (changed.has(plugin.id)) {
                  const instance = yield* create(plugin, raw.get(plugin.id));
                  staged.push(instance);
                  const blocked = plugin.requires.map((tag) => nextProviders.get(tag.key)).find((provider) => provider !== undefined && inactive.has(provider));
                  if (blocked !== undefined) {
                    instance.state = "closed";
                    instance.haltedBy = blocked;
                    inactive.add(plugin.id);
                    continue;
                  }
                  const previous = carried.has(plugin.id) ? carried.get(plugin.id) : yield* takeHandoff(instances.get(plugin.id));
                  const exit = yield* Effect.exit(restore(activate(instance, configs.get(plugin.id), environment, previous)));
                  if (Exit.isFailure(exit)) {
                    if (required === undefined || required.has(plugin.id) || Cause.hasInterruptsOnly(exit.cause)) return yield* Effect.failCause(exit.cause);
                    inactive.add(plugin.id);
                    continue;
                  }
                  environment = Context.merge(environment, instance.output);
                } else {
                  const instance = instances.get(plugin.id);
                  if (instance?.state === "active") environment = Context.merge(environment, instance.output);
                }
              }
            });
            const outcome = yield* Effect.exit(staging);
            if (Exit.isFailure(outcome)) {
              for (const instance of [...staged].reverse()) {
                if (instance.state !== "failed") yield* dispose(instance, outcome, "closed");
              }
              const fault = Option.getOrNull(Cause.findErrorOption(outcome.cause));
              // The explicit gap cannot be undone here: stopped exclusive plugins stay down, attributed to this failure.
              for (const id of gapped) {
                const instance = instances.get(id)!;
                instance.state = "failed";
                instance.fault = fault ?? new PluginFault({ pluginId: id, phase: "activate", cause: outcome.cause });
              }
              if (gapped.size) yield* publishRevision;
              return yield* Effect.failCause(outcome.cause);
            }

            // Swap: caller cancellation can no longer roll this operation back.
            if (operation) operation.committed = true;
            // Swap: one atomic step for callers and hook/event dispatch.
            const old = [...changed, ...stops].flatMap((id) => {
              const instance = instances.get(id);
              return instance && !gapped.has(id) ? [instance] : [];
            });
            for (const instance of old) retire(instance);
            for (const instance of staged) {
              instance.hooks.publish();
              instance.observers.publish();
              instance.contributions.publish();
              instances.set(instance.id, instance);
            }
            for (const id of stops) instances.delete(id);
            order = nextIds;
            providers = nextProviders;
            const previous = yield* publishRevision;

            // Drain, then dispose old instances in reverse dependency order.
            interrupted += yield* drain(previous);
            const oldById = new Map(old.map((instance) => [instance.id, instance]));
            for (const id of [...previousOrder].reverse()) {
              const instance = oldById.get(id);
              if (!instance) continue;
              yield* dispose(instance, Exit.void, "closed");
              if (instance.fault?.phase === "dispose") reloadFaults.push(instance.fault);
            }
            const activated = staged.filter((instance) => instance.state === "active");
            // Fatal faults reported while staged, now that their instances are published: failed after this change, under the lock.
            for (const instance of activated) if (instance.failing !== undefined) yield* Effect.forkIn(fail(instance, instance.failing), supervisor);
            return {
              started: activated.filter((instance) => !previousOrder.includes(instance.id)).map((instance) => instance.id),
              restarted: activated.filter((instance) => previousOrder.includes(instance.id)).map((instance) => instance.id),
              failed: staged.filter((instance) => instance.state !== "active").map((instance) => instance.id),
              stopped: stops,
              unchanged: nextIds.filter((id) => !changed.has(id)),
              interrupted,
              faults: reloadFaults,
            };
          }),
        ),
      );

    /** Lifecycle changes run on supervisor-owned fibers so shutdown can interrupt them. */
    const supervised = <A, E>(build: (operation: { committed: boolean }) => Effect.Effect<A, E>): Effect.Effect<A, E> =>
      Effect.uninterruptibleMask((resume) =>
        Effect.gen(function* () {
          const operation = { committed: false };
          const fiber = yield* Effect.forkIn(Effect.interruptible(build(operation)), supervisor);
          // Once old resources are retiring, losing their caller must not cancel
          // the replacement or make drain wait on its own lifecycle fiber.
          return yield* resume(Fiber.join(fiber)).pipe(Effect.onInterrupt(() => (operation.committed ? Effect.void : Fiber.interrupt(fiber))));
        }),
      );

    const shutdown: Effect.Effect<void> = Effect.uninterruptible(
      Effect.suspend(() => {
        if (state !== "active") return Deferred.await(closed).pipe(Effect.orDie);
        state = "closing";
        return Effect.gen(function* () {
          const awaitDisposals = Effect.suspend(() => Effect.forEach([...pendingDisposals], Deferred.await, { discard: true }));
          const cleanup = Effect.gen(function* () {
            // Interrupt work and lifecycle changes together, then preserve resources
            // until both have actually stopped. A caller deadline never kills them.
            yield* Effect.all([Scope.close(work, Exit.void), Scope.close(supervisor, Exit.void)], { concurrency: "unbounded", discard: true });
            registry.close();
            store.close();
            yield* bus.close();
            yield* awaitDisposals;
            let cause: Cause.Cause<unknown> | undefined;
            for (const id of [...order].reverse()) {
              const instance = instances.get(id)!;
              if (instance.state === "closed" || instance.state === "failed") continue;
              yield* dispose(instance, Exit.void, "closed");
              const fault = instance.fault;
              if (fault?.phase === "dispose") {
                cause = cause ? Cause.combine(cause, fault.cause) : fault.cause;
                // Surface the plugin deadline promptly, retaining providers until
                // that plugin's actual cleanup finishes.
                if (fault.deadline) yield* Deferred.failCause(closed, cause);
              }
              yield* awaitDisposals;
            }
            // The application's services outlive every plugin. Their deadline surfaces
            // promptly, as a plugin's does; the core stays closing until they are released.
            if (options.provide !== undefined) {
              const released = yield* Deferred.make<void>();
              const release = yield* withDeadline(
                Scope.close(application, Exit.void).pipe(Effect.ensuring(Deferred.succeed(released, undefined))),
                defaults.dispose,
                "continue",
              );
              const failure = Option.match(release, {
                onNone: () => Cause.die(new Error(`The application's services did not release within ${Duration.format(defaults.dispose)}`)),
                onSome: (exit) => (Exit.isFailure(exit) ? exit.cause : undefined),
              });
              if (failure !== undefined) cause = cause ? Cause.combine(cause, failure) : failure;
              if (Option.isNone(release)) {
                yield* Deferred.failCause(closed, cause!);
                yield* Deferred.await(released);
              }
            }
            yield* PubSub.shutdown(faults);
            state = "closed";
            if (cause) return yield* Effect.failCause(cause);
          });
          yield* Effect.forkDetach(
            Effect.uninterruptible(cleanup).pipe(
              Effect.exit,
              Effect.flatMap((exit) => Deferred.done(closed, exit)),
            ),
          );
          const result = yield* withDeadline(Deferred.await(closed), shutdownLimit, "abandon");
          if (Option.isNone(result)) {
            shutdownFault = new ShutdownTimeout({ limit: shutdownLimit });
            yield* Deferred.fail(closed, shutdownFault);
          }
          return yield* Deferred.await(closed);
        }).pipe(Effect.orDie);
      }),
    );
    yield* Effect.addFinalizer(() => shutdown);

    const core: Core<any> = {
      run: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.uninterruptibleMask((resume) =>
          Effect.gen(function* () {
            if (state !== "active") return yield* new CoreClosed();
            const admitted = revision;
            admitted.pending++;
            const caller = yield* Effect.context<never>();
            const services = new TrackedServices(Context.merge(caller, admitted.environment).mapUnsafe);
            const provided = Effect.updateContext(effect, (_: Context.Context<never>) => Context.makeUnsafe<R>(services));
            const fiber = yield* Effect.forkIn(resume(provided), work);
            tasks.set(fiber, services);
            admitted.fibers.add(fiber);
            admitted.pending--;
            return yield* resume(Fiber.join(fiber)).pipe(
              Effect.onInterrupt(() => Fiber.interrupt(fiber)),
              Effect.ensuring(
                Effect.sync(() => {
                  tasks.delete(fiber);
                  admitted.fibers.delete(fiber);
                  if (admitted.retired && admitted.fibers.size === 0 && admitted.pending === 0) Deferred.doneUnsafe(admitted.drained, Effect.void);
                }),
              ),
            );
          }),
        ),
      inspect: Effect.sync((): CoreSnapshot => ({
        state,
        faultSequence,
        ...(shutdownFault === undefined ? {} : { shutdownFault }),
        provided: [...providedKeys],
        plugins: order.map((id) => snapshot(instances.get(id)!)),
        hooks: registry.inspect(),
        events: bus.inspect(),
        registries: store.inspect(),
      })),
      faults: Stream.fromPubSub(faults),
      restart: (id, options) =>
        Effect.suspend((): Effect.Effect<void, ReloadError | CoreClosed> => {
          if (state !== "active") return Effect.fail(new CoreClosed());
          const instance = instances.get(id);
          if (!instance) {
            return Effect.fail(new ReloadError({ diagnostics: [new Diagnostic({ severity: "error", pluginId: id, message: `No plugin "${id}" is loaded` })] }));
          }
          if (instance.state === "active" && !options?.force) return Effect.void;
          drivers.delete(id);
          return supervised((operation) => applyLocked(currentMembers(), new Set([id]), { required: new Set([id]) }, operation)).pipe(
            Effect.mapError(toReloadError),
            Effect.asVoid,
          );
        }),
    };

    return {
      core,
      apply: (members, onApplied, partial) =>
        supervised((operation) => applyLocked(members, new Set(), partial, operation).pipe(Effect.tap(() => Effect.sync(() => onApplied?.())))),
      shutdown,
    };
  });
}

/**
 * Build the application's services in `scope`, from the built-ins and the
 * caller's runtime settings only (as a plugin's activation sees them). A build
 * that fails, or whose services differ from what it declares, closes `scope`.
 */
function provision<E>(provide: ApplicationServices<readonly Capability[], E>, builtins: Context.Context<never>, scope: Scope.Closeable) {
  return Layer.buildWithScope(provide.layer, scope).pipe(
    Effect.updateContext((caller: Context.Context<never>) => {
      const inputs = new Map([...caller.mapUnsafe].filter(([key]) => runtimeSettings.has(key) || key === Tracer.ParentSpan.key));
      for (const [key, value] of builtins.mapUnsafe) inputs.set(key, value);
      return Context.makeUnsafe<unknown>(inputs);
    }),
    // Building records the memo map it used in the output; that is not a service.
    Effect.map(Context.omit(Layer.CurrentMemoMap)),
    Effect.flatMap((output) => {
      const declared = new Set(provide.provides.map((tag) => tag.key));
      const missing = [...declared].filter((key) => !output.mapUnsafe.has(key));
      const undeclared = [...output.mapUnsafe.keys()].filter((key) => !declared.has(key));
      if (missing.length || undeclared.length) {
        const detail = `missing: ${missing.join(", ") || "none"}; undeclared: ${undeclared.join(", ") || "none"}`;
        return Effect.die(new Error(`The application's services do not match provide.provides (${detail})`));
      }
      return Effect.succeed(output as Context.Context<never>);
    }),
    Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
    Effect.withSpan("core.provide"),
  );
}

/** `ids` and, transitively, the providers of everything they require: what must activate for them to. */
function requiredClosure(ordered: readonly Plugin[], providers: ReadonlyMap<string, string>, ids: ReadonlySet<string>): ReadonlySet<string> {
  const byId = new Map(ordered.map((plugin) => [plugin.id, plugin]));
  const found = new Set<string>();
  const stack = [...ids];
  while (stack.length) {
    const plugin = byId.get(stack.pop()!);
    if (plugin === undefined || found.has(plugin.id)) continue;
    found.add(plugin.id);
    for (const tag of plugin.requires) {
      const provider = providers.get(tag.key);
      if (provider !== undefined) stack.push(provider);
    }
  }
  return found;
}

/** Run `effect` on its own fiber: interrupting the caller interrupts it without waiting for it to stop. */
function disconnect<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkDetach(restore(effect));
      return yield* restore(Fiber.join(fiber)).pipe(Effect.onInterrupt(() => Effect.sync(() => fiber.interruptUnsafe())));
    }),
  );
}

/**
 * Wait for `effect` up to `limit`, from any fiber, including an uninterruptible or
 * already-interrupted one where Effect's timeout races cannot fire. On timeout the
 * effect either keeps running ("continue": cleanup must finish) or is abandoned.
 */
function withDeadline<A, E>(
  effect: Effect.Effect<A, E>,
  limit: Duration.Duration,
  onTimeout: "continue" | "abandon",
): Effect.Effect<Option.Option<Exit.Exit<A, E>>> {
  return Effect.gen(function* () {
    const done = yield* Deferred.make<Option.Option<Exit.Exit<A, E>>>();
    const body = onTimeout === "continue" ? Effect.uninterruptible(effect) : Effect.interruptible(effect);
    const worker = yield* Effect.forkDetach(
      body.pipe(
        Effect.exit,
        Effect.flatMap((exit) => Deferred.succeed(done, Option.some(exit))),
      ),
    );
    const timer = yield* Effect.forkDetach(Effect.interruptible(Effect.sleep(limit)).pipe(Effect.andThen(Deferred.succeed(done, Option.none()))));
    const result = yield* Deferred.await(done);
    timer.interruptUnsafe();
    if (Option.isNone(result) && onTimeout === "abandon") worker.interruptUnsafe();
    return result;
  });
}

export function toReloadError(error: ApplyError): ReloadError {
  return new ReloadError({ diagnostics: error._tag === "PlanError" ? error.errors.map(toDiagnostic) : [faultDiagnostic(error)] });
}

function toDiagnostic(error: CompositionError): Diagnostic {
  const suggestion = suggestionFor(error);
  return new Diagnostic({
    severity: "error",
    ...(error.plugins[0] === undefined ? {} : { pluginId: error.plugins[0] }),
    ...(error.path === undefined ? {} : { path: error.path }),
    message: error.message,
    ...(suggestion === undefined ? {} : { suggestion }),
  });
}

function suggestionFor(error: CompositionError): string | undefined {
  switch (error.reason) {
    case "MissingCapability":
      return `Add a plugin that provides "${error.capability}" or remove "${error.plugins[0]}"`;
    case "DuplicateCapability":
      return `Keep one of ${error.plugins.map((id) => `"${id}"`).join(", ")}`;
    case "InactiveDependency":
      return `Restart "${error.plugins[1]}"`;
    case "InvalidConfig":
      return `Fix the config for "${error.plugins[0]}"`;
    case "ReservedCapability":
      return error.plugins[0] === undefined ? undefined : `Remove "${error.capability}" from the provides of "${error.plugins[0]}"`;
    default:
      return undefined;
  }
}

function faultDiagnostic(fault: PluginFault): Diagnostic {
  return new Diagnostic({ severity: "error", pluginId: fault.pluginId, message: `${fault.message}\n${Cause.pretty(fault.cause)}` });
}

function isDeadline(cause: Cause.Cause<unknown>): boolean {
  return Option.exists(Cause.findErrorOption(cause), (failure) => failure instanceof DeadlineExceeded);
}

function snapshot(instance: Instance): PluginSnapshot {
  return {
    id: instance.id,
    ...(instance.identity.version === undefined ? {} : { version: instance.identity.version }),
    state: instance.state,
    provides: instance.plugin.provides.map((tag) => tag.key),
    requires: instance.plugin.requires.map((tag) => tag.key),
    ...(instance.fault === undefined ? {} : { fault: instance.fault }),
    ...(instance.haltedBy === undefined ? {} : { haltedBy: instance.haltedBy }),
  };
}

/** Structural equality for config data (JSON-like values); other objects compare by reference. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((value, index) => deepEqual(value, (b as unknown[])[index]));
  if (Object.getPrototypeOf(a) !== Object.prototype || Object.getPrototypeOf(b) !== Object.prototype) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}
