import { modelView } from "./derive.ts";
import { NATIVE_HARNESS } from "./harness.ts";
import type { Message } from "./llm.ts";
import type { SessionEvent } from "./sessions.ts";

/*
 * When a session moves to another harness, the new one has not seen the
 * conversation: another agent keeps its own context, and the native loop
 * cannot send another agent's tool calls to a model as its own. A handoff
 * gives it the conversation as text instead: lossy, but readable by any of
 * them. These are the pure parts every harness shares.
 */

/** Characters of conversation a handoff carries by default, newest kept. */
export const HANDOFF_CHARS = 36_000;
/** Characters of one tool call's arguments, or one tool result, a transcript keeps. */
const TOOL_CHARS = 2_000;

/** The harness of each turn on the branch, by turn id; `NATIVE_HARNESS` for a `turn-start` that names none. */
export function turnHarnesses(branch: readonly SessionEvent[]): Map<string, string> {
  const harnesses = new Map<string, string>();
  for (const event of branch) {
    if (event.data.type === "turn-start") harnesses.set(event.data.turnId, event.data.harness ?? NATIVE_HARNESS);
  }
  return harnesses;
}

/** The harness that ran the branch's last turn; undefined before its first. */
export function lastHarness(branch: readonly SessionEvent[]): string | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    const data = branch[i]!.data;
    if (data.type === "turn-start") return data.harness ?? NATIVE_HARNESS;
  }
  return undefined;
}

/** Whether the model's view of the branch holds messages a harness other than `harness` logged. */
export function viewHasOtherHarness(branch: readonly SessionEvent[], harness: string): boolean {
  const harnesses = turnHarnesses(branch);
  const { start } = modelView(branch);
  return branch.slice(start).some((event) => {
    const data = event.data;
    if (data.type !== "message" || data.turnId === undefined) return false;
    return (harnesses.get(data.turnId) ?? NATIVE_HARNESS) !== harness;
  });
}

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max)}… [${text.length - max} more characters]`);

const block = (message: Message): string => {
  switch (message.role) {
    case "user":
      return `<user>\n${message.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("\n")}\n</user>`;
    case "assistant": {
      const parts = message.content.flatMap((part) => {
        if (part.type === "text") return part.text === "" ? [] : [part.text];
        if (part.type === "toolCall") return [`[called ${part.name} ${clip(JSON.stringify(part.arguments), TOOL_CHARS)}]`];
        return [];
      });
      return parts.length === 0 ? "" : `<assistant>\n${parts.join("\n")}\n</assistant>`;
    }
    case "toolResult": {
      const text = message.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("\n");
      return `<tool_result name="${message.toolName}"${message.isError ? ' error="true"' : ""}>\n${clip(text, TOOL_CHARS)}\n</tool_result>`;
    }
  }
};

/**
 * The conversation as text a model of any harness can read: one tagged block
 * per message, thinking left out, long tool input and output cut. When it is
 * longer than `maxChars`, the oldest blocks go first.
 */
export function transcript(messages: readonly Message[], maxChars: number = HANDOFF_CHARS): string {
  const blocks = messages.map(block).filter((text) => text !== "");
  const kept: string[] = [];
  let length = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const text = blocks[i]!;
    if (length + text.length > maxChars && kept.length > 0) {
      kept.unshift(`[${i + 1} earlier ${i === 0 ? "message" : "messages"} left out]`);
      break;
    }
    kept.unshift(text.length > maxChars ? clip(text, maxChars) : text);
    length += text.length + 2;
  }
  return kept.join("\n\n");
}
