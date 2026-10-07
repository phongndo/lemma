import { Effect, Stream } from "effect";
import { PluginStopped } from "../errors.ts";
import type { Bridge } from "./bridge.ts";

type Effectful = Effect.Effect<any, any, any> | Stream.Stream<any, any, any>;
/** What a call returns to promise-based code: an Effect's value as a promise, a stream as an async iterable. */
type PlainResult<R> = R extends Effect.Effect<infer A, any, any> ? Promise<A> : R extends Stream.Stream<infer A, any, any> ? AsyncIterable<A> : R;
/** The object levels still converted below one: the service is at 4, and an object at 0 is left as it is (`DEPTH`). */
type Below = [0, 0, 1, 2, 3];
/**
 * Whether an object has members to convert within the levels the runtime
 * converts: Effects, streams, functions returning them, or objects holding
 * them. One without any is left as it is, as are arrays.
 */
type HasEffects<T, Left extends number> = [Left] extends [0]
  ? never
  : {
      [K in keyof T]-?: NonNullable<T[K]> extends Effectful | ((...args: any[]) => Effectful)
        ? true
        : NonNullable<T[K]> extends ((...args: any[]) => any) | readonly unknown[]
          ? never
          : NonNullable<T[K]> extends object
            ? HasEffects<NonNullable<T[K]>, Below[Left]>
            : never;
    }[keyof T];

type PlainMember<T, Left extends number> =
  T extends Effect.Effect<infer A, any, any>
    ? () => Promise<A>
    : T extends Stream.Stream<infer A, any, any>
      ? () => AsyncIterable<A>
      : T extends (...args: infer P) => infer R
        ? (...args: P) => PlainResult<R>
        : T extends readonly unknown[]
          ? T
          : T extends object
            ? [HasEffects<T, Left>] extends [never]
              ? T
              : { readonly [K in keyof T]: PlainMember<T[K], Below[Left]> }
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
    ? Omit<PlainMember<Omit<S, "~plain">, 4>, keyof P> & P
    : never
  : PlainMember<S, 4>;

/** Objects this many levels below the service are left as they are: services are shallow, and data is not converted. */
const DEPTH = 4;

/** Built-in data a service may hold (a `Map` of entries, a `Date`): its methods never return Effects, so it is left as it is. */
const isData = (value: object): boolean =>
  value instanceof Date ||
  value instanceof Map ||
  value instanceof Set ||
  value instanceof WeakMap ||
  value instanceof WeakSet ||
  value instanceof RegExp ||
  value instanceof Error ||
  value instanceof Promise ||
  value instanceof ArrayBuffer ||
  ArrayBuffer.isView(value) ||
  (typeof URL !== "undefined" && value instanceof URL);

const isThenable = (value: unknown): boolean =>
  ((typeof value === "object" && value !== null) || typeof value === "function") && typeof (value as { then?: unknown }).then === "function";

/**
 * `service` as `Plain<S>`, converted once when the plugin starts: a function
 * runs what it returns through `bridge`, an Effect or stream member becomes a
 * method, and objects inside are converted the same way, down to `DEPTH`
 * levels. A plain object is converted into a copy; a class instance is read
 * through a proxy that keeps its prototype, getters, and private fields (even
 * frozen, since the proxy's own target is a fresh object); built-in data
 * (`isData`) and arrays are left as they are. A function is called on its own
 * object, so `this` inside it is the service.
 *
 * Once the plugin has stopped, nothing is called: a method that returned
 * plain values throws `PluginStopped` where it is called, and any other (one
 * that returned Effects, streams, or promises, or one never called) returns
 * `bridge.refuse`'s refusal, which rejects with it whether awaited or read as
 * a stream. So leaked work that awaits, catches, or iterates never throws
 * synchronously, and work that expects a value fails where it asks.
 */
export const plainView = (service: unknown, bridge: Bridge, name: string): unknown => {
  const wrap = (fn: (...args: unknown[]) => unknown, self: unknown, path: string) => {
    /** Whether it has returned plain values: then, once the plugin stops, it throws where it is called. */
    let plain = false;
    return (...args: unknown[]): unknown => {
      if (bridge.stopped()) {
        if (plain) throw new PluginStopped({ pluginId: bridge.pluginId, operation: path });
        return bridge.refuse(path);
      }
      const result = fn.apply(self, args);
      if (Effect.isEffect(result)) return bridge.run(result, path);
      if (Stream.isStream(result)) return bridge.iterate(result, path);
      plain = !isThenable(result);
      return result;
    };
  };

  const convert = (value: unknown, self: unknown, path: string, depth: number): unknown => {
    if (Effect.isEffect(value)) return () => bridge.run(value, path);
    if (Stream.isStream(value)) return () => bridge.iterate(value, path);
    if (typeof value === "function") return wrap(value as (...args: unknown[]) => unknown, self, path);
    if (typeof value !== "object" || value === null || Array.isArray(value) || depth >= DEPTH || isData(value)) return value;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return proxied(value, path, depth);
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

  /**
   * A class instance, read through: members converted as they are read (and
   * kept, so a method is one function). The proxy's target is a fresh object
   * with the instance's prototype, so it holds no property the proxy must
   * report unchanged, as a frozen instance's would be.
   */
  const proxied = (original: object, path: string, depth: number): unknown => {
    const converted = new Map<PropertyKey, { readonly from: unknown; readonly to: unknown }>();
    const read = (key: PropertyKey): unknown => {
      const value: unknown = Reflect.get(original, key, original);
      if (typeof key === "symbol" && typeof value !== "function") return value;
      const known = converted.get(key);
      if (known !== undefined && known.from === value) return known.to;
      const to = convert(value, original, `${path}.${String(key)}`, depth + 1);
      converted.set(key, { from: value, to });
      return to;
    };
    return new Proxy(Object.create(Object.getPrototypeOf(original)) as object, {
      get: (_, key) => read(key),
      has: (_, key) => Reflect.has(original, key),
      ownKeys: () => Reflect.ownKeys(original),
      getOwnPropertyDescriptor: (_, key) => {
        const descriptor = Reflect.getOwnPropertyDescriptor(original, key);
        return descriptor === undefined ? undefined : { configurable: true, enumerable: descriptor.enumerable ?? false, writable: false, value: read(key) };
      },
    });
  };

  return convert(service, undefined, name, 0);
};
