import { Context, Schema } from "effect";
import type { Effect, Stream } from "effect";

/**
 * A span the host kept (`@lemma/core`'s `SpanRecord`), as a trace's readers get it: what ran, under what, for which
 * plugin, and how long it took. Its attributes are the kernel's (`plugin.id`, `hook.name`, a hook's summary as
 * `hook.in.*`) and what the work around it marked every span with (a session, a turn).
 */
export const SpanRecord = Schema.Struct({
  id: Schema.String,
  parentId: Schema.optional(Schema.String),
  traceId: Schema.String,
  name: Schema.String,
  /** Epoch milliseconds, fractional. */
  start: Schema.Number,
  ms: Schema.Number,
  status: Schema.Literals(["ok", "error", "interrupted"]),
  /** What failed, in a line. */
  error: Schema.optional(Schema.String),
  attributes: Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number, Schema.Boolean])),
});
export type SpanRecord = typeof SpanRecord.Type;

/** A change to the running composition: what it started, stopped, and restarted, or why it was refused. */
export const CompositionChange = Schema.Struct({
  /** Epoch milliseconds. */
  at: Schema.Number,
  /** What made it: the first `start`, a `reload` (a config or plugin file changed, or one was asked for), a `configure` (rows written), or a `restart`. */
  cause: Schema.Literals(["start", "reload", "configure", "restart"]),
  /** The plugins it named: a restart's plugin, a configure's rows. */
  subjects: Schema.optional(Schema.Array(Schema.String)),
  started: Schema.Array(Schema.String),
  stopped: Schema.Array(Schema.String),
  restarted: Schema.Array(Schema.String),
  /** Left failed or halted by it. */
  failed: Schema.Array(Schema.String),
  /** Why it was refused; it changed nothing. */
  refused: Schema.optional(Schema.String),
});
export type CompositionChange = typeof CompositionChange.Type;

/**
 * What the host keeps of its own running, for a devtools to read: the spans its work ends (the last few thousand, in
 * memory), and the composition's recent changes. The host provides it; no plugin does. Nothing in it leaves the host
 * unless a plugin serves it.
 */
export class Trace extends Context.Service<
  Trace,
  {
    /** The spans kept, in the order they ended. */
    readonly spans: Effect.Effect<readonly SpanRecord[]>;
    /** The spans that end from now on, in batches. */
    readonly ended: Stream.Stream<readonly SpanRecord[]>;
    /** The composition's changes, newest first. */
    readonly changes: Effect.Effect<readonly CompositionChange[]>;
  }
>()("lemma/Trace") {}
