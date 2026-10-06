import { JsonSchema as EffectJsonSchema, SchemaRepresentation } from "effect";
import type { Schema } from "effect";
import type { JsonSchema } from "@lemma/contracts";

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** Keywords that mean nothing to a model provider, or that some providers reject. */
const dropped = new Set(["$schema", "$id", "$defs", "definitions", "$comment", "title"]);
/** Keywords whose value is a map of name → schema. */
const schemaMaps = new Set(["properties", "patternProperties"]);
/** Keywords whose value is a schema or an array of schemas. */
const schemaValues = new Set([
  "items",
  "additionalProperties",
  "additionalItems",
  "not",
  "anyOf",
  "allOf",
  "oneOf",
  "prefixItems",
  "contains",
  "propertyNames",
]);

type Representation = SchemaRepresentation.Representation;

/**
 * Drops `undefined` from unions: a model's JSON arguments never hold it, so an
 * optional field is offered as its value type (Effect would offer `null`, which
 * the decoder rejects).
 */
const withoutUndefined = (node: Representation): Representation => {
  switch (node._tag) {
    case "Union": {
      const types = node.types.filter((member) => member._tag !== "Undefined").map(withoutUndefined);
      const plain = node.checks.length === 0 && node.annotations === undefined;
      return types.length === 1 && plain ? types[0]! : { ...node, types };
    }
    case "Objects":
      return {
        ...node,
        propertySignatures: node.propertySignatures.map((signature) => ({ ...signature, type: withoutUndefined(signature.type) })),
        indexSignatures: node.indexSignatures.map((signature) => ({ ...signature, type: withoutUndefined(signature.type) })),
      };
    case "Arrays":
      return {
        ...node,
        elements: node.elements.map((element) => ({ ...element, type: withoutUndefined(element.type) })),
        rest: node.rest.map(withoutUndefined),
      };
    case "Suspend":
      return { ...node, thunk: withoutUndefined(node.thunk) };
    default:
      return node;
  }
};

/** Effect's JSON form of a number admits the strings `"NaN"`, `"Infinity"`, `"-Infinity"`; a decoded tool input does not. */
const isNumberEncoding = (node: Json): boolean => {
  const anyOf = node["anyOf"];
  if (!Array.isArray(anyOf) || anyOf.length !== 2 || !isObject(anyOf[0]) || !isObject(anyOf[1])) return false;
  const [number, special] = anyOf;
  const names = special["enum"];
  return (
    Object.keys(number).length === 1 &&
    number["type"] === "number" &&
    special["type"] === "string" &&
    Array.isArray(names) &&
    names.length === 3 &&
    ["NaN", "Infinity", "-Infinity"].every((name) => names.includes(name))
  );
};

/**
 * Provider-friendly JSON Schema (draft-07) for a tool input's encoded side:
 * `$schema`, ids, and titles removed, and every `$ref` inlined (sibling
 * keywords such as a field's description override the definition's). A
 * recursive reference cannot be inlined and becomes an unconstrained schema.
 * Objects are closed (`additionalProperties: false`), optional fields are
 * offered as their value type, and numbers as plain `number`. The root is
 * always an object schema with `properties`, which every major provider
 * requires.
 */
export function toolParameters(schema: Schema.Top): JsonSchema {
  const { representation, references } = SchemaRepresentation.toRepresentation(schema.ast);
  const document = EffectJsonSchema.toDocumentDraft07(
    SchemaRepresentation.toJsonSchemaDocument(
      {
        representation: withoutUndefined(representation),
        references: Object.fromEntries(Object.entries(references).map(([name, reference]) => [name, withoutUndefined(reference)])),
      },
      { onExcessProperty: "error" },
    ),
  );
  const defs: Json = { ...document.definitions };

  const clean = (node: unknown, seen: ReadonlySet<string>): unknown => {
    if (Array.isArray(node)) return node.map((item) => clean(item, seen));
    if (!isObject(node)) return node;
    const ref = node["$ref"];
    if (typeof ref === "string") {
      const { $ref: _, ...siblings } = node;
      const name = decodeURIComponent(ref.replace(/^#\/(\$defs|definitions)\//, ""));
      const target = defs[name];
      if (!isObject(target) || seen.has(name)) return clean(siblings, seen);
      return clean({ ...target, ...siblings }, new Set([...seen, name]));
    }
    if (isNumberEncoding(node)) {
      const { anyOf: _, ...siblings } = node;
      return clean({ type: "number", ...siblings }, seen);
    }
    const out: Json = {};
    for (const [key, value] of Object.entries(node)) {
      if (dropped.has(key)) continue;
      if (schemaMaps.has(key) && isObject(value)) {
        out[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, clean(child, seen)]));
      } else if (schemaValues.has(key)) {
        out[key] = clean(value, seen);
      } else {
        out[key] = value;
      }
    }
    return out;
  };

  const cleaned = clean(document.schema, new Set()) as Json;
  const composite = "anyOf" in cleaned || "oneOf" in cleaned || "allOf" in cleaned;
  if (cleaned["type"] === undefined && !composite) cleaned["type"] = "object";
  if (cleaned["type"] === "object" && cleaned["properties"] === undefined) cleaned["properties"] = {};
  return cleaned;
}
