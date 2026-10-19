import { emptyUsage } from "@lemma/llm";
import type { AssistantMessage, LlmFailure, StreamEvent, ToolCall, Usage } from "@lemma/llm";
import { classifyFailure } from "./failure.ts";
import type { Model } from "./model.ts";

type Text = { type: "text"; text: string; textSignature?: string };
type Thinking = { type: "thinking"; thinking: string; thinkingSignature?: string; redacted?: boolean };
type Call = { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown>; thoughtSignature?: string; namespace?: string };
/** A block of the answer as it is built; a wire adapter sets what arrives whole (a signature) on it. */
export type Block = Text | Thinking | Call;

/** Token counts as a provider reports them, priced from `model`'s catalog entry. */
export function priced(
  model: Model,
  counts: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly reasoning?: number;
    /** Of `cacheWrite`, the tokens written to Anthropic's hour-long cache, at twice the input's price. */
    readonly cacheWriteHour?: number;
  },
): Usage {
  const hour = Math.min(counts.cacheWriteHour ?? 0, counts.cacheWrite);
  const cost = {
    input: (model.cost.input * counts.input) / 1e6,
    output: (model.cost.output * counts.output) / 1e6,
    cacheRead: (model.cost.cacheRead * counts.cacheRead) / 1e6,
    cacheWrite: (model.cost.cacheWrite * (counts.cacheWrite - hour) + model.cost.input * 2 * hour) / 1e6,
  };
  return {
    input: counts.input,
    output: counts.output,
    cacheRead: counts.cacheRead,
    cacheWrite: counts.cacheWrite,
    ...(counts.reasoning === undefined ? {} : { reasoning: counts.reasoning }),
    totalTokens: counts.input + counts.output + counts.cacheRead + counts.cacheWrite,
    cost: { ...cost, total: cost.input + cost.output + cost.cacheRead + cost.cacheWrite },
  };
}

/**
 * A tool call's arguments from the JSON its model streamed: `{}` for none, and a string a model left a raw control
 * character or a stray backslash in is repaired first.
 */
export function parseArguments(json: string): Record<string, unknown> {
  if (json.trim() === "") return {};
  const object = (value: unknown) => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
  try {
    return object(JSON.parse(json));
  } catch {
    try {
      return object(JSON.parse(repairJson(json)));
    } catch {
      return {};
    }
  }
}

const ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);

/** Escapes raw control characters inside JSON strings and doubles a backslash before what is no escape. */
function repairJson(json: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < json.length; i++) {
    const char = json[i]!;
    if (!inString) {
      out += char;
      inString = char === '"';
    } else if (char === '"') {
      out += char;
      inString = false;
    } else if (char === "\\") {
      const next = json[i + 1];
      if (next !== undefined && ESCAPES.has(next) && (next !== "u" || /^[0-9a-fA-F]{4}$/.test(json.slice(i + 2, i + 6)))) {
        out += `\\${next}`;
        i++;
      } else out += "\\\\";
    } else {
      const code = char.charCodeAt(0);
      out += code < 0x20 ? `\\u${code.toString(16).padStart(4, "0")}` : char;
    }
  }
  return out;
}

/** What a silent overflow is logged as. */
const SILENT_OVERFLOW = "The request filled the model's context window, leaving no room to answer";

/**
 * One answer as it streams: the message it builds, and the `StreamEvent`s it sends as each part arrives. It keeps the
 * protocol whatever the provider does: `start` first, exactly one `done` or `error` last, nothing after it. A wire
 * adapter adds blocks and deltas, and what it builds from several (`settle`); the plugin ends it, when the stream ends
 * or drops, or as it stalls, so the answer holds everything that arrived however it ends.
 */
export class Output {
  readonly model: Model;
  readonly content: Block[] = [];
  usage: Usage = emptyUsage;
  stopReason: AssistantMessage["stopReason"] | undefined;
  /** Why the provider stopped where it said so itself (a refusal, a content filter). */
  errorMessage: string | undefined;
  /** What such a stop is to a caller deciding whether to ask again, where the provider named it (`stopWith`). */
  private stopFailure: LlmFailure | undefined;
  responseId: string | undefined;
  private readonly emit: (events: StreamEvent[]) => void;
  private readonly timestamp = Date.now();
  private readonly buffers = new Map<number, string>();
  private readonly settlers: (() => void)[] = [];
  private started = false;
  private ended = false;

  constructor(model: Model, emit: (events: StreamEvent[]) => void) {
    this.model = model;
    this.emit = emit;
  }

  get finished(): boolean {
    return this.ended;
  }

  private send(events: StreamEvent[]) {
    if (this.ended) return;
    if (!this.started) {
      this.started = true;
      events = [{ type: "start" }, ...events];
    }
    this.emit(events);
  }

  /**
   * The provider ended the answer itself without one, as `message` says: what that is to a caller is `failure`, as
   * `stopFailure` names it for the stop's reason, or else what `classifyFailure` makes of the message.
   */
  stopWith(message: string, failure: LlmFailure | undefined): void {
    this.stopReason = "error";
    this.errorMessage = message;
    this.stopFailure = failure;
  }

  /**
   * What the adapter builds from parts as they arrive (a signature from pieces), written onto the blocks by `write`
   * once, as the answer ends however it does: an answer the provider had finished stays whole when the connection
   * then drops or stalls.
   */
  settle(write: () => void): void {
    this.settlers.push(write);
  }

  private settled(): void {
    for (const write of this.settlers.splice(0)) write();
  }

  /** The answer has begun: the provider accepted the request. */
  start(): void {
    this.send([]);
  }

  addText(): number {
    return this.content.push({ type: "text", text: "" }) - 1;
  }

  text(index: number, delta: string): void {
    const block = this.content[index];
    if (block?.type !== "text" || delta === "") return;
    block.text += delta;
    this.send([{ type: "text-delta", index, delta }]);
  }

  /**
   * A text or thinking block as its provider finally gave it whole: what the deltas lacked goes out as one more. A
   * final form that does not continue them leaves them standing, as the stream told them: a consumer rebuilds the
   * block from its deltas, and must end with the message's.
   */
  complete(index: number, final: string): void {
    const block = this.content[index];
    const current = block?.type === "text" ? block.text : block?.type === "thinking" ? block.thinking : undefined;
    if (current === undefined || final.length <= current.length || !final.startsWith(current)) return;
    if (block?.type === "text") this.text(index, final.slice(current.length));
    else this.thinking(index, final.slice(current.length));
  }

  addThinking(): number {
    return this.content.push({ type: "thinking", thinking: "" }) - 1;
  }

  thinking(index: number, delta: string): void {
    const block = this.content[index];
    if (block?.type !== "thinking" || delta === "") return;
    block.thinking += delta;
    this.send([{ type: "thinking-delta", index, delta }]);
  }

  /** A tool call begun: its arguments stream as JSON until `endToolCall`. */
  addToolCall(id: string, name: string): number {
    const index = this.content.push({ type: "toolCall", id, name, arguments: {} }) - 1;
    this.buffers.set(index, "");
    this.send([{ type: "toolcall-start", index, id, name }]);
    return index;
  }

  toolCall(index: number, delta: string): void {
    const buffer = this.buffers.get(index);
    if (buffer === undefined || delta === "") return;
    this.buffers.set(index, buffer + delta);
    this.send([{ type: "toolcall-delta", index, delta }]);
  }

  /** The JSON streamed for a tool call so far. */
  toolCallJson(index: number): string | undefined {
    return this.buffers.get(index);
  }

  /** Whether a tool call's arguments are still streaming. */
  open(index: number): boolean {
    return this.buffers.has(index);
  }

  /** Ends a tool call, its arguments parsed from what streamed, or `json` when the provider sent them whole. */
  endToolCall(index: number, json?: string): void {
    const block = this.content[index];
    const buffer = this.buffers.get(index);
    if (block?.type !== "toolCall" || buffer === undefined) return;
    if (json !== undefined && json.startsWith(buffer) && json.length > buffer.length) this.toolCall(index, json.slice(buffer.length));
    this.buffers.delete(index);
    block.arguments = parseArguments(json ?? buffer);
    this.send([{ type: "toolcall-end", index, toolCall: toolCall(block) }]);
  }

  private message(stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage {
    return {
      role: "assistant",
      content: this.content.map((block) => (block.type === "toolCall" ? toolCall(block) : { ...block })),
      api: this.model.api,
      provider: this.model.provider,
      model: this.model.id,
      ...(this.responseId === undefined ? {} : { responseId: this.responseId }),
      usage: this.usage,
      stopReason,
      ...(errorMessage === undefined ? {} : { errorMessage }),
      timestamp: this.timestamp,
    };
  }

  /**
   * Ends the answer as the provider finished it: tool calls still streaming end with what arrived, an answer that
   * stopped with tool calls stopped for them, and a stop the provider called an error fails it. Cut off at its limit
   * having said nothing, its input filling the context window, it is an overflow: some providers cut a request too long
   * to fit instead of refusing it.
   */
  finish(): void {
    if (this.ended) return;
    this.settled();
    for (const index of this.buffers.keys()) this.endToolCall(index);
    if (this.stopReason === "stop" && this.content.some((block) => block.type === "toolCall")) this.stopReason = "toolUse";
    const stopReason = this.stopReason;
    if (stopReason === undefined) return this.end(new Error("The provider ended the response without a stop reason"), { kind: "transient" });
    if (stopReason === "error" || stopReason === "aborted") {
      return this.end(new Error(this.errorMessage ?? "The provider ended the response with an error"), this.stopFailure);
    }
    const filled = this.usage.input + this.usage.cacheRead + this.usage.cacheWrite >= this.model.contextWindow * 0.99;
    if (stopReason === "length" && this.usage.output === 0 && filled) {
      this.send([{ type: "error", message: this.message("error", SILENT_OVERFLOW), failure: { kind: "overflow" } }]);
    } else this.send([{ type: "done", message: this.message(stopReason) }]);
    this.ended = true;
  }

  /**
   * Ends the answer as failed, with what it produced. Aborted (the caller stopped it) it is `aborted`, unclassified;
   * otherwise `failure`, or what `classifyFailure` makes of the error. An answer whose provider had already said how it
   * ends (its stop, or a failure it named) ends so: the connection dropping, or stalling, after the provider's last word
   * changes nothing it said.
   */
  fail(error: unknown, failure?: LlmFailure, aborted = false): void {
    if (this.ended) return;
    if (!aborted && this.stopReason !== undefined) return this.finish();
    this.end(error, failure, aborted);
  }

  private end(error: unknown, failure: LlmFailure | undefined, aborted = false): void {
    if (this.ended) return;
    this.settled();
    for (const [index, buffer] of this.buffers) {
      const block = this.content[index];
      if (block?.type === "toolCall") block.arguments = parseArguments(buffer);
    }
    this.buffers.clear();
    const message = error instanceof Error ? error.message : String(error);
    if (aborted) this.send([{ type: "error", message: this.message("aborted", message) }]);
    else this.send([{ type: "error", message: this.message("error", message), failure: failure ?? classifyFailure(error, message) }]);
    this.ended = true;
  }
}

function toolCall(block: Call): ToolCall {
  return {
    type: "toolCall",
    id: block.id,
    name: block.name,
    arguments: block.arguments,
    ...(block.thoughtSignature === undefined ? {} : { thoughtSignature: block.thoughtSignature }),
    ...(block.namespace === undefined ? {} : { namespace: block.namespace }),
  };
}
