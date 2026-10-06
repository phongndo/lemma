import { Effect, Schema } from "effect";

/** A value a config file can hold: what JSON can say. */
export type ConfigValue = string | number | boolean | null | readonly ConfigValue[] | { readonly [key: string]: ConfigValue };

/** A config described by its defaults: `{ ask: ["shell"], limit: 3 }`. */
export type ConfigDefaults = { readonly [key: string]: ConfigValue };

/** What a plugin's `config` may be: a Schema, or the defaults a Schema is derived from. */
export type ConfigInput = Schema.Codec<any, any> | ConfigDefaults;

/** The decoded config for defaults `D`: their types, literals widened (`"shell"` is a `string`). */
export type Widen<T> = T extends string
  ? string
  : T extends number
    ? number
    : T extends boolean
      ? boolean
      : T extends readonly (infer E)[]
        ? [E] extends [never]
          ? readonly unknown[]
          : readonly Widen<E>[]
        : T extends object
          ? { readonly [K in keyof T]: Widen<T[K]> }
          : T;

/** The decoded config a plugin's `config` describes; `void` when it has none. */
export type ConfigOf<C> = [C] extends [undefined] ? void : C extends Schema.Codec<infer T, any, any, any> ? T : Widen<C>;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/** The Schema of one value, without a default: what an element of an array, or a field given in full, must be. */
const shapeOf = (value: ConfigValue, path: string): Schema.Codec<any, any> => {
  if (typeof value === "string") return Schema.String;
  if (typeof value === "number") return Schema.Finite;
  if (typeof value === "boolean") return Schema.Boolean;
  if (value === null) return Schema.Null;
  if (Array.isArray(value)) {
    const elements = value as readonly ConfigValue[];
    if (elements.length === 0) return Schema.Array(Schema.Unknown);
    // One Schema per kind of element the default shows (the first of each kind gives an object's or an array's shape),
    // so a list may hold what its default holds, as its type says, and nothing else.
    const firstOfKind = new Map<string, ConfigValue>();
    for (const element of elements) {
      const kind = element === null ? "null" : Array.isArray(element) ? "array" : typeof element;
      if (!firstOfKind.has(kind)) firstOfKind.set(kind, element);
    }
    const shapes = [...firstOfKind.values()].map((element, index) => shapeOf(element, `${path}[${index}]`));
    return Schema.Array(shapes.length === 1 ? shapes[0]! : Schema.Union(shapes));
  }
  if (isRecord(value))
    return Schema.Struct(Object.fromEntries(Object.entries(value).map(([key, field]) => [key, shapeOf(field as ConfigValue, `${path}.${key}`)])));
  throw new TypeError(`Config default at ${path} is not a JSON value (a string, number, boolean, null, array, or plain object)`);
};

/** A field that decodes to its default when absent: a copy each time, so a plugin changing its config cannot change the default. */
const fieldOf = (value: ConfigValue, path: string): Schema.Codec<any, any> => {
  const schema = isRecord(value) ? structOf(value as ConfigDefaults, path) : shapeOf(value, path);
  return schema.pipe(Schema.withDecodingDefaultType(Effect.sync(() => structuredClone(value)))) as Schema.Codec<any, any>;
};

const structOf = (defaults: ConfigDefaults, path: string) =>
  Schema.Struct(Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, fieldOf(value, path === "" ? key : `${path}.${key}`)])));

/**
 * A config Schema from its defaults: every field takes the default's type and
 * is optional, decoding to the default when absent; a nested object's fields
 * default one by one. Numbers are finite; an array takes elements of the kinds
 * its default holds (strings, numbers, and so on, an object or array element
 * shaped as the first of its kind), or anything when it is empty. For titles,
 * descriptions, or constraints, write the Schema itself.
 */
export function configSchema<const D extends ConfigDefaults>(defaults: D): Schema.Codec<Widen<D>, unknown> {
  if (!isRecord(defaults)) throw new TypeError("Config defaults must be a plain object");
  return structOf(defaults, "") as unknown as Schema.Codec<Widen<D>, unknown>;
}

/** A plugin's `config` as a Schema: itself, or derived from its defaults. */
export const toConfigSchema = (config: ConfigInput): Schema.Codec<any, any> =>
  Schema.isSchema(config) ? (config as Schema.Codec<any, any>) : configSchema(config as ConfigDefaults);
