import { emptyUsage } from "@lemma/contracts";
import type { AgentView, AssistantMessage, ModelInfo, StreamEvent } from "@lemma/contracts";
import type { LiveFile } from "./state.ts";

/** Output kept per running tool: its tail, enough for a view and for telling the model where an interrupted call got to. */
const OUTPUT_TAIL_CHARS = 16 * 1024;

type Block = AssistantMessage["content"][number];

/** An assistant message made of what a call produced, for an `attempt` logged when the call did not finish. */
export const partialMessage = (
  content: readonly Block[],
  model: ModelInfo,
  stopReason: "aborted" | "error",
  errorMessage: string,
  timestamp: number,
): AssistantMessage => ({
  role: "assistant",
  content: [...content],
  api: model.api,
  provider: model.provider,
  model: model.id,
  usage: emptyUsage,
  stopReason,
  errorMessage,
  timestamp,
});

/** Rebuilds what a stream produced so far: text, thinking, and finished tool calls. */
export class PartialMessage {
  private readonly blocks: (Block | undefined)[] = [];

  constructor(content: readonly Block[] = []) {
    this.blocks.push(...content);
  }

  apply(event: StreamEvent): void {
    if (event.type === "text-delta") {
      const block = this.blocks[event.index];
      this.blocks[event.index] = block?.type === "text" ? { ...block, text: block.text + event.delta } : { type: "text", text: event.delta };
    } else if (event.type === "thinking-delta") {
      const block = this.blocks[event.index];
      this.blocks[event.index] =
        block?.type === "thinking" ? { ...block, thinking: block.thinking + event.delta } : { type: "thinking", thinking: event.delta };
    } else if (event.type === "toolcall-start") {
      // Held from its start, arguments still to come, so the blocks after it keep their stream index.
      this.blocks[event.index] = { type: "toolCall", id: event.id, name: event.name, arguments: {} };
    } else if (event.type === "toolcall-end") {
      this.blocks[event.index] = event.toolCall;
    }
  }

  content(): Block[] {
    return this.blocks.filter((block) => block !== undefined);
  }

  /** The blocks with their index in the stream: a block that has had no delta yet leaves a gap. */
  indexed(): { index: number; block: Block }[] {
    return this.blocks.flatMap((block, index) => (block === undefined ? [] : [{ index, block }]));
  }

  message(model: ModelInfo, stopReason: "aborted" | "error", errorMessage: string, timestamp: number): AssistantMessage {
    return partialMessage(this.content(), model, stopReason, errorMessage, timestamp);
  }
}

/**
 * A running turn's output that the log does not have yet: the model call in
 * flight and running tools' output. Clients read it to show a turn they join
 * midway (`Agent.view`); it is written beside the log so a turn resumed after
 * a crash knows what the cut-off calls had produced. `dirty` says it changed
 * since it was last written.
 */
export class LiveTurn {
  step: { readonly stepId: string; readonly startedAt: number; seq: number; readonly partial: PartialMessage } | undefined;
  readonly output = new Map<string, { tail: string; length: number }>();
  /** Tools whose result is logged: output arriving for them late (events are queued) is not theirs to show. */
  private readonly finished = new Set<string>();
  dirty = false;
  readonly turnId: string;

  constructor(turnId: string) {
    this.turnId = turnId;
  }

  startStep(stepId: string, startedAt: number): PartialMessage {
    const partial = new PartialMessage();
    this.step = { stepId, startedAt, seq: 0, partial };
    this.dirty = true;
    return partial;
  }

  /** Applies a stream event of the step in flight; returns its number in the step, from 1. */
  apply(event: StreamEvent): number {
    const step = this.step;
    if (step === undefined) return 0;
    step.partial.apply(event);
    step.seq++;
    this.dirty = true;
    return step.seq;
  }

  /** The call's message or attempt is logged. */
  endStep(): void {
    this.step = undefined;
    this.dirty = true;
  }

  /** A running tool printed `chunk`, after `offset` characters in all; out-of-order or repeated chunks are placed by offset. */
  toolOutput(toolCallId: string, chunk: string, offset: number): void {
    if (this.finished.has(toolCallId)) return;
    const current = this.output.get(toolCallId) ?? { tail: "", length: 0 };
    const end = offset + chunk.length;
    if (end <= current.length) return;
    const fresh = offset >= current.length ? chunk : chunk.slice(current.length - offset);
    const tail = current.tail + fresh;
    this.output.set(toolCallId, { tail: tail.length > OUTPUT_TAIL_CHARS ? tail.slice(-OUTPUT_TAIL_CHARS) : tail, length: end });
    this.dirty = true;
  }

  /** The tool's result is logged. */
  toolEnded(toolCallId: string): void {
    this.finished.add(toolCallId);
    if (this.output.delete(toolCallId)) this.dirty = true;
  }

  file(): LiveFile {
    return {
      turnId: this.turnId,
      ...(this.step === undefined ? {} : { step: { stepId: this.step.stepId, startedAt: this.step.startedAt, content: this.step.partial.content() } }),
      output: [...this.output].map(([toolCallId, { tail, length }]) => ({ toolCallId, output: tail, length })),
    };
  }

  view(): Omit<AgentView, "queue" | "queueRevision"> {
    return {
      turnId: this.turnId,
      ...(this.step === undefined ? {} : { draft: { stepId: this.step.stepId, seq: this.step.seq, blocks: this.step.partial.indexed() } }),
      output: [...this.output].map(([toolCallId, { tail, length }]) => ({ toolCallId, output: tail, length })),
    };
  }
}
