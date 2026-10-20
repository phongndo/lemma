import { Duration, Effect, Stream } from "effect";
import { definePlugin } from "@lemma/core";
import { Channels, serveChannel, Trace } from "@lemma/contracts";
import type { SpanRecord } from "@lemma/contracts";
import { matches, redactText, SECRET_KEY, selectSpans, TraceChannels } from "@lemma/devtools";

/** How long the follow stream gathers spans into one batch, and how many at most. */
const BATCH = Duration.millis(250);
const BATCH_SIZE = 1000;

/**
 * `span` with its secrets hidden: what the host's own HTTP server records of a request (its headers, its URL) can hold
 * the token a client connected with, and a trace leaves the host through this plugin.
 */
export const redacted = (span: SpanRecord): SpanRecord => {
  let changed = false;
  const attributes: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(span.attributes)) {
    const hidden = SECRET_KEY.test(key) ? "<redacted>" : typeof value === "string" ? redactText(value) : value;
    if (hidden !== value) changed = true;
    attributes[key] = hidden;
  }
  return changed ? { ...span, attributes } : span;
};

/**
 * Serves the host's trace (`Trace`) to clients: the spans it kept, those that end from now on, and the composition's
 * changes. Its web half shows them in the devtools.
 */
export default definePlugin({
  id: "devtools.trace",
  version: "0.1.0",
  requires: { trace: Trace },
  setup: ({ trace }, owner) =>
    Effect.all(
      [
        owner.add(
          Channels,
          // Matched as served, redacted, so a query cannot confirm a guessed secret.
          serveChannel(TraceChannels.spans, (query) => Effect.map(trace.spans, (spans) => selectSpans(spans.map(redacted), query))),
        ),
        owner.add(
          Channels,
          serveChannel(TraceChannels.follow, ({ where }) =>
            trace.ended.pipe(
              Stream.flattenIterable,
              Stream.map(redacted),
              Stream.filter((span) => matches(span, where)),
              Stream.groupedWithin(BATCH_SIZE, BATCH),
            ),
          ),
        ),
        owner.add(
          Channels,
          serveChannel(TraceChannels.changes, () => trace.changes),
        ),
      ],
      { discard: true },
    ),
});
