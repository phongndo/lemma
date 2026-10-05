import { Schema } from "effect";

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** Keywords that mean nothing to a model provider. */
const dropped = new Set(["$schema", "$id", "$anchor", "$comment", "$defs", "definitions"]);
/** Keywords whose value maps names to schemas. */
const schemaMaps = new Set(["properties", "patternProperties", "dependentSchemas"]);
/** Keywords whose value is a schema or an array of schemas. */
const schemaValues = new Set([
  "items",
  "prefixItems",
  "additionalProperties",
  "unevaluatedProperties",
  "unevaluatedItems",
  "contains",
  "propertyNames",
  "not",
  "anyOf",
  "allOf",
  "oneOf",
  "if",
  "then",
  "else",
]);

/** The local definition a `$ref` names (`#/$defs/X`, `#/definitions/X`), else undefined. */
const definitionName = (ref: string): string | undefined => {
  const match = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(ref);
  return match === null ? undefined : decodeURIComponent(match[1]!.replace(/~1/g, "/").replace(/~0/g, "~"));
};

/**
 * An MCP tool's `inputSchema` as model providers take it: local `$ref`s
 * inlined (a recursive one becomes an unconstrained schema), `$schema`, ids,
 * and definitions dropped, and the root an object schema with `properties`,
 * which every major provider requires. Anything else is kept as the server
 * wrote it.
 */
export function inputParameters(inputSchema: unknown): Json {
  const root = isObject(inputSchema) ? inputSchema : {};
  const defs: Json = { ...(isObject(root["definitions"]) ? root["definitions"] : {}), ...(isObject(root["$defs"]) ? root["$defs"] : {}) };
  const clean = (node: unknown, seen: ReadonlySet<string>): unknown => {
    if (Array.isArray(node)) return node.map((item) => clean(item, seen));
    if (!isObject(node)) return node;
    const ref = node["$ref"];
    if (typeof ref === "string") {
      const { $ref: _, ...siblings } = node;
      const name = definitionName(ref);
      const target = name === undefined ? undefined : defs[name];
      if (name === undefined || !isObject(target) || seen.has(name)) return clean(siblings, seen);
      return clean({ ...target, ...siblings }, new Set([...seen, name]));
    }
    const out: Json = {};
    for (const [key, value] of Object.entries(node)) {
      if (dropped.has(key)) continue;
      if (schemaMaps.has(key) && isObject(value)) {
        out[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, clean(child, seen)]));
      } else if (schemaValues.has(key)) {
        out[key] = clean(value, seen);
      } else {
        // `enum`, `default`, `examples`: data, kept as written.
        out[key] = value;
      }
    }
    return out;
  };
  const cleaned = clean(root, new Set()) as Json;
  if (cleaned["type"] === undefined && !("anyOf" in cleaned || "oneOf" in cleaned || "allOf" in cleaned)) cleaned["type"] = "object";
  if (cleaned["type"] === "object" && !isObject(cleaned["properties"])) cleaned["properties"] = {};
  return cleaned;
}

/**
 * A tool input the registry validates only as an object, described to the
 * model by the server's JSON Schema (Effect's `jsonSchema` annotation, which
 * the registry's conversion returns as given). The server validates the rest.
 */
export const inputSchema = (inputSchema: unknown) =>
  Schema.Record({ key: Schema.String, value: Schema.Unknown }).annotations({ jsonSchema: inputParameters(inputSchema) });
