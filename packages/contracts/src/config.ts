import { Predicate, Result, Schema, SchemaAST, SchemaTransformation } from "effect";

/**
 * Settings forms are projected from a plugin's config Schema, so a plugin gets
 * a settings UI by declaring its config. Only scalar fields (and lists of
 * strings) become form fields; anything nested is edited in the config file.
 * Describe a field with a `description` (and optionally `title`) annotation on
 * its property signature, and mark one whose value clients must never receive
 * with `secret`:
 *
 *   token: Schema.optional(Schema.String).annotate({ ...secret, description: "…" })
 *   baseUrl: Schema.String.annotateKey({ description: "…" })
 */
export const SecretAnnotationId: unique symbol = Symbol.for("lemma/config/secret");
export const secret = { [SecretAnnotationId]: true } as const;

export const ConfigField = Schema.Struct({
  key: Schema.String,
  title: Schema.String,
  description: Schema.optional(Schema.String),
  /** `strings` is a list of strings; `other` is anything a form does not edit (nested objects, records). */
  type: Schema.Literals(["string", "number", "integer", "boolean", "enum", "strings", "other"]),
  /** The choices of an `enum`. */
  options: Schema.optional(Schema.Array(Schema.String)),
  /** May be left unset. */
  optional: Schema.Boolean,
  /** Its value is never sent to clients; they only learn whether it is set. */
  secret: Schema.optional(Schema.Boolean),
  /** What the plugin gets when the field is unset. */
  default: Schema.optional(Schema.Unknown),
});
export type ConfigField = typeof ConfigField.Type;

/** A plugin's config as a settings form shows it: editable values, and which secret fields hold a value. */
export const ConfigValues = Schema.Struct({
  /** The config the plugin runs with, by field key: scalar and string-list fields that are not secret. */
  values: Schema.Record(Schema.String, Schema.Unknown),
  /** Secret fields that have a value. */
  secretsSet: Schema.Array(Schema.String),
});
export type ConfigValues = typeof ConfigValues.Type;

/** `maxSteps` reads as `Max steps`. */
const titleOf = (key: string): string => {
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
};

/** Drops `undefined` from a union: optional fields carry it in their type. */
const defined = (ast: SchemaAST.AST): readonly SchemaAST.AST[] =>
  SchemaAST.isUnion(ast) ? ast.types.filter((member) => !SchemaAST.isUndefined(member)) : [ast];

const classify = (ast: SchemaAST.AST): Pick<ConfigField, "type" | "options"> => {
  const members = defined(ast);
  const base = members.length === 1 ? members[0]! : undefined;
  if (base !== undefined && SchemaAST.isString(base)) return { type: "string" };
  if (base !== undefined && SchemaAST.isBoolean(base)) return { type: "boolean" };
  if (base !== undefined && SchemaAST.isNumber(base)) {
    // Checks carry no portable "integer" marker, so ask the schema itself.
    const is = Schema.is(Schema.make(base));
    return { type: is(1) && !is(1.5) ? "integer" : "number" };
  }
  const literals = members.flatMap((member) => (SchemaAST.isUnion(member) ? member.types : [member]));
  if (literals.length > 0 && literals.every((member) => SchemaAST.isLiteral(member) && typeof member.literal === "string")) {
    return { type: "enum", options: literals.map((member) => String((member as SchemaAST.Literal).literal)) };
  }
  if (base !== undefined && SchemaAST.isArrays(base) && base.elements.length === 0 && base.rest.length === 1 && SchemaAST.isString(base.rest[0]!)) {
    return { type: "strings" };
  }
  return { type: "other" };
};

/** A field's annotations: those on its key, then its type's (a refined type keeps them on its last check). */
const annotationsOf = (ast: SchemaAST.AST): Schema.Annotations.Annotations => ({ ...SchemaAST.resolve(ast), ...ast.context?.annotations });

const annotation = (asts: readonly SchemaAST.AST[], key: "title" | "description"): string | undefined => {
  for (const ast of asts) {
    const found = annotationsOf(ast)[key];
    if (typeof found === "string") return found;
  }
  return undefined;
};

const isSecret = (ast: SchemaAST.AST): boolean => (annotationsOf(ast) as Record<PropertyKey, unknown>)[SecretAnnotationId] === true;

/** The struct's property signatures on its decoded side, with the encoded side's for annotations a transformation keeps there. */
function properties(schema: Schema.Top): { key: string; type: SchemaAST.AST; optional: boolean; annotated: SchemaAST.AST[] }[] {
  const decoded = SchemaAST.toType(schema.ast);
  const encoded = SchemaAST.toEncoded(schema.ast);
  if (!SchemaAST.isObjects(decoded)) return [];
  const encodedSignatures = SchemaAST.isObjects(encoded) ? encoded.propertySignatures : [];
  return decoded.propertySignatures
    .filter((signature): signature is SchemaAST.PropertySignature & { name: string } => typeof signature.name === "string")
    .map((signature) => {
      const other = encodedSignatures.find((candidate) => candidate.name === signature.name);
      return {
        key: signature.name,
        type: signature.type,
        // A field with a default is required once decoded but may be left out of the file.
        optional: SchemaAST.isOptional(signature.type) || (other !== undefined && SchemaAST.isOptional(other.type)),
        annotated: [signature.type, ...(other === undefined ? [] : [other.type])],
      };
    });
}

/** What the plugin decodes an empty config to, encoded again: its defaults. Undefined when `{}` is not a valid config. */
const defaultsOf = (schema: Schema.Codec<any, any>): Record<string, unknown> | undefined => {
  const decoded = Schema.decodeUnknownResult(schema)({});
  if (Result.isFailure(decoded)) return undefined;
  const encoded = Schema.encodeResult(schema)(decoded.success);
  return Result.isSuccess(encoded) && typeof encoded.success === "object" && encoded.success !== null
    ? (encoded.success as Record<string, unknown>)
    : undefined;
};

/** The form for a config Schema: one field per top-level property. Empty for a Schema that is not a struct. */
export function describeConfig(schema: Schema.Codec<any, any>): ConfigField[] {
  const defaults = defaultsOf(schema) ?? {};
  return properties(schema).map((property) => {
    const description = annotation(property.annotated, "description");
    const title = annotation(property.annotated, "title");
    const secretField = property.annotated.some(isSecret);
    return {
      key: property.key,
      title: title ?? titleOf(property.key),
      ...(description === undefined ? {} : { description }),
      ...classify(property.type),
      // A field an empty config gives a value to may be left out too, whatever the Schema's encoded side says.
      optional: property.optional || property.key in defaults,
      ...(secretField ? { secret: true } : {}),
      ...(property.key in defaults && !secretField ? { default: defaults[property.key] } : {}),
    };
  });
}

/**
 * `config` as the plugin receives it (defaults applied), keeping only what a
 * form edits and never a secret's value. An invalid config (the plugin would
 * not load) is shown as written.
 */
export function configValues(schema: Schema.Codec<any, any>, config: unknown, fields: readonly ConfigField[] = describeConfig(schema)): ConfigValues {
  const decoded = Schema.decodeUnknownResult(schema)(config ?? {});
  const encoded = Result.isSuccess(decoded) ? Schema.encodeResult(schema)(decoded.success) : Result.succeed(config);
  const effective =
    Result.isSuccess(encoded) && typeof encoded.success === "object" && encoded.success !== null ? (encoded.success as Record<string, unknown>) : {};
  const values: Record<string, unknown> = {};
  const secretsSet: string[] = [];
  for (const field of fields) {
    const value = effective[field.key];
    if (value === undefined) continue;
    if (field.secret) secretsSet.push(field.key);
    else if (field.type !== "other") values[field.key] = value;
  }
  return { values, secretsSet };
}

/**
 * `schema`, also reading the rows earlier versions of a plugin wrote:
 * `migrate` turns a row's config into the current shape before it decodes, so
 * renaming or restructuring a setting keeps existing rows working without
 * rewriting anyone's file. It sees current rows too, and must leave them as
 * they are. The settings form is still `schema`'s.
 *
 *   config: migrateConfig(Config, ({ steps, ...rest }) => (steps === undefined ? rest : { maxSteps: steps, ...rest }))
 */
export const migrateConfig = <A, I>(
  schema: Schema.Codec<A, I>,
  migrate: (config: Readonly<Record<string, unknown>>) => Record<string, unknown>,
): Schema.Codec<A, unknown> =>
  Schema.Unknown.pipe(
    Schema.decodeTo(
      schema,
      SchemaTransformation.transform<I, unknown>({
        decode: (config) => (Predicate.isObject(config) ? migrate(config) : config) as I,
        encode: (config) => config,
      }),
    ),
  );

const BOOLEANS: Readonly<Record<string, boolean>> = { true: true, false: false, on: true, off: false, yes: true, no: false };

/**
 * Text typed for a field (a CLI argument, a form input) as a value of its
 * type. Without a field, JSON when the text parses as JSON, else the text.
 */
export function parseConfigValue(field: ConfigField | undefined, text: string): { readonly value: unknown } | { readonly error: string } {
  const json = (): { value: unknown } | undefined => {
    try {
      return { value: JSON.parse(text) };
    } catch {
      return undefined;
    }
  };
  if (field === undefined) return json() ?? { value: text };
  switch (field.type) {
    case "string":
      return { value: text };
    case "number":
    case "integer": {
      const value = Number(text.trim());
      if (text.trim() === "" || !Number.isFinite(value)) return { error: `${field.key} must be a number` };
      if (field.type === "integer" && !Number.isInteger(value)) return { error: `${field.key} must be a whole number` };
      return { value };
    }
    case "boolean": {
      const value = BOOLEANS[text.trim().toLowerCase()];
      return value === undefined ? { error: `${field.key} must be true or false` } : { value };
    }
    case "enum":
      return field.options?.includes(text) ? { value: text } : { error: `${field.key} must be one of ${field.options?.join(", ")}` };
    case "strings":
      return {
        value: text
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
      };
    case "other":
      return json() ?? { error: `${field.key} takes JSON` };
  }
}
