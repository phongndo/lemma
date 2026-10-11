import { Effect, Option, Schema, SchemaTransformation } from "effect";
import type { SchemaAST } from "effect";

// The members of `api.Schema` that Effect 4 dropped or changed, in the forms
// Effect 3 gave them: UI files get these with the rest of Effect 4's Schema.

// Effect 3 schemas annotate with `.annotations(…)`, Effect 4's with `.annotate(…)`. Every schema shares the
// prototype that defines `annotate`; the old name is added there, in this app's copy of Effect only.
const schemaPrototype = (() => {
  for (let proto = Object.getPrototypeOf(Schema.String); proto !== null; proto = Object.getPrototypeOf(proto)) {
    if (Object.prototype.hasOwnProperty.call(proto, "annotate")) return proto as { annotate(annotations: unknown): unknown };
  }
  throw new Error("api.Schema: Effect's schemas no longer define annotate");
})();
if (!Object.prototype.hasOwnProperty.call(schemaPrototype, "annotations")) {
  Object.defineProperty(schemaPrototype, "annotations", {
    value(this: { annotate(annotations: unknown): unknown }, annotations: unknown) {
      return this.annotate(annotations);
    },
    configurable: true,
    writable: true,
  });
}

/**
 * Effect 3's field wrapper, which existed to annotate a field (`propertySignature(String).annotations({ title })`).
 * In Effect 4 a field is its schema, annotated directly, so this returns it as it is.
 */
const propertySignature = <S extends Schema.Top>(schema: S): S => schema;

/** One literal, or a union of several (`Literal("enter", "mod+enter")`), as in Effect 3; Effect 4 spells the union `Literals([…])`. */
function Literal<const L extends SchemaAST.LiteralValue>(literal: L): Schema.Literal<L>;
function Literal<const L extends readonly [SchemaAST.LiteralValue, SchemaAST.LiteralValue, ...SchemaAST.LiteralValue[]]>(...literals: L): Schema.Literals<L>;
function Literal(...literals: readonly [SchemaAST.LiteralValue, ...SchemaAST.LiteralValue[]]): Schema.Top {
  return literals.length === 1 ? Schema.Literal(literals[0]) : Schema.Literals(literals);
}

/** A record with keys of `key` and values of `value`: `Record(key, value)`, or Effect 3's `Record({ key, value })`. */
function Record<K extends Schema.Record.Key, V extends Schema.Constraint>(key: K, value: V): Schema.$Record<K, V>;
function Record<K extends Schema.Record.Key, V extends Schema.Constraint>(options: { readonly key: K; readonly value: V }): Schema.$Record<K, V>;
function Record(key: Schema.Record.Key | { readonly key: Schema.Record.Key; readonly value: Schema.Constraint }, value?: Schema.Constraint): Schema.Top {
  return value === undefined && "value" in key ? Schema.Record(key.key, key.value) : Schema.Record(key as Schema.Record.Key, value!);
}

/** Effect 3's number filters, as Effect 4 checks: `Int.pipe(between(1, 10))` (inclusive), `positive()` (> 0), `nonNegative()` (>= 0). */
const between =
  (minimum: number, maximum: number, annotations?: Schema.Annotations.Filter) =>
  <S extends Schema.Top & { readonly Type: number }>(self: S): S["Rebuild"] =>
    self.check(Schema.isBetween({ minimum, maximum }, annotations));
const positive =
  (annotations?: Schema.Annotations.Filter) =>
  <S extends Schema.Top & { readonly Type: number }>(self: S): S["Rebuild"] =>
    self.check(Schema.isGreaterThan(0, annotations));
const nonNegative =
  (annotations?: Schema.Annotations.Filter) =>
  <S extends Schema.Top & { readonly Type: number }>(self: S): S["Rebuild"] =>
    self.check(Schema.isGreaterThanOrEqualTo(0, annotations));

type OptionalWithOptions = {
  readonly exact?: boolean;
  readonly nullable?: boolean;
  readonly default?: () => unknown;
  readonly as?: "Option";
  readonly onNoneEncoding?: () => Option.Option<null | undefined>;
};
const optionalWithOptions = new Set(["exact", "nullable", "default", "as", "onNoneEncoding"]);

/**
 * Effect 3's optional field with options. The field may be left out; unless
 * `exact`, it may also be undefined, and with `nullable`, null. With a
 * `default`, a field left out, undefined, or null (as those options allow)
 * decodes to the default. With `nullable` alone, null decodes to a field left
 * out. With `as: "Option"`, the field decodes to an Option, None when left out,
 * and None encodes to a field left out (or to `onNoneEncoding()`'s value).
 */
function optionalWith<S extends Schema.Top>(
  schema: S,
  options: { readonly exact?: true; readonly nullable: true; readonly as: "Option"; readonly onNoneEncoding?: () => Option.Option<null | undefined> },
): Schema.decodeTo<Schema.Option<Schema.toType<S>>, Schema.optional<Schema.NullOr<S>>>;
function optionalWith<S extends Schema.Top>(schema: S, options: { readonly exact: true; readonly as: "Option" }): Schema.OptionFromOptionalKey<S>;
function optionalWith<S extends Schema.Top>(schema: S, options: { readonly as: "Option" }): Schema.OptionFromOptional<S>;
function optionalWith<S extends Schema.Top>(
  schema: S,
  options: { readonly exact: true; readonly nullable: true; readonly default: () => S["Type"] },
): Schema.decodeTo<Schema.toType<S>, Schema.optionalKey<Schema.NullOr<S>>>;
function optionalWith<S extends Schema.Top>(
  schema: S,
  options: { readonly nullable: true; readonly default: () => S["Type"] },
): Schema.decodeTo<Schema.toType<S>, Schema.optional<Schema.NullOr<S>>>;
function optionalWith<S extends Schema.Top>(
  schema: S,
  options: { readonly exact: true; readonly nullable: true },
): Schema.decodeTo<Schema.optionalKey<Schema.toType<S>>, Schema.optionalKey<Schema.NullOr<S>>>;
function optionalWith<S extends Schema.Top>(
  schema: S,
  options: { readonly nullable: true },
): Schema.decodeTo<Schema.optional<Schema.toType<S>>, Schema.optional<Schema.NullOr<S>>>;
function optionalWith<S extends Schema.Top>(
  schema: S,
  options: { readonly exact: true; readonly default: () => S["Type"] },
): Schema.withDecodingDefaultTypeKey<S>;
function optionalWith<S extends Schema.Top>(schema: S, options: { readonly default: () => S["Type"] }): Schema.withDecodingDefaultType<S>;
function optionalWith<S extends Schema.Top>(schema: S, options: { readonly exact: true }): Schema.optionalKey<S>;
function optionalWith(schema: Schema.Top, options: OptionalWithOptions): Schema.Top {
  const unsupported = Object.keys(options).find((option) => !optionalWithOptions.has(option));
  if (unsupported !== undefined) throw new Error(`Schema.optionalWith: the "${unsupported}" option is not available`);
  const { exact = false, nullable = false, default: fallback, as } = options;
  if (as === undefined && !nullable) {
    if (fallback === undefined) return exact ? Schema.optionalKey(schema) : Schema.optional(schema);
    return exact ? schema.pipe(Schema.withDecodingDefaultTypeKey(Effect.sync(fallback))) : schema.pipe(Schema.withDecodingDefaultType(Effect.sync(fallback)));
  }
  const optional = exact ? Schema.optionalKey : Schema.optional;
  const encoded = optional(nullable ? Schema.NullOr(schema) : schema);
  /** A value that counts as the field left out. */
  const absent = (value: unknown) => (value === undefined && !exact) || (value === null && nullable);
  const keep = (value: Option.Option<unknown>) => value;
  if (as === "Option") {
    const none = options.onNoneEncoding?.() ?? Option.none();
    return encoded.pipe(
      Schema.decodeTo(
        Schema.Option(Schema.toType(schema)),
        SchemaTransformation.transformOptional<Option.Option<unknown>, unknown>({
          decode: (value) => Option.some(Option.filter(value, (present) => !absent(present))),
          encode: (value) => {
            const inner = Option.flatten(value);
            return Option.isSome(inner) ? inner : none;
          },
        }),
      ),
    );
  }
  if (fallback !== undefined) {
    return encoded.pipe(
      Schema.decodeTo(
        Schema.toType(schema),
        SchemaTransformation.transformOptional<unknown, unknown>({
          decode: (value) =>
            Option.some(
              Option.getOrElse(
                Option.filter(value, (present) => !absent(present)),
                fallback,
              ),
            ),
          encode: keep,
        }),
      ),
    );
  }
  // Only null is dropped: undefined, where allowed, stays undefined, as in Effect 3.
  return encoded.pipe(
    Schema.decodeTo(
      optional(Schema.toType(schema)),
      SchemaTransformation.transformOptional<unknown, unknown>({ decode: (value) => Option.filter(value, (present) => present !== null), encode: keep }),
    ),
  );
}

/**
 * Enough of Effect Schema to declare a config, which the Plugins page turns
 * into a form, and a route's params and search (`api.Schema`). Only these
 * members, so the rest of Schema stays out of the app. They are Effect 4's,
 * with the forms Effect 3 gave `Literal`, `Record`, `between`, `positive`,
 * `nonNegative`, and `optionalWith`, and a `NumberFromString` that fails on
 * text that is not a finite number. A field's title and description are
 * annotations on it: `optional(String).annotate({ title, description })`
 * (Effect 3's `.annotations(…)` and `propertySignature(…)` still work).
 */
export const UiSchema = {
  Array: Schema.Array,
  Boolean: Schema.Boolean,
  Int: Schema.Int,
  Literal,
  Number: Schema.Number,
  // Effect 4's NumberFromString decodes "four" to NaN, where Effect 3's failed.
  NumberFromString: Schema.FiniteFromString,
  Record,
  String: Schema.String,
  Struct: Schema.Struct,
  between,
  nonNegative,
  optional: Schema.optional,
  optionalWith,
  positive,
  propertySignature,
};
