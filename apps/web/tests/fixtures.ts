import { emptyUsage } from "@lemma/contracts";
import type { AssistantMessage, EventData, SessionEvent, Usage } from "@lemma/contracts";
import { createProjector } from "../src/model/transcript.ts";

/** A branch's transcript, projected once. */
export const transcriptOf = (events: readonly SessionEvent[]) => createProjector()(events);

/** Builds a linear branch: each event's parent is the previous one. */
export const branch = (...data: EventData[]): SessionEvent[] =>
  data.map((d, i) => ({ seq: i + 1, id: `e${i + 1}`, parent: i === 0 ? null : `e${i}`, at: 1000 + i * 1000, data: d }));

export const usage = (input: number, output: number, total = 0): Usage => ({
  ...emptyUsage,
  input,
  output,
  totalTokens: input + output,
  cost: { ...emptyUsage.cost, total },
});

export const assistant = (content: AssistantMessage["content"], extra: Partial<AssistantMessage> = {}): AssistantMessage => ({
  role: "assistant",
  content,
  api: "test",
  provider: "p",
  model: "m",
  usage: usage(10, 5, 0.01),
  stopReason: "stop",
  timestamp: 0,
  ...extra,
});

export const user = (text: string, turnId?: string): EventData => ({
  type: "message",
  message: { role: "user", content: [{ type: "text", text }], timestamp: 0 },
  ...(turnId === undefined ? {} : { turnId }),
});

export const toolResult = (toolCallId: string, text: string, extra: { isError?: boolean; details?: unknown } = {}): EventData => ({
  type: "message",
  message: { role: "toolResult", toolCallId, toolName: "bash", content: [{ type: "text", text }], isError: extra.isError ?? false, timestamp: 0 },
  ...(extra.details === undefined ? {} : { details: extra.details }),
});
