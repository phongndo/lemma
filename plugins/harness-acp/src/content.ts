import type * as acp from "@agentclientprotocol/sdk";
import { emptyUsage } from "@lemma/contracts";
import type { ImageContent, PromptContent, TextContent, Usage } from "@lemma/contracts";
import type { RecordedResult } from "@lemma/plugin-harnesses";
import { unifiedPatch } from "@lemma/plugin-tools-builtin";

/*
 * Translations between ACP's shapes and the log's. Pure, so the adapter's
 * protocol handling stays separate from what a call or result looks like.
 */

/** Characters of a tool's raw output kept when it reports no content. */
const RAW_OUTPUT_CHARS = 20_000;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Everything the agent has said about one tool call so far: `tool_call` and the `tool_call_update`s after it, merged. */
export interface CallState {
  readonly id: string;
  title: string;
  name?: string;
  kind?: acp.ToolKind;
  status?: acp.ToolCallStatus;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: readonly acp.ToolCallContent[];
  locations?: readonly acp.ToolCallLocation[];
}

/** Folds a `tool_call` or `tool_call_update` into what is known of the call. */
export function mergeCall(known: CallState | undefined, update: acp.ToolCall | acp.ToolCallUpdate): CallState {
  const state: CallState = known ?? { id: update.toolCallId, title: update.title ?? "Tool call" };
  if (update.title !== undefined && update.title !== null) state.title = update.title;
  if (update.name !== undefined && update.name !== null) state.name = update.name;
  if (update.kind !== undefined && update.kind !== null) state.kind = update.kind;
  if (update.status !== undefined && update.status !== null) state.status = update.status;
  if (update.rawInput !== undefined) state.rawInput = update.rawInput;
  if ("rawOutput" in update && update.rawOutput !== undefined) state.rawOutput = update.rawOutput;
  if (update.content !== undefined && update.content !== null) state.content = update.content;
  if (update.locations !== undefined && update.locations !== null) state.locations = update.locations;
  return state;
}

/** The call as the log records it: the agent's name for it (else its kind), and its title first, so views summarize it by that. */
export function callOf(state: CallState): { readonly name: string; readonly arguments: Record<string, unknown> } {
  const input = state.rawInput === undefined ? {} : isRecord(state.rawInput) ? state.rawInput : { input: state.rawInput };
  const path = state.locations?.[0]?.path;
  return {
    name: state.name ?? state.kind ?? "tool",
    arguments: { title: state.title, ...input, ...(path === undefined || "path" in input ? {} : { path }) },
  };
}

const blockText = (block: acp.ContentBlock): TextContent | ImageContent | undefined => {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "image":
      return { type: "image", data: block.data, mimeType: block.mimeType };
    case "resource_link":
      return { type: "text", text: `[${block.title ?? block.name}](${block.uri})` };
    case "resource":
      return "text" in block.resource ? { type: "text", text: block.resource.text } : { type: "text", text: `[${block.resource.uri}]` };
    case "audio":
      return { type: "text", text: "[audio]" };
  }
};

/** A finished call's result: its text and images, a diff for an edit (in `details`, for views), or its raw output. */
export function resultOf(state: CallState): RecordedResult {
  const content: (TextContent | ImageContent)[] = [];
  const patches: string[] = [];
  for (const item of state.content ?? []) {
    if (item.type === "content") {
      const block = blockText(item.content);
      if (block !== undefined) content.push(block);
    } else if (item.type === "diff") {
      const { patch } = unifiedPatch(item.path, item.oldText ?? "", item.newText);
      if (patch !== "") patches.push(patch);
      content.push({ type: "text", text: `${item.oldText === undefined || item.oldText === null ? "Wrote" : "Edited"} ${item.path}` });
    } else {
      content.push({ type: "text", text: `[terminal ${item.terminalId}]` });
    }
  }
  if (content.length === 0 && state.rawOutput !== undefined) {
    const raw = typeof state.rawOutput === "string" ? state.rawOutput : JSON.stringify(state.rawOutput, null, 2);
    content.push({
      type: "text",
      text: raw.length > RAW_OUTPUT_CHARS ? `${raw.slice(0, RAW_OUTPUT_CHARS)}… [${raw.length - RAW_OUTPUT_CHARS} more characters]` : raw,
    });
  }
  const failed = state.status === "failed";
  if (content.length === 0) content.push({ type: "text", text: failed ? "Failed" : "Done" });
  const details = {
    ...(patches.length === 0 ? {} : { diff: patches.join("\n") }),
    ...(state.kind === undefined ? {} : { kind: state.kind }),
    ...(state.locations === undefined || state.locations.length === 0 ? {} : { locations: state.locations.map((location) => location.path) }),
  };
  return { content, isError: failed, ...(Object.keys(details).length === 0 ? {} : { details }) };
}

/** A prompt in ACP's blocks: images only when the agent takes them; otherwise a note says one was left out. */
export function promptBlocks(content: PromptContent, images: boolean): acp.ContentBlock[] {
  return content.map((part): acp.ContentBlock => {
    if (part.type === "text") return { type: "text", text: part.text };
    return images
      ? { type: "image", data: part.data, mimeType: part.mimeType }
      : { type: "text", text: "[An image was attached here; this agent does not take images.]" };
  });
}

/** Token counts an agent reports for a turn. ACP has no per-token prices, so cost comes from `costDelta`. */
export function usageOf(usage: acp.Usage | null | undefined, cost = 0): Usage {
  if (usage === undefined || usage === null) return cost === 0 ? emptyUsage : { ...emptyUsage, cost: { ...emptyUsage.cost, total: cost } };
  return {
    input: usage.inputTokens,
    output: usage.outputTokens,
    cacheRead: usage.cachedReadTokens ?? 0,
    cacheWrite: usage.cachedWriteTokens ?? 0,
    ...(usage.thoughtTokens === undefined || usage.thoughtTokens === null ? {} : { reasoning: usage.thoughtTokens }),
    totalTokens: usage.totalTokens,
    cost: { ...emptyUsage.cost, total: cost },
  };
}
