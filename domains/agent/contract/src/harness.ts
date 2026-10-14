import { Effect, Schema, Stream } from "effect";
import { Event, Registry } from "@lemma/core";
import type { Events, Registries } from "@lemma/core";
import type { Context } from "effect";
import { defineChannel, serveChannel } from "@lemma/contracts";
import type { Channel } from "@lemma/contracts";
import type { ImageContent, Message, TextContent, Usage } from "@lemma/llm";
import { modelView } from "@lemma/sessions";
import type { SessionEvent } from "@lemma/sessions";
import type { PromptContent } from "./agent.ts";

/*
 * A harness runs a session's turns: the agent's own loop (`lemma`), or another
 * coding agent (Claude Code, Codex, Gemini CLI) that a plugin drives. The agent
 * owns everything around a turn whichever runs it (the queue, exactly-once
 * submission, cancelling, the log, the live view), so a harness only turns a
 * turn's prompts into what the other agent did, as `HarnessUpdate`s, and the
 * agent logs them as the session's events. Every turn is logged the same way,
 * so clients show any session one way; only the native loop logs `request`
 * events, as another agent keeps its own context.
 */

/** The agent's own loop: a `turn-start` that names no harness ran on it. */
export const NATIVE_HARNESS = "lemma";

/**
 * How much another agent may do without asking, the same few levels whatever the agent: `supervised` asks before
 * commands and file changes; `auto-edits` makes file changes and asks before anything else; `auto` lets the agent
 * decide what is routine, and ask about the rest; `full` asks nothing. A harness says which it offers
 * (`HarnessStatus.access`), and maps each to the agent's own modes, or keeps it by how it answers the agent's requests.
 */
export const Access = Schema.Literals(["supervised", "auto-edits", "auto", "full"]);
export type Access = typeof Access.Type;

/** The levels in order, with how a client names them. */
export const ACCESS_LEVELS: readonly { readonly access: Access; readonly title: string; readonly description: string }[] = [
  { access: "supervised", title: "Supervised", description: "Ask before commands and file changes." },
  { access: "auto-edits", title: "Auto-accept edits", description: "Make file changes, ask before other actions." },
  { access: "auto", title: "Auto", description: "The agent approves routine actions; it asks about the rest." },
  { access: "full", title: "Full access", description: "Allow commands and edits without asking." },
];

/**
 * A harness's mark, drawn in the text's color unless it names its own: vector `paths` in `viewBox`; `mask`, an
 * image's address (a `data:` URL) whose shape is drawn; or `image`, an image's address (`https:` or `data:`) drawn as
 * it is, in its own colors.
 */
export const HarnessLogo = Schema.Union([
  Schema.Struct({
    viewBox: Schema.String,
    paths: Schema.Array(Schema.Struct({ d: Schema.String, evenOdd: Schema.optional(Schema.Boolean) })),
    /** A CSS color: the brand's, where it has one. */
    color: Schema.optional(Schema.String),
  }),
  Schema.Struct({ mask: Schema.String }),
  Schema.Struct({ image: Schema.String }),
]);
export type HarnessLogo = typeof HarnessLogo.Type;

/** A model another agent offers, by its own id for it (`opus`, `gpt-6.1-sol`). */
export const HarnessModel = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
});
export type HarnessModel = typeof HarnessModel.Type;

/** Whether a harness can run turns now: `unavailable` says why in `detail`, and how to fix it. */
export const HarnessStatus = Schema.Struct({
  state: Schema.Literals(["ready", "unavailable"]),
  detail: Schema.optional(Schema.String),
  /** The other agent's version, when it reports one. */
  version: Schema.optional(Schema.String),
  /** The access levels it offers, in order; none: it has no such choice (the agent's own loop). */
  access: Schema.optional(Schema.Array(Access)),
  /** The models it offers, once it has said (the agent's own loop's are `Llm`'s); and the one it uses unless told. */
  models: Schema.optional(Schema.Array(HarnessModel)),
  model: Schema.optional(Schema.String),
});
export type HarnessStatus = typeof HarnessStatus.Type;

/** A harness as clients list it. */
export const HarnessInfo = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  description: Schema.optional(Schema.String),
  /** The plugin that added it. */
  source: Schema.String,
  logo: Schema.optional(HarnessLogo),
  status: HarnessStatus,
});
export type HarnessInfo = typeof HarnessInfo.Type;

/**
 * What a harness reports as its turn runs, in order. The agent logs it in the
 * session's shape: text, thinking, and tool calls make an assistant message;
 * a tool's result is logged after the message that called it, and what comes
 * after a result starts the next message.
 */
export type HarnessUpdate =
  | { readonly type: "text"; readonly delta: string }
  | { readonly type: "thinking"; readonly delta: string }
  /** A tool call began, or its arguments are better known (sent again with the same id; the last one is logged). */
  | { readonly type: "tool-call"; readonly id: string; readonly name: string; readonly arguments: Readonly<Record<string, unknown>> }
  /** A running call's output, shown live and not logged: its result carries what is kept. */
  | { readonly type: "tool-output"; readonly id: string; readonly chunk: string }
  | {
      readonly type: "tool-result";
      readonly id: string;
      readonly content: readonly (TextContent | ImageContent)[];
      readonly isError: boolean;
      /** For the call's view (`ToolViews`), as a tool's result `details` are. */
      readonly details?: unknown;
    }
  /** The model that answers, as the other agent names it: logged on the messages that follow. */
  | { readonly type: "model"; readonly model: string }
  /** What the turn has cost so far, in all. */
  | { readonly type: "usage"; readonly usage: Usage }
  /**
   * What the harness keeps of the session to continue it next turn (the other agent's session id): logged, and
   * handed back as `HarnessTurn.previous.state` while this branch is the one the harness last continued.
   */
  | { readonly type: "state"; readonly data: unknown };

/** One turn, as the agent hands it to a harness. */
export interface HarnessTurn {
  readonly sessionId: string;
  readonly turnId: string;
  readonly cwd: string;
  /** The prompts the turn places, in order: one, or several queued together. */
  readonly prompts: readonly PromptContent[];
  /** The conversation before the turn as a model sees it (`deriveMessages`). */
  readonly history: readonly Message[];
  /**
   * Present when this harness ran an earlier turn on the branch: the `state` it kept then, and the messages logged
   * since (turns other harnesses ran), which it has not seen. A harness that cannot take up its state gives the other
   * agent `history` instead. Absent too when the harness ran a later turn on another branch: what it kept may have
   * moved on with that branch.
   */
  readonly previous?: { readonly state: unknown; readonly since: readonly Message[] };
  /** How much the agent may do without asking (`TurnOptions.access`), when the prompt chose; else the harness's default. */
  readonly access?: Access;
  /** The agent's model for the turn (`TurnOptions.model`, one of `HarnessStatus.models`), when the prompt chose one. */
  readonly model?: string;
  /** Aborted when the turn is cancelled, before the stream is interrupted. */
  readonly signal: AbortSignal;
}

/**
 * Runs turns. `run`'s stream reports the turn as it goes and ends when the turn
 * is done; failing ends it in error, with the failure's message. A cancelled
 * turn's stream is interrupted (after `signal` aborts). A turn a host restart
 * cuts off is not resumed: it closes as failed when the agent starts again.
 * The agent runs a turn within the harness's contribution, so a plugin that is
 * stopping waits for its turns to end.
 */
export interface Harness {
  /** Unique among harnesses, and stable: the log names it on each turn. */
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly logo?: HarnessLogo;
  readonly status: Effect.Effect<HarnessStatus>;
  readonly run: (turn: HarnessTurn) => Stream.Stream<HarnessUpdate, { readonly message: string }>;
}

/** The harnesses a turn may run on, besides the agent's own loop (which its provider adds as `NATIVE_HARNESS`). */
export const Harnesses = Registry.make<Harness>("lemma/agent.harnesses", {
  key: (harness) => harness.id,
  unique: true,
  check: (value) =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as Harness).id === "string" &&
    typeof (value as Harness).title === "string" &&
    Effect.isEffect((value as Harness).status) &&
    typeof (value as Harness).run === "function"
      ? undefined
      : "A harness is { id: string, title: string, status: Effect<HarnessStatus>, run: (turn) => Stream<HarnessUpdate> }",
});

/** A harness's status changed (installed, signed in): its plugin publishes this, and clients list the harnesses again. */
export const HarnessStatusChanged = Event.make<{ readonly id: string }>("lemma/agent.harness.status");

/** The harness that ran the branch's last turn; undefined before its first. */
export function lastHarness(branch: readonly SessionEvent[]): string | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    const data = branch[i]!.data;
    if (data.type === "turn-start") return data.harness ?? NATIVE_HARNESS;
  }
  return undefined;
}

/** The harness of each turn on the branch, by turn id. */
export function turnHarnesses(branch: readonly SessionEvent[]): Map<string, string> {
  const harnesses = new Map<string, string>();
  for (const event of branch) if (event.data.type === "turn-start") harnesses.set(event.data.turnId, event.data.harness ?? NATIVE_HARNESS);
  return harnesses;
}

/** Whether the model's view of the branch holds messages of turns a harness other than `harness` ran. */
export function viewHasOtherHarness(branch: readonly SessionEvent[], harness: string): boolean {
  const harnesses = turnHarnesses(branch);
  const { start } = modelView(branch);
  return branch.slice(start).some((event) => {
    const data = event.data;
    return data.type === "message" && data.turnId !== undefined && (harnesses.get(data.turnId) ?? NATIVE_HARNESS) !== harness;
  });
}

/** Characters of conversation a transcript carries by default, the newest kept. */
export const TRANSCRIPT_CHARS = 36_000;
/** Characters of one tool call's arguments, or one tool result, a transcript keeps. */
const TOOL_CHARS = 2_000;

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
 * The conversation as text any agent can read, for one that has not seen it: a
 * tagged block per message, thinking left out, long tool input and output cut,
 * and the oldest blocks dropped past `maxChars`.
 */
export function transcript(messages: readonly Message[], maxChars: number = TRANSCRIPT_CHARS): string {
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

/** How clients list the harnesses, served by the agent's provider (`serveHarnesses`). */
export const HarnessChannels = {
  list: defineChannel({
    kind: "call",
    id: "agent.harnesses",
    title: "Harnesses",
    description: "The harnesses a turn may run on (the agent's own loop first) and whether each can run turns now",
    payload: Schema.Void,
    success: Schema.Array(HarnessInfo),
    repeatable: true,
  }),
  changes: defineChannel({
    kind: "stream",
    id: "agent.harness-changes",
    title: "Harness changes",
    description: "The harnesses now, then again whenever one is added or removed, or its status changes",
    payload: Schema.Void,
    success: Schema.Array(HarnessInfo),
  }),
};

const STATUS_TIMEOUT = "5 seconds";

/** Every harness with its status now, the native loop first, then by title. A status that fails or hangs is reported. */
export const listHarnesses = (registries: Context.Service.Shape<typeof Registries>): Effect.Effect<readonly HarnessInfo[]> =>
  Effect.flatMap(registries.items(Harnesses), (items) =>
    Effect.forEach(
      items,
      ({ item, pluginId }) =>
        item.status.pipe(
          Effect.timeoutOrElse({
            duration: STATUS_TIMEOUT,
            orElse: () => Effect.succeed<HarnessStatus>({ state: "unavailable", detail: "It did not say whether it is ready." }),
          }),
          Effect.catchCause((cause) => Effect.succeed<HarnessStatus>({ state: "unavailable", detail: String(cause) })),
          Effect.map((status): HarnessInfo => ({
            id: item.id,
            title: item.title,
            ...(item.description === undefined ? {} : { description: item.description }),
            source: pluginId,
            ...(item.logo === undefined ? {} : { logo: item.logo }),
            status,
          })),
        ),
      { concurrency: "unbounded" },
    ).pipe(Effect.map((infos) => [...infos].sort((a, b) => (a.id === NATIVE_HARNESS ? -1 : b.id === NATIVE_HARNESS ? 1 : a.title.localeCompare(b.title))))),
  );

/** `HarnessChannels` served from the registry: what a provider of `Agent` adds to `Channels`. */
export const serveHarnesses = (registries: Context.Service.Shape<typeof Registries>, events: Context.Service.Shape<typeof Events>): readonly Channel[] => [
  serveChannel(HarnessChannels.list, () => listHarnesses(registries)),
  serveChannel(HarnessChannels.changes, () =>
    Stream.merge(
      Stream.map(registries.changes(Harnesses), () => undefined),
      Stream.map(events.stream(HarnessStatusChanged), () => undefined),
    ).pipe(Stream.mapEffect(() => listHarnesses(registries), { concurrency: 1 })),
  ),
];
