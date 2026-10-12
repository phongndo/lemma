import { Duration, Effect, Stream } from "effect";
import { definePlugin } from "@lemma/core";
import { Channels, serveChannel, Trace } from "@lemma/contracts";
import type { SpanRecord } from "@lemma/contracts";
import { matches, selectSpans, TraceChannels } from "@lemma/devtools";

/** How long the follow stream gathers spans into one batch, and how many at most. */
const BATCH = Duration.millis(250);
const BATCH_SIZE = 1000;

/** An attribute whose value is a secret by its name: a credential, a cookie, a token (not a count of tokens). */
const SECRET_KEY = /authorization|cookie|token(?![a-z])|secret|password|api[-_.]?key/i;
/** A secret in a value: a query parameter that carries one, in a URL (`?token=…`) or a query on its own (`token=…`). */
const SECRET_PARAM = /((?:^|[?&])(?:token|key|secret|password|access_token|api[-_]?key)=)[^&#\s]+/gi;

/**
 * `span` with its secrets hidden: what the host's own HTTP server records of a request (its headers, its URL) can hold
 * the token a client connected with, and a trace leaves the host through this plugin.
 */
export const redacted = (span: SpanRecord): SpanRecord => {
  let changed = false;
  const attributes: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(span.attributes)) {
    const hidden = SECRET_KEY.test(key) ? "<redacted>" : typeof value === "string" ? value.replace(SECRET_PARAM, "$1<redacted>") : value;
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
