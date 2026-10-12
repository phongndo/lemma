import { Cause, Clock, Context, Effect, Exit, Order, References, Scope } from "effect";
import type { Tracer } from "effect";
import { CoreClosed, HookError } from "../errors.ts";
import type { OwnServices } from "./own.ts";
import { placeIn } from "./phases.ts";
import { servicesOf } from "./settings.ts";
import type { HandlerStep, Handler, Hook, HookOptions, Hooks, InvokeOptions, Next, PluginContext, PluginIdentity, Summary } from "../hooks.ts";

interface Entry {
  readonly token: object;
  readonly name: string;
  /** Visible, sorted; dispatch snapshots this array. */
  handlers: readonly Registration[];
  all: Registration[];
}

interface Owner {
  readonly identity: PluginIdentity;
  /** Hidden while staged or retired: new dispatches do not see the handlers. */
  visible: boolean;
  accepting: boolean;
}

interface Registration {
  readonly owner: Owner;
  readonly entry: Entry;
  /** Its phase, when the hook declares phases, and that phase's place among them (0 when it declares none). */
  readonly phase?: string;
  readonly rank: number;
  readonly order: number;
  readonly sequence: number;
  readonly handle: Handler<unknown, unknown, unknown>;
  /** Its span's attributes, made once. */
  readonly attributes: Readonly<Record<string, string | number>>;
  /** False once stopped or disposed: an in-flight dispatch reaching it fails. */
  active: boolean;
}

export interface HookSnapshot {
  readonly name: string;
  /** The hook's phases, first first, when it declares them: its handlers run in them, then by order. */
  readonly phases?: readonly string[];
  readonly handlers: readonly {
    readonly pluginId: string;
    readonly phase?: string;
    readonly order: number;
  }[];
}

/**
 * One plugin instance's view of the registry. Staged instances register while
 * hidden; `publish` makes their handlers visible atomically, `retire` hides them
 * while in-flight dispatches finish on the snapshot they took, and `stop` fails
 * any dispatch that still reaches them.
 */
export interface OwnerHandle {
  readonly on: Context.Service.Shape<typeof PluginContext>["on"];
  readonly publish: () => void;
  readonly retire: () => void;
  readonly stop: () => void;
}

/** Registrations change only on lifecycle steps; dispatch uses immutable arrays. */
export class HookRegistry implements Context.Service.Shape<typeof Hooks> {
  private readonly entries = new Map<string, Entry>();
  private sequence = 0;
  private closed = false;

  close(): void {
    this.closed = true;
    this.entries.clear();
  }

  inspect(): readonly HookSnapshot[] {
    return [...this.entries.values()]
      .filter((entry) => entry.handlers.length > 0)
      .sort((a, b) => Order.String(a.name, b.name))
      .map((entry) => ({
        name: entry.name,
        ...((entry.token as Hook<unknown, unknown>).phases === undefined ? {} : { phases: (entry.token as Hook<unknown, unknown>).phases }),
        handlers: entry.handlers.map(({ owner, phase, order }) => ({ pluginId: owner.identity.id, ...(phase === undefined ? {} : { phase }), order })),
      }));
  }

  owner(identity: PluginIdentity, scope: Scope.Scope, visible: boolean, own: OwnServices): OwnerHandle {
    const owner: Owner = { identity, visible, accepting: true };
    const owned = new Set<Registration>();
    const on = <I, O, E, R>(hook: Hook<I, O, E>, handler: Handler<I, O, E, R>, options: HookOptions = {}) =>
      Effect.uninterruptible(
        Effect.gen({ self: this }, function* () {
          if (this.closed) return yield* new CoreClosed();
          if (!owner.accepting) return yield* ownerClosed(hook.name, identity.id);
          const order = options.order ?? 0;
          if (!Number.isFinite(order)) {
            return yield* new HookError({ reason: "InvalidOrder", hook: hook.name, pluginId: identity.id, message: "Hook order must be finite" });
          }
          const placed = placeIn(hook, options.phase);
          if (typeof placed === "string") {
            return yield* new HookError({ reason: "InvalidOrder", hook: hook.name, pluginId: identity.id, message: `Hook "${hook.name}" ${placed}` });
          }
          const entry = yield* this.entry(hook);
          // The plugin's own services, never the references of the work that registered it (see `OwnServices`).
          const environment: readonly Provided[] = [...own.capture(yield* Effect.context<R>()).mapUnsafe].map(([key, value]) => ({
            key: { key } as Context.Key<unknown, unknown>,
            value,
          }));
          const registration: Registration = {
            owner,
            entry,
            ...placed,
            order,
            sequence: this.sequence++,
            active: true,
            attributes: {
              ...attributes(identity),
              "hook.name": hook.name,
              ...(placed.phase === undefined ? {} : { "hook.phase": placed.phase }),
              "hook.order": order,
            },
            // This erasure is local to the heterogeneous registry. Token identity protects dispatch.
            handle: ((input: I, next: Next<I, O, E>) =>
              Effect.updateContext(
                Effect.suspend(() => handler(input, next)) as Effect.Effect<O, E | HookError | CoreClosed>,
                (current: Context.Context<never>) => overriding(current, environment),
              )) as unknown as Handler<unknown, unknown, unknown>,
          };
          entry.all.push(registration);
          owned.add(registration);
          rebuild(entry);
          yield* Scope.addFinalizer(
            scope,
            Effect.sync(() => {
              registration.active = false;
              owned.delete(registration);
              entry.all = entry.all.filter((candidate) => candidate !== registration);
              rebuild(entry);
            }),
          );
        }),
      );
    const each = (update: (registration: Registration) => void) => {
      for (const registration of owned) {
        update(registration);
        rebuild(registration.entry);
      }
    };
    return {
      on,
      publish: () => {
        owner.visible = true;
        each(() => {});
      },
      retire: () => {
        owner.accepting = false;
        owner.visible = false;
        each(() => {});
      },
      stop: () => {
        owner.accepting = false;
        owner.visible = false;
        each((registration) => {
          registration.active = false;
        });
      },
    };
  }

  readonly invoke = <I, O, E, R>(
    hook: Hook<I, O, E>,
    input: I,
    terminal: (input: I) => Effect.Effect<O, E, R>,
    options?: InvokeOptions<I, O>,
  ): Effect.Effect<O, E | HookError | CoreClosed, R> => {
    return Effect.gen({ self: this }, function* () {
      if (this.closed) return yield* new CoreClosed();
      const entry = yield* this.entry(hook);
      const handlers = entry.handlers;
      if (handlers.length === 0) return yield* Effect.suspend(() => terminal(input));
      const caller = servicesOf(yield* Effect.context<R>());
      const onStep = options?.onStep;
      const summary = hook.summary;
      const dispatch = (index: number, value: I): Effect.Effect<O, E | HookError | CoreClosed> =>
        Effect.suspend(() => {
          if (this.closed) return Effect.fail(new CoreClosed());
          const registration = handlers[index];
          if (!registration)
            return Effect.provide(
              Effect.suspend(() => terminal(value)),
              caller,
            );
          if (!registration.active) return Effect.fail(ownerClosed(hook.name, registration.owner.identity.id));
          let called = false;
          let alive = true;
          // Its span, when recorded (set as it starts), and, while someone hears the steps, what it handed on.
          let span: Tracer.Span | undefined;
          const step: { next?: { input: I; output?: O }; nextMs: number } | undefined = onStep === undefined ? undefined : { nextMs: 0 };
          const next = (nextInput: I): Effect.Effect<O, E | HookError | CoreClosed> =>
            Effect.suspend(() => {
              if (!alive || called) {
                return Effect.fail(
                  new HookError({
                    reason: alive ? "NextAlreadyCalled" : "InvocationEnded",
                    hook: hook.name,
                    pluginId: registration.owner.identity.id,
                    message: alive ? "A hook handler may execute next only once" : "next cannot execute after its handler has finished",
                  }),
                );
              }
              called = true;
              let rest = dispatch(index + 1, nextInput);
              // On the handler's span, not whichever is current: a handler may call next inside a span of its own.
              const traced = span;
              if (traced !== undefined && summary?.input !== undefined) {
                const handed = summarize("hook.next.", summary.input, nextInput);
                rest = Effect.andThen(
                  Effect.sync(() => {
                    for (const [key, entry] of Object.entries(handed)) traced.attribute(key, entry);
                  }),
                  rest,
                );
              }
              if (step === undefined) return rest;
              const passed: { input: I; output?: O } = { input: nextInput };
              step.next = passed;
              const inner = rest;
              // Effect's clock, so a simulated run times the steps it logs the same every time.
              return Clock.clockWith((clock) => {
                const began = clock.monotonicTimeNanosUnsafe();
                return inner.pipe(
                  Effect.tap((output) =>
                    Effect.sync(() => {
                      passed.output = output;
                    }),
                  ),
                  Effect.ensuring(
                    Effect.sync(() => {
                      step.nextMs += Number(clock.monotonicTimeNanosUnsafe() - began) / 1e6;
                    }),
                  ),
                );
              });
            });
          const handle = registration.handle as Handler<I, O, E>;
          let run = Effect.suspend(() => handle(value, next)).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                alive = false;
              }),
            ),
          );
          if (onStep !== undefined && step !== undefined) {
            const handled = run;
            run = Clock.clockWith((clock) => {
              const startedAt = clock.currentTimeMillisUnsafe();
              const began = clock.monotonicTimeNanosUnsafe();
              return handled.pipe(
                Effect.onExit((exit) =>
                  Effect.sync(() => {
                    const ms = Number(clock.monotonicTimeNanosUnsafe() - began) / 1e6;
                    const heard: HandlerStep<I, O> = {
                      pluginId: registration.owner.identity.id,
                      ...(registration.phase === undefined ? {} : { phase: registration.phase }),
                      order: registration.order,
                      index,
                      input: value,
                      ...(step.next === undefined ? {} : { next: step.next }),
                      ...(Exit.isSuccess(exit) ? { output: exit.value } : {}),
                      exit: Exit.isSuccess(exit) ? "success" : Cause.hasInterruptsOnly(exit.cause) ? "interrupted" : "failure",
                      startedAt,
                      ms,
                      selfMs: Math.max(0, ms - step.nextMs),
                    };
                    try {
                      onStep(heard);
                    } catch {
                      // Hearing a step never fails the operation.
                    }
                  }),
                ),
              );
            });
          }
          // With tracing off, no span at all: not even a no-op span's context change.
          return Effect.withFiber((fiber) => {
            if (!fiber.getRef(References.TracerEnabled)) return run;
            const attributes =
              summary?.input === undefined ? registration.attributes : { ...registration.attributes, ...summarize("hook.in.", summary.input, value) };
            const own = Effect.currentSpan.pipe(
              Effect.tap((current) => Effect.sync(() => void (span = current))),
              Effect.catch(() => Effect.void),
            );
            const traced = Effect.andThen(own, run);
            const body =
              summary?.output === undefined
                ? traced
                : traced.pipe(Effect.tap((output) => Effect.annotateCurrentSpan(summarize("hook.out.", summary.output!, output))));
            return body.pipe(
              Effect.withSpan(
                "core.hook",
                { attributes },
                // This frame is always the dispatcher, not plugin code. Keep attribution
                // and failure stacks without capturing a redundant stack on every call.
                { captureStackTrace: false },
              ),
            );
          });
        });
      return yield* dispatch(0, input);
    });
  };

  private entry(hook: { readonly name: string }): Effect.Effect<Entry, HookError> {
    return Effect.suspend(() => {
      const existing = this.entries.get(hook.name);
      if (existing) {
        if (existing.token !== hook) {
          return Effect.fail(
            new HookError({
              reason: "PointConflict",
              hook: hook.name,
              message: `Different hook tokens use the name "${hook.name}"; import the shared token instead`,
            }),
          );
        }
        return Effect.succeed(existing);
      }
      const entry: Entry = { token: hook, name: hook.name, handlers: [], all: [] };
      this.entries.set(hook.name, entry);
      return Effect.succeed(entry);
    });
  }
}

/**
 * `current` with a registration's services where its own differ: what
 * providing them does, without copying the whole context per call. A handler
 * usually differs from its caller only in its own `PluginContext` and
 * `Scope`, so it costs a couple of overlays rather than a copy.
 */
interface Provided {
  readonly key: Context.Key<unknown, unknown>;
  readonly value: unknown;
}

function overriding(current: Context.Context<never>, environment: readonly Provided[]): Context.Context<never> {
  let context = current;
  for (const { key, value } of environment) {
    if (value === undefined || Context.getOrUndefined(context, key) !== value) context = Context.addUnsafe(context, key.key, value) as Context.Context<never>;
  }
  return context;
}

function rebuild(entry: Entry): void {
  entry.handlers = entry.all
    .filter((registration) => registration.active && registration.owner.visible)
    .sort((a, b) => a.rank - b.rank || a.order - b.order || Order.String(a.owner.identity.id, b.owner.identity.id) || a.sequence - b.sequence);
}

export function attributes(identity: PluginIdentity): Record<string, string> {
  return {
    "plugin.id": identity.id,
    ...(identity.version === undefined ? {} : { "plugin.version": identity.version }),
  };
}

function ownerClosed(hook: string, pluginId: string): HookError {
  return new HookError({ reason: "OwnerClosed", hook, pluginId, message: `Plugin "${pluginId}" has closed` });
}

/** `describe(value)`'s entries, each key prefixed; nothing when it throws, as a summary never fails the hook. */
function summarize<A>(prefix: string, describe: (value: A) => Summary, value: A): Record<string, string | number | boolean> {
  try {
    return Object.fromEntries(Object.entries(describe(value)).map(([key, entry]) => [prefix + key, entry]));
  } catch {
    return {};
  }
}
