import { createHash } from "node:crypto";
import { Schema } from "effect";
import type { ImageContent, TextContent } from "@lemma/llm";
import { isObject } from "./values.ts";

type Json = Record<string, unknown>;
type Content = TextContent | ImageContent;

/** The parts of a `tools/call` result this plugin reads, as servers of every protocol version send them. */
export interface CallResult {
  readonly content?: readonly Json[];
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
}

/** Keywords whose value is a schema, or a list of them (`items` as a tuple). */
const SUBSCHEMA = new Set([
  "items",
  "additionalItems",
  "additionalProperties",
  "contains",
  "not",
  "if",
  "then",
  "else",
  "propertyNames",
  "unevaluatedItems",
  "unevaluatedProperties",
  "allOf",
  "anyOf",
  "oneOf",
  "prefixItems",
]);
/** Keywords whose value maps names (a property's, say) to schemas; `dependencies` may map one to a list of names. */
const SUBSCHEMAS = new Set(["properties", "patternProperties", "dependentSchemas", "dependencies"]);

/**
 * A tool's `inputSchema` as the tools registry offers it to a model: its own `$ref`s into `$defs` or `definitions`
 * inlined (the registry inlines only its own), a reference back into itself left unconstrained, and an object at the
 * root with `properties`, which providers require. Only schemas are walked: a property named `definitions`, or an
 * `enum` value with a `$ref`, is kept as it is.
 */
export function inputSchema(schema: unknown): Json {
  const root = isObject(schema) ? schema : {};
  const defs: Json = { ...(isObject(root["definitions"]) ? root["definitions"] : {}), ...(isObject(root["$defs"]) ? root["$defs"] : {}) };
  const inline = (node: unknown, seen: ReadonlySet<string>): unknown => {
    if (Array.isArray(node)) return node.map((item) => inline(item, seen));
    if (!isObject(node)) return node;
    const ref = node["$ref"];
    if (typeof ref === "string") {
      const { $ref: _, ...siblings } = node;
      const name = decodeURIComponent(ref.replace(/^#\/(\$defs|definitions)\//, ""));
      const target = defs[name];
      if (ref === name || !isObject(target) || seen.has(name)) return inline(siblings, seen);
      return inline({ ...target, ...siblings }, new Set([...seen, name]));
    }
    return Object.fromEntries(
      Object.entries(node).flatMap(([key, value]): [string, unknown][] => {
        // Inlined where they are used.
        if (key === "$defs" || key === "definitions") return [];
        if (SUBSCHEMA.has(key)) return [[key, inline(value, seen)]];
        if (SUBSCHEMAS.has(key) && isObject(value))
          return [[key, Object.fromEntries(Object.entries(value).map(([name, item]) => [name, Array.isArray(item) ? item : inline(item, seen)]))]];
        return [[key, value]];
      }),
    );
  };
  const out = inline(root, new Set()) as Json;
  return { ...out, type: "object", properties: isObject(out["properties"]) ? out["properties"] : {} };
}

/**
 * The input a tool declares: anything, checked by the server, which is shown to the model as the server's JSON Schema
 * (the tools registry takes the schema from the check's annotation, as the builtin `edit` tool's is).
 */
export const inputOf = (schema: unknown) => {
  const parameters = inputSchema(schema);
  return Schema.Unknown.check(Schema.makeFilter(() => true, { toJsonSchema: () => parameters }));
};

/**
 * What a script's call of a tool resolves to: the server's whole `CallToolResult` (`content` as the server sent it,
 * every block, before the model's output is bounded), its `structuredContent` typed by the tool's `outputSchema` when
 * it declares one.
 */
export const outputOf = (outputSchema: unknown) => {
  const result = {
    type: "object",
    properties: {
      content: { type: "array", items: { type: "object" }, description: "Content blocks: text, image (`data` base64, `mimeType`), resource, …" },
      structuredContent: isObject(outputSchema) ? inputSchema(outputSchema) : {},
      isError: { type: "boolean" },
    },
    required: ["content"],
  };
  return Schema.Unknown.check(Schema.makeFilter(() => true, { toJsonSchema: () => result }));
};

/** The `CallToolResult` a script's call resolves to (`outputOf`). */
export const structuredOf = (result: CallResult): Json => ({
  content: result.content ?? [],
  ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
  ...(result.isError === undefined ? {} : { isError: result.isError }),
});

/** The namespace of a server's tools, as their names begin: `mcp__<server>`, every other character `_`. */
export const namespaceOf = (server: string): string => `mcp__${server.replace(unsafe, "_")}`;

/** Characters a name keeps: providers accept `[A-Za-z0-9_-]{1,64}`, and `-` would not survive as a script's identifier. */
const unsafe = /[^A-Za-z0-9_]/g;
const MAX_NAME = 64;
const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 8);

/**
 * Lemma's names for a server's tools, by the server's: `mcp__<server>__<tool>`, every other character `_`. A name too
 * long for providers, or one two tools would share, is shortened and ends in a hash of the server's and the tool's
 * names instead, so two servers whose names begin alike keep theirs apart.
 */
export function toolNames(server: string, tools: readonly string[]): ReadonlyMap<string, string> {
  const base = (tool: string) => `mcp__${server.replace(unsafe, "_")}__${tool.replace(unsafe, "_")}`;
  const counts = new Map<string, number>();
  for (const tool of tools) counts.set(base(tool), (counts.get(base(tool)) ?? 0) + 1);
  return new Map(
    tools.map((tool) => {
      const name = base(tool);
      return [tool, name.length <= MAX_NAME && counts.get(name) === 1 ? name : `${name.slice(0, MAX_NAME - 9)}_${hash(`${server}\0${tool}`)}`];
    }),
  );
}

const size = (base64: string) => Math.floor((base64.length * 3) / 4);

/**
 * A result's content for the model: text and images as they are, and what a model cannot read (audio, a binary
 * resource) as a line saying what it was. A result with no content but structured data is that data as JSON.
 */
export function toContent(result: CallResult): Content[] {
  const out: Content[] = [];
  for (const block of result.content ?? []) {
    const type = block["type"];
    if (type === "text" && typeof block["text"] === "string") out.push({ type: "text", text: block["text"] });
    else if (type === "image" && typeof block["data"] === "string" && typeof block["mimeType"] === "string")
      out.push({ type: "image", data: block["data"], mimeType: block["mimeType"] });
    else if (type === "audio" && typeof block["data"] === "string")
      out.push({ type: "text", text: `[Audio: ${String(block["mimeType"])}, ${size(block["data"])} bytes]` });
    else if (type === "resource_link") {
      const description = typeof block["description"] === "string" ? `: ${block["description"]}` : "";
      out.push({ type: "text", text: `[Resource ${String(block["name"] ?? block["uri"])} at ${String(block["uri"])}${description}]` });
    } else if (type === "resource" && isObject(block["resource"])) {
      const resource = block["resource"];
      const uri = String(resource["uri"]);
      const mimeType = typeof resource["mimeType"] === "string" ? resource["mimeType"] : undefined;
      if (typeof resource["text"] === "string") out.push({ type: "text", text: resource["text"] });
      else if (typeof resource["blob"] === "string" && mimeType?.startsWith("image/")) out.push({ type: "image", data: resource["blob"], mimeType });
      else if (typeof resource["blob"] === "string")
        out.push({ type: "text", text: `[Resource ${uri}: ${mimeType ?? "binary"}, ${size(resource["blob"])} bytes]` });
    } else out.push({ type: "text", text: `[Content of type ${String(type)}]` });
  }
  if (out.length === 0 && result.structuredContent !== undefined) out.push({ type: "text", text: JSON.stringify(result.structuredContent) });
  return out;
}
