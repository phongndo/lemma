import { Either, Option, Schema, SchemaAST } from "effect";

/**
 * Settings forms are projected from a plugin's config Schema, so a plugin gets
 * a settings UI by declaring its config. Only scalar fields (and lists of
 * strings) become form fields; anything nested is edited in the config file.
 * Describe a field with a `description` (and optionally `title`) annotation on
 * its property signature, and mark one whose value clients must never receive
 * with `secret`:
 *
 *   token: Schema.optional(Schema.String).annotations({ ...secret, description: "…" })
 *   baseUrl: Schema.propertySignature(Schema.String).annotations({ description: "…" })
 */
export const SecretAnnotationId: unique symbol = Symbol.for("lemma/config/secret");
export const secret = { [SecretAnnotationId]: true } as const;

export const ConfigField = Schema.Struct({
  key: Schema.String,
  title: Schema.String,
  description: Schema.optional(Schema.String),
  /** `strings` is a list of strings; `other` is anything a form does not edit (nested objects, records). */
  type: Schema.Literal("string", "number", "integer", "boolean", "enum", "strings", "other"),
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
  values: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  /** Secret fields that have a value. */
  secretsSet: Schema.Array(Schema.String),
});
export type ConfigValues = typeof ConfigValues.Type;

/** `maxSteps` reads as `Max steps`. */
const titleOf = (key: string): string => {
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
};

const stripRefinements = (ast: SchemaAST.AST): SchemaAST.AST => (SchemaAST.isRefinement(ast) ? stripRefinements(ast.from) : ast);

/** Drops `undefined` from a union: optional fields carry it in their type. */
const defined = (ast: SchemaAST.AST): SchemaAST.AST => {
  if (!SchemaAST.isUnion(ast)) return ast;
  const members = ast.types.filter((member) => !SchemaAST.isUndefinedKeyword(member));
  return members.length === 1 ? members[0]! : SchemaAST.Union.make(members);
};

const classify = (ast: SchemaAST.AST): Pick<ConfigField, "type" | "options"> => {
  const type = defined(ast);
  const base = stripRefinements(type);
  if (SchemaAST.isStringKeyword(base)) return { type: "string" };
  if (SchemaAST.isBooleanKeyword(base)) return { type: "boolean" };
  if (SchemaAST.isNumberKeyword(base)) {
    // Refinements carry no portable "integer" marker, so ask the schema itself.
    const is = Schema.is(Schema.make(type));
    return { type: is(1) && !is(1.5) ? "integer" : "number" };
  }
  if (SchemaAST.isLiteral(base) && typeof base.literal === "string") return { type: "enum", options: [base.literal] };
  if (SchemaAST.isUnion(base) && base.types.every((member) => SchemaAST.isLiteral(member) && typeof member.literal === "string")) {
    return { type: "enum", options: base.types.map((member) => String((member as SchemaAST.Literal).literal)) };
  }
  if (SchemaAST.isTupleType(base) && base.elements.length === 0 && base.rest.length === 1 && SchemaAST.isStringKeyword(stripRefinements(base.rest[0]!.type))) {
    return { type: "strings" };
  }
  return { type: "other" };
};

const annotation = <A>(signatures: readonly SchemaAST.Annotated[], get: (annotated: SchemaAST.Annotated) => Option.Option<A>): A | undefined => {
  for (const signature of signatures) {
    const found = get(signature);
    if (Option.isSome(found)) return found.value;
  }
  return undefined;
};

const isSecret = (annotated: SchemaAST.Annotated): boolean => annotated.annotations[SecretAnnotationId] === true;

/** The struct's property signatures on its decoded side, with the encoded side's for annotations a transformation keeps there. */
function properties(schema: Schema.Schema.AnyNoContext): { key: string; type: SchemaAST.AST; optional: boolean; annotated: SchemaAST.Annotated[] }[] {
  const decoded = SchemaAST.typeAST(schema.ast);
  const encoded = SchemaAST.encodedAST(schema.ast);
  if (!SchemaAST.isTypeLiteral(decoded)) return [];
  const encodedSignatures = SchemaAST.isTypeLiteral(encoded) ? encoded.propertySignatures : [];
  return decoded.propertySignatures
    .filter((signature): signature is SchemaAST.PropertySignature & { name: string } => typeof signature.name === "string")
    .map((signature) => {
      const other = encodedSignatures.find((candidate) => candidate.name === signature.name);
      return {
        key: signature.name,
        type: signature.type,
        // A field with a default is required once decoded but may be left out of the file.
        optional: signature.isOptional || other?.isOptional === true,
        // Not the type's: built-in refinements annotate themselves ("a positive number").
        annotated: [signature, ...(other === undefined ? [] : [other])],
      };
    });
}

/** What the plugin decodes an empty config to, encoded again: its defaults. Undefined when `{}` is not a valid config. */
const defaultsOf = (schema: Schema.Schema.AnyNoContext): Record<string, unknown> | undefined => {
  const decoded = Schema.decodeUnknownEither(schema)({});
  if (Either.isLeft(decoded)) return undefined;
  const encoded = Schema.encodeEither(schema)(decoded.right);
  return Either.isRight(encoded) && typeof encoded.right === "object" && encoded.right !== null ? (encoded.right as Record<string, unknown>) : undefined;
};

/** The form for a config Schema: one field per top-level property. Empty for a Schema that is not a struct. */
export function describeConfig(schema: Schema.Schema.AnyNoContext): ConfigField[] {
  const defaults = defaultsOf(schema) ?? {};
  return properties(schema).map((property) => {
    const description = annotation(property.annotated, SchemaAST.getDescriptionAnnotation);
    const title = annotation(property.annotated, SchemaAST.getTitleAnnotation);
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
export function configValues(schema: Schema.Schema.AnyNoContext, config: unknown, fields: readonly ConfigField[] = describeConfig(schema)): ConfigValues {
  const decoded = Schema.decodeUnknownEither(schema)(config ?? {});
  const encoded = Either.isRight(decoded) ? Schema.encodeEither(schema)(decoded.right) : Either.right(config);
  const effective = Either.isRight(encoded) && typeof encoded.right === "object" && encoded.right !== null ? (encoded.right as Record<string, unknown>) : {};
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

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

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
  schema: Schema.Schema<A, I>,
  migrate: (config: Readonly<Record<string, unknown>>) => Record<string, unknown>,
): Schema.Schema<A, unknown> =>
  Schema.compose(
    Schema.transform(Schema.Unknown, Schema.Unknown, {
      strict: true,
      decode: (config) => (isRecord(config) ? migrate(config) : config),
      encode: (config) => config,
    }),
    schema,
    { strict: false },
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
