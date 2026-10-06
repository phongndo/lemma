import { Effect, Stream } from "effect";
import { PluginStopped } from "../errors.ts";
import type { Bridge } from "./bridge.ts";

type Effectful = Effect.Effect<any, any, any> | Stream.Stream<any, any, any>;
/** What a call returns to promise-based code: an Effect's value as a promise, a stream as an async iterable. */
type PlainResult<R> = R extends Effect.Effect<infer A, any, any> ? Promise<A> : R extends Stream.Stream<infer A, any, any> ? AsyncIterable<A> : R;
/** Levels below the service its conversion looks into, as the runtime does (`DEPTH`). */
type Below = [never, 0, 1, 2, 3];
/**
 * Whether an object has members to convert, at any depth the runtime
 * converts: Effects, streams, functions returning them, or objects holding
 * them. One without any is left as it is.
 */
type HasEffects<T, D extends number = 4> = [D] extends [never]
  ? never
  : {
      [K in keyof T]: T[K] extends Effectful | ((...args: any[]) => Effectful)
        ? true
        : T[K] extends (...args: any[]) => any
          ? never
          : T[K] extends object
            ? HasEffects<T[K], Below[D]>
            : never;
    }[keyof T];

type PlainMember<T> =
  T extends Effect.Effect<infer A, any, any>
    ? () => Promise<A>
    : T extends Stream.Stream<infer A, any, any>
      ? () => AsyncIterable<A>
      : T extends (...args: infer P) => infer R
        ? (...args: P) => PlainResult<R>
        : T extends object
          ? [HasEffects<T>] extends [never]
            ? T
            : { readonly [K in keyof T]: PlainMember<T[K]> }
          : T;

/**
 * A service as promise-based code uses it: a method returning an Effect
 * returns a promise of its value, one returning a stream an async iterable,
 * and an Effect or stream member becomes a method returning one. Everything
 * else is as it was.
 *
 * A mapped type keeps one signature per member, so an overloaded method keeps
 * its last and a generic one loses its type parameter. A contract gives such
 * members their promise-based types by hand under `"~plain"`, a phantom
 * member nothing implements:
 *
 *   interface Store {
 *     readonly get: <A>(key: Key<A>) => Effect.Effect<A>;
 *     readonly "~plain"?: { readonly get: <A>(key: Key<A>) => Promise<A> };
 *   }
 */
export type Plain<S> = "~plain" extends keyof S
  ? NonNullable<S["~plain" & keyof S]> extends infer P
    ? Omit<PlainMember<Omit<S, "~plain">>, keyof P> & P
    : never
  : PlainMember<S>;

const isPlainObject = (value: unknown): value is Record<PropertyKey, unknown> => {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/** Nested objects deeper than this are left as they are: services are shallow, and data is not converted. */
const DEPTH = 4;

/**
 * `service` as `Plain<S>`, converted once when the plugin starts: a function
 * runs what it returns through `bridge`, an Effect or stream member becomes a
 * method, and plain objects inside are converted the same way. A function is
 * called on its own object, so `this` inside it is the service. A service that
 * is a class instance keeps its prototype, getters, and private fields
 * behind a proxy; class instances inside a service (a `Map`, a `Date`) are
 * data, and left as they are.
 *
 * Once the plugin has stopped, a method that has returned Effects refuses
 * with a rejected `PluginStopped`; any other throws it, so leaked code that
 * expected a value fails where it calls rather than with a promise it did not
 * expect.
 */
export const plainView = (service: unknown, bridge: Bridge, name: string): unknown => {
  const refused = (path: string) => new PluginStopped({ pluginId: bridge.pluginId, operation: path });

  const wrap = (fn: (...args: unknown[]) => unknown, self: unknown, path: string) => {
    /** It has returned an Effect or stream: refused, it returns a rejected promise, as its callers expect a promise. */
    let promised = false;
    return (...args: unknown[]): unknown => {
      if (bridge.stopped()) {
        if (promised) return bridge.refuse(path);
        throw refused(path);
      }
      const result = fn.apply(self, args);
      if (Effect.isEffect(result)) {
        promised = true;
        return bridge.run(result, path);
      }
      if (Stream.isStream(result)) {
        promised = true;
        return bridge.iterate(result, path);
      }
      return result;
    };
  };

  const convert = (value: unknown, self: unknown, path: string, depth: number): unknown => {
    if (Effect.isEffect(value)) return () => (bridge.stopped() ? bridge.refuse(path) : bridge.run(value, path));
    if (Stream.isStream(value)) return () => (bridge.stopped() ? bridge.refuse(path) : bridge.iterate(value, path));
    if (typeof value === "function") return wrap(value as (...args: unknown[]) => unknown, self, path);
    if (depth === 0 && typeof value === "object" && value !== null && !isPlainObject(value)) return proxied(value, path);
    if (!isPlainObject(value) || depth >= DEPTH) return value;
    const view: Record<PropertyKey, unknown> = {};
    let changed = false;
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      const member = `${path}.${String(key)}`;
      if ("value" in descriptor) {
        const converted = convert(descriptor.value, value, member, depth + 1);
        if (converted !== descriptor.value) changed = true;
        view[key] = converted;
      } else if (descriptor.get !== undefined) {
        const get = descriptor.get;
        changed = true;
        Object.defineProperty(view, key, { enumerable: descriptor.enumerable ?? true, get: () => convert(get.call(value), value, member, depth + 1) });
      }
    }
    return changed ? Object.freeze(view) : value;
  };

  /** A class instance as a service: read through, members converted as they are read (and kept, so a method is one function). */
  const proxied = (target: object, path: string): unknown => {
    const converted = new Map<PropertyKey, { readonly from: unknown; readonly to: unknown }>();
    return new Proxy(target, {
      get: (object, key) => {
        const value: unknown = Reflect.get(object, key, object);
        if (typeof key === "symbol" && typeof value !== "function") return value;
        const known = converted.get(key);
        if (known !== undefined && known.from === value) return known.to;
        const to = convert(value, object, `${path}.${String(key)}`, 1);
        converted.set(key, { from: value, to });
        return to;
      },
    });
  };

  return convert(service, undefined, name, 0);
};
