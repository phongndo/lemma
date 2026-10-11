import { Schema } from "effect";
import { CompositionChange, defineChannel, SpanRecord } from "@lemma/contracts";

/*
 * The devtools domain's host contract: the channels `devtools.trace` serves the host's trace on. The dock and its panels
 * are the web contract, `@lemma/devtools/web`.
 */

/** Which spans: those whose attributes have these values (`{ "session.id": … }`), ended after `since` (epoch ms). */
export const SpanQuery = Schema.Struct({
  where: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  since: Schema.optional(Schema.Number),
  /** At most this many, the newest (2000 when absent). */
  limit: Schema.optional(Schema.Number),
});
export type SpanQuery = typeof SpanQuery.Type;

export const TraceChannels = {
  /** The spans the host kept that match, in the order they ended. */
  spans: defineChannel({
    kind: "call",
    id: "devtools.trace.spans",
    title: "Spans",
    description: "The spans the host kept: what ran, for which plugin, and how long it took",
    payload: SpanQuery,
    success: Schema.Array(SpanRecord),
    repeatable: true,
  }),
  /** The spans that match as they end, in batches (a few a second at most). */
  follow: defineChannel({
    kind: "stream",
    id: "devtools.trace.follow",
    title: "Follow spans",
    description: "Spans as they end, in batches",
    payload: Schema.Struct({ where: Schema.optional(Schema.Record(Schema.String, Schema.String)) }),
    success: Schema.Array(SpanRecord),
  }),
  /** The host composition's recent changes, newest first. */
  changes: defineChannel({
    kind: "call",
    id: "devtools.trace.changes",
    title: "Composition changes",
    description: "What each recent reload, configure, and restart started, stopped, and restarted, or why it was refused",
    payload: Schema.Void,
    success: Schema.Array(CompositionChange),
    repeatable: true,
  }),
} as const;

/** Whether `span` has every attribute `where` names, with its value. */
export const matches = (span: SpanRecord, where: Readonly<Record<string, string>> | undefined): boolean =>
  where === undefined || Object.entries(where).every(([key, value]) => String(span.attributes[key]) === value);
