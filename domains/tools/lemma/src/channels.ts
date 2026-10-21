import { Effect, Schema, SchemaAST, Stream } from "effect";
import type { Context } from "effect";
import type { Registries } from "@lemma/core";
import { elementsOf, HostError, InteractionError, resultOf, wireCodec, withChannel, withdrawnFrom } from "@lemma/contracts";
import type { Channel, ChannelCall, ChannelDeclaration, ChannelStream, Interaction } from "@lemma/contracts";
import { ToolResult } from "@lemma/tools";
import type { Tool, ToolContext } from "@lemma/tools";
import { boundOutput } from "@lemma/tools/files";
import { toolName } from "./policy.ts";

type Reader = Context.Service.Shape<typeof Registries>;
type Asker = Context.Service.Shape<typeof Interaction>;

/** The namespace every tool of this plugin is in. */
export const NAMESPACE = "lemma";

/** Elements a stream's tool collects without a `take`, and at most. */
const DEFAULT_TAKE = 1;
const MAX_TAKE = 1_000;
/** How long a stream's tool waits for them without a `timeoutMs`, and at most. */
const DEFAULT_STREAM_MS = 10_000;
const MAX_STREAM_MS = 600_000;
/** The most of a payload a confirmation shows. */
const PREVIEW_CHARS = 600;

/** The first contribution per id: the one that answers for it. */
export const answering = <C extends { readonly item: Channel }>(items: readonly C[]): C[] => {
  const seen = new Set<string>();
  return items.filter(({ item }) => !seen.has(item.id) && Boolean(seen.add(item.id)));
};

/**
 * How a tool's input carries a channel's payload, as its JSON: the input is the payload when that is an object (or an
 * object a client may leave out, `optionalPayload`), nothing when the channel takes none, and `{ payload }` otherwise,
 * since a tool's input is an object.
 */
interface PayloadShape {
  /** The tool's input: the payload's JSON form, as an object. */
  readonly input: Json;
  /** The payload's JSON from the decoded input. */
  readonly payload: (input: Record<string, unknown>) => unknown;
  /** The payload's JSON form, for a stream's input: none when the channel takes no payload. */
  readonly field?: Json;
}

/** A schema of JSON, as decoded and as encoded alike: what a tool's input is made of here. */
type Json = Schema.Codec<unknown>;
const jsonOf = (ast: SchemaAST.AST): Json => Schema.make<Json>(ast);

const encodedOf = (schema: Schema.Top): SchemaAST.AST => Schema.toEncoded(wireCodec(schema)).ast;

const isNothing = (ast: SchemaAST.AST) => SchemaAST.isNull(ast) || SchemaAST.isUndefined(ast) || SchemaAST.isVoid(ast);

export const payloadShape = (payload: Schema.Top): PayloadShape => {
  const ast = encodedOf(payload);
  if (isNothing(ast)) return { input: Schema.Struct({}) as unknown as Json, payload: () => null };
  if (SchemaAST.isObjects(ast)) {
    const object = jsonOf(ast);
    return { input: object, payload: (input) => input, field: object };
  }
  if (SchemaAST.isUnion(ast)) {
    const objects = ast.types.filter(SchemaAST.isObjects);
    if (objects.length === 1 && ast.types.every((member) => SchemaAST.isObjects(member) || isNothing(member))) {
      const object = jsonOf(objects[0]!);
      return { input: object, payload: (input) => input, field: object };
    }
  }
  const field = jsonOf(ast);
  return { input: Schema.Struct({ payload: field }) as unknown as Json, payload: (input) => input["payload"], field };
};

/**
 * Throws when a channel's schema holds a declared type with no JSON codec (`Schema.declare` of a `Map`, say): its JSON
 * form renders as "anything", yet no JSON decodes to it, so every call would fail. Effect's own declared types (`Date`,
 * `Json`, a `Class`) carry one, as a plugin's may.
 */
const jsonable = (schema: Schema.Top): void => {
  const seen = new Set<object>();
  const visit = (node: unknown): void => {
    if (typeof node !== "object" || node === null || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) return node.forEach(visit);
    const ast = node as { readonly _tag?: unknown; readonly annotations?: Record<string, unknown>; readonly thunk?: () => unknown };
    if (ast._tag === "Declaration") {
      if (ast.annotations?.["toCodecJson"] === undefined) throw new Error("it declares a type with no JSON codec");
      return;
    }
    if (ast._tag === "Suspend" && typeof ast.thunk === "function") return visit(ast.thunk());
    for (const [key, value] of Object.entries(node)) if (key !== "annotations" && key !== "context") visit(value);
  };
  visit(schema.ast);
};

const errorResult = (text: string, structured?: unknown) =>
  new ToolResult({ content: [{ type: "text", text }], isError: true, ...(structured === undefined ? {} : { structured }) });

const reasonOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/** What a failed call says to the model: the channel, the code, and what to do about it. */
export const failure = (id: string, error: unknown): string => {
  if (error instanceof HostError) {
    const hint =
      error.code === "NotFound" && error.subject === id
        ? " Its plugin may be off; find what is there with searchTools('lemma')."
        : error.code === "Withdrawn"
          ? " Call again once its plugin is back."
          : "";
    return `"${id}" failed (${error.code}): ${sentence(error.message)}${hint}`;
  }
  const tagged = error as { readonly _tag?: unknown; readonly reason?: unknown; readonly message?: unknown } | null;
  if (typeof tagged === "object" && tagged !== null && typeof tagged._tag === "string") {
    const code = typeof tagged.reason === "string" ? tagged.reason : tagged._tag;
    return `"${id}" failed (${code}): ${sentence(typeof tagged.message === "string" ? tagged.message : code)}`;
  }
  return `"${id}" failed: ${sentence(reasonOf(error))}`;
};

/** A message ending as a sentence does, so a hint after it reads as one of its own. */
const sentence = (text: string): string => (/[.!?)]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

/**
 * Whether a call failed with `code`: as the transport says it (`HostError`'s code), or as a domain does when its channel
 * is called in the host (`SessionError`'s reason, `NotFound` or `Busy`).
 */
export const isCode =
  (code: string) =>
  (error: unknown): boolean => {
    if (error instanceof HostError) return error.code === code;
    return typeof error === "object" && error !== null && (error as { readonly reason?: unknown }).reason === code;
  };

const invalid = (id: string, cause: unknown) =>
  new HostError({ code: "InvalidPayload", subject: id, message: `Invalid payload for "${id}": ${reasonOf(cause)}` });

const decodePayload = (channel: Channel, json: unknown) =>
  Schema.decodeUnknownEffect(wireCodec(channel.payload))(json).pipe(Effect.mapError((cause) => invalid(channel.id, cause)));

const encodeValue = (channel: Channel, value: unknown) =>
  Schema.encodeUnknownEffect(wireCodec(channel.success))(value).pipe(
    Effect.mapError(
      (cause) => new HostError({ code: "Failed", subject: channel.id, message: `"${channel.id}" answered what its schema cannot send: ${reasonOf(cause)}` }),
    ),
  );

/**
 * Makes the call `id` names with a payload's JSON, as the transport serves a client's: with what answers for it now,
 * within its plugin's lifetime, made again on a replacement when it is `repeatable` (`withChannel`). Resolves to its
 * result's JSON.
 */
export const callJson = (registries: Reader, id: string, json: unknown): Effect.Effect<unknown, unknown> =>
  withChannel(registries, id, "call", ({ item }, left) =>
    Effect.flatMap(decodePayload(item, json), (payload) =>
      Effect.flatMap(resultOf(item, payload, { left, withdrawn: withdrawnFrom(id, "call") }), (value) => encodeValue(item, value)),
    ),
  );

/** The call a declaration names, with values, as `callJson` makes it with JSON: for what this plugin itself calls. */
export const callValue = <Payload, Success>(
  registries: Reader,
  declaration: ChannelDeclaration<"call", Payload, Success>,
  payload: Payload,
): Effect.Effect<Success, unknown> =>
  withChannel(registries, declaration.id, "call", ({ item }, left) =>
    resultOf(item, payload, { left, withdrawn: withdrawnFrom(declaration.id, "call") }),
  ) as Effect.Effect<Success, unknown>;

/** Reads a stream's elements as JSON until `take` have come, it ends, or `timeoutMs` passes; withdrawn when its plugin leaves. */
export const collectJson = (
  registries: Reader,
  id: string,
  json: unknown,
  take: number,
  timeoutMs: number,
): Effect.Effect<{ readonly elements: readonly unknown[]; readonly ended: boolean; readonly timedOut: boolean }, unknown> =>
  withChannel(registries, id, "stream", ({ item }, left) =>
    Effect.gen(function* () {
      const payload = yield* decodePayload(item, json);
      const elements: unknown[] = [];
      const read = Stream.runForEach(Stream.take(elementsOf(item as ChannelStream, payload), take), (element) =>
        Effect.map(encodeValue(item, element), (encoded) => void elements.push(encoded)),
      );
      const timedOut = yield* Effect.raceFirst(
        Effect.as(read, false),
        Effect.raceFirst(Effect.as(Effect.sleep(timeoutMs), true), Effect.andThen(left, Effect.fail(withdrawnFrom(id, "stream")))),
      );
      return { elements, ended: !timedOut && elements.length < take, timedOut };
    }),
  );

const preview = (json: unknown): string => {
  const text = JSON.stringify(json, null, 2) ?? "null";
  return text.length <= PREVIEW_CHARS ? text : `${text.slice(0, PREVIEW_CHARS)}…`;
};

/**
 * Asks the person whether the agent may make a call that changes something: `undefined` when they allowed it, else
 * why not, which the model reads.
 */
export const permission = (interaction: Asker, title: string, json: unknown): Effect.Effect<string | undefined> =>
  interaction.confirm(title, json === null ? undefined : preview(json)).pipe(
    Effect.map((allowed) => (allowed ? undefined : "The person declined it.")),
    Effect.catch((error: InteractionError) =>
      Effect.succeed(error.reason === "Dismissed" ? "The person dismissed the question." : `Nobody could approve it (${error.message}).`),
    ),
  );

/** A result for the model and for scripts: the JSON as bounded text, and whole as `structured`. */
export const jsonResult = (json: unknown, context: ToolContext, budget: number, details: Record<string, unknown>): Effect.Effect<ToolResult> =>
  Effect.promise(async () => {
    const text = JSON.stringify(json, null, 2) ?? "null";
    const { content, fullOutputPath } = await boundOutput([{ type: "text", text }], { budget, maxResultChars: context.maxResultChars, name: "lemma" });
    return new ToolResult({ content: [...content], structured: json, details: { ...details, ...(fullOutputPath === undefined ? {} : { fullOutputPath }) } });
  });

export interface ChannelToolOptions {
  readonly registries: Reader;
  readonly interaction: Asker;
  /** Ask the person before each call. */
  readonly confirm: boolean;
  /** Text characters of a result the model reads. */
  readonly budget: number;
}

const summaryOf = (channel: Channel) => {
  const words = [channel.title, channel.description].filter((part) => part !== undefined && part !== "").join(": ");
  return words === "" ? `Lemma's "${channel.id}" channel` : words;
};

/**
 * The tool a call channel becomes: its input the payload's JSON, its result the result's JSON (`structured`, and as
 * text), in the `lemma` namespace, called from scripts. A `confirm` one asks the person first.
 */
const callTool = (channel: ChannelCall, options: ChannelToolOptions): Tool => {
  jsonable(channel.payload);
  jsonable(channel.success);
  const shape = payloadShape(channel.payload);
  const output = Schema.toEncoded(wireCodec(channel.success));
  const id = channel.id;
  return {
    name: toolName(id),
    description: `${summaryOf(channel)}. Lemma's "${id}" channel${options.confirm ? "; each call asks the person first, and rejects if they decline" : ""}.`,
    input: shape.input,
    output,
    nested: true,
    namespace: NAMESPACE,
    // A repeatable call has the same effect made twice: one cut off by a restart is made again.
    ...(channel.repeatable === true && !options.confirm ? { replay: "safe" as const } : {}),
    execute: (input, context) =>
      Effect.gen(function* () {
        const json = shape.payload(input as Record<string, unknown>);
        if (options.confirm) {
          const refused = yield* permission(options.interaction, `Let the agent ${(channel.title ?? id).toLowerCase()} (${id})?`, json);
          if (refused !== undefined) return errorResult(`"${id}" was not called: ${refused}`);
        }
        const result = yield* callJson(options.registries, id, json);
        return yield* jsonResult(result, context, options.budget, { channel: id });
      }).pipe(Effect.catch((error) => Effect.succeed(errorResult(failure(id, error))))),
  };
};

/** What a stream's tool takes. */
interface StreamInput {
  readonly payload?: unknown;
  readonly take?: number;
  readonly timeoutMs?: number;
}

/**
 * The tool a stream channel becomes: it opens the stream with the payload's JSON and collects elements until `take`
 * have come, the stream ends, or `timeoutMs` passes, resolving to `{ elements, ended, timedOut }`.
 */
const streamTool = (channel: ChannelStream, options: ChannelToolOptions): Tool => {
  jsonable(channel.payload);
  jsonable(channel.success);
  const shape = payloadShape(channel.payload);
  const element = Schema.toEncoded(wireCodec(channel.success));
  const limits = {
    take: Schema.optional(
      Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: MAX_TAKE })).annotate({
        description: `Elements to collect before closing the stream (default ${DEFAULT_TAKE}, at most ${MAX_TAKE})`,
      }),
    ),
    timeoutMs: Schema.optional(
      Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: MAX_STREAM_MS })).annotate({
        description: `How long to wait for them, in milliseconds (default ${DEFAULT_STREAM_MS}, at most ${MAX_STREAM_MS})`,
      }),
    ),
  };
  const input: Json =
    shape.field === undefined
      ? Schema.Struct(limits)
      : Schema.Struct({ payload: Schema.optional(shape.field).annotate({ description: "The stream's payload, as its JSON" }), ...limits });
  const output = Schema.Struct({
    elements: Schema.Array(element),
    /** The stream ended before `take` elements came. */
    ended: Schema.Boolean,
    /** `timeoutMs` passed before `take` elements came. */
    timedOut: Schema.Boolean,
  });
  const id = channel.id;
  return {
    name: toolName(id),
    description: `${summaryOf(channel)}. Lemma's "${id}" stream: collects elements until \`take\` have come (default ${DEFAULT_TAKE}), it ends, or \`timeoutMs\` passes${
      options.confirm ? "; each call asks the person first, and rejects if they decline" : ""
    }.`,
    input,
    output,
    nested: true,
    namespace: NAMESPACE,
    execute: (raw, context) =>
      Effect.gen(function* () {
        const given = raw as StreamInput;
        const json = shape.field === undefined ? null : given.payload === undefined ? (shape.input === shape.field ? {} : undefined) : given.payload;
        if (options.confirm) {
          const refused = yield* permission(options.interaction, `Let the agent open ${(channel.title ?? id).toLowerCase()} (${id})?`, json ?? null);
          if (refused !== undefined) return errorResult(`"${id}" was not opened: ${refused}`);
        }
        const collected = yield* collectJson(options.registries, id, json, given.take ?? DEFAULT_TAKE, given.timeoutMs ?? DEFAULT_STREAM_MS);
        return yield* jsonResult(collected, context, options.budget, { channel: id });
      }).pipe(Effect.catch((error) => Effect.succeed(errorResult(failure(id, error))))),
  };
};

/** The tool `channel` becomes. Throws for one whose schemas hold a type no JSON decodes to (`jsonable`). */
export const channelTool = (channel: Channel, options: ChannelToolOptions): Tool =>
  channel.kind === "call" ? callTool(channel, options) : streamTool(channel, options);
