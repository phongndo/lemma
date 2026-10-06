import { Context, Effect, Order, References, Scope } from "effect";
import { CoreClosed, HookError } from "../errors.ts";
import { servicesOf } from "./settings.ts";
import type { Handler, Hook, HookOptions, Hooks, Next, PluginContext, PluginIdentity } from "../hooks.ts";

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
  readonly handlers: readonly {
    readonly pluginId: string;
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
        handlers: entry.handlers.map(({ owner, order }) => ({ pluginId: owner.identity.id, order })),
      }));
  }

  owner(identity: PluginIdentity, scope: Scope.Scope, visible: boolean): OwnerHandle {
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
          const entry = yield* this.entry(hook);
          const environment: readonly Provided[] = [...servicesOf(yield* Effect.context<R>()).mapUnsafe].map(([key, value]) => ({
            key: { key } as Context.Key<unknown, unknown>,
            value,
          }));
          const registration: Registration = {
            owner,
            entry,
            order,
            sequence: this.sequence++,
            active: true,
            attributes: { ...attributes(identity), "hook.name": hook.name, "hook.order": order },
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
  ): Effect.Effect<O, E | HookError | CoreClosed, R> => {
    return Effect.gen({ self: this }, function* () {
      if (this.closed) return yield* new CoreClosed();
      const entry = yield* this.entry(hook);
      const handlers = entry.handlers;
      if (handlers.length === 0) return yield* Effect.suspend(() => terminal(input));
      const caller = servicesOf(yield* Effect.context<R>());
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
              return dispatch(index + 1, nextInput);
            });
          const handle = registration.handle as Handler<I, O, E>;
          const run = Effect.suspend(() => handle(value, next)).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                alive = false;
              }),
            ),
          );
          // With tracing off, no span at all: not even a no-op span's context change.
          return Effect.withFiber((fiber) =>
            fiber.getRef(References.TracerEnabled)
              ? run.pipe(
                  Effect.withSpan(
                    "core.hook",
                    { attributes: registration.attributes },
                    // This frame is always the dispatcher, not plugin code. Keep attribution
                    // and failure stacks without capturing a redundant stack on every call.
                    { captureStackTrace: false },
                  ),
                )
              : run,
          );
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
    .sort((a, b) => a.order - b.order || Order.String(a.owner.identity.id, b.owner.identity.id) || a.sequence - b.sequence);
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
