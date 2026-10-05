import { ToolResult } from "@lemma/contracts";
import type { CallToolResult } from "@modelcontextprotocol/client";

type Content = ToolResult["content"][number];

/** Image types every provider accepts. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** Base64 characters an image may take; past this it is described instead, as the `read` tool does (3.75MB decoded). */
const MAX_IMAGE_CHARS = Math.ceil((3.75 * 1024 * 1024 * 4) / 3);

const size = (base64: string): string => {
  const bytes = Math.floor((base64.length * 3) / 4);
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

const image = (data: string, mimeType: string, what: string): Content =>
  !IMAGE_TYPES.has(mimeType)
    ? { type: "text", text: `[${what}: ${mimeType}, ${size(data)}, not shown: the model takes PNG, JPEG, GIF, or WebP]` }
    : data.length > MAX_IMAGE_CHARS
      ? { type: "text", text: `[${what}: ${mimeType}, ${size(data)}, too large to show]` }
      : { type: "image", data, mimeType };

/** A resource the server embedded or linked, as the model reads it. */
const resourceHeader = (resource: { readonly uri: string; readonly mimeType?: string | undefined }) =>
  `[Resource ${resource.uri}${resource.mimeType === undefined ? "" : ` (${resource.mimeType})`}]`;

/** One MCP content block as content a model takes: text and images pass through, everything else is described in text. */
export function toContent(block: CallToolResult["content"][number]): Content {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "image":
      return image(block.data, block.mimeType, "Image");
    case "audio":
      return { type: "text", text: `[Audio: ${block.mimeType}, ${size(block.data)}, not shown: the model does not take audio]` };
    case "resource_link": {
      const about = [block.title ?? block.name, block.description].filter(Boolean).join(": ");
      return { type: "text", text: `${resourceHeader(block)} ${about}`.trimEnd() };
    }
    case "resource": {
      const resource = block.resource;
      if ("text" in resource) return { type: "text", text: `${resourceHeader(resource)}\n${resource.text}` };
      if (resource.mimeType?.startsWith("image/")) return image(resource.blob, resource.mimeType, `Image ${resource.uri}`);
      return { type: "text", text: `${resourceHeader(resource)} binary, ${size(resource.blob)}, not shown` };
    }
    default:
      return { type: "text", text: JSON.stringify(block) };
  }
}

/** What the tools panel shows of a call beyond its content: never sent to the model. */
export interface McpCallDetails {
  readonly server: string;
  /** The server's name for the tool. */
  readonly tool: string;
}

/**
 * What a codemode script's call resolves to: the server's structured result,
 * else the JSON object or array its text holds, else its text; a result with
 * more than text (an image, a resource) is its content blocks, which the
 * script's `image()` shows.
 */
export function scriptValue(result: CallToolResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const blocks = result.content ?? [];
  if (!blocks.every((block) => block.type === "text")) return blocks.map(({ _meta, ...block }) => block);
  const text = blocks.map((block) => block.text).join("\n");
  if (/^\s*[[{]/.test(text)) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      // Prose that starts with a bracket.
    }
  }
  return text;
}

/**
 * A `tools/call` result as the registry takes it. Structured output reaches
 * the model as JSON only when the server sent no content alongside it (the
 * spec asks servers to send both). A result that is not an error carries
 * `scriptValue` as its `structuredContent`; an error has none, so a script's
 * call rejects with its text.
 */
export function toToolResult(result: CallToolResult, details: McpCallDetails): ToolResult {
  const content = (result.content ?? []).map(toContent);
  const structured = result.structuredContent;
  if (content.length === 0 && structured !== undefined) content.push({ type: "text", text: JSON.stringify(structured, null, 2) });
  // Providers reject an empty tool result.
  if (content.length === 0) content.push({ type: "text", text: result.isError ? "The tool failed without saying why." : "(no output)" });
  return new ToolResult({
    content,
    details,
    ...(result.isError ? { isError: true } : { structuredContent: scriptValue(result) }),
  });
}
