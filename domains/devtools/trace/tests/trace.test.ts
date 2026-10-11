import { describe, expect, it } from "vitest";
import { Effect, Layer, Stream } from "effect";
import { Channels, elementsOf, resultOf, Trace } from "@lemma/contracts";
import type { Channel, ChannelCall, ChannelStream, CompositionChange, SpanRecord } from "@lemma/contracts";
import { makeCore, Registries } from "@lemma/core";
import trace, { redacted } from "../src/index.ts";

const span = (id: string, name: string, attributes: SpanRecord["attributes"], start = 1): SpanRecord => ({
  id,
  traceId: "t",
  name,
  start,
  ms: 1,
  status: "ok",
  attributes,
});

const kept = [span("a", "agent.turn", { "session.id": "s1" }), span("b", "core.hook", { "session.id": "s2", "plugin.id": "p" }, 5)];
const changes: CompositionChange[] = [{ at: 1, cause: "start", started: ["p"], stopped: [], restarted: [], failed: [] }];

/** Runs the plugin over a host `Trace` that kept `kept`, then ends `later`, and hands `body` its channels. */
const withTrace = <A>(later: readonly (readonly SpanRecord[])[], body: (channels: ReadonlyMap<string, Channel>) => Effect.Effect<A, unknown>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const host = Layer.succeed(Trace, { spans: Effect.succeed(kept), ended: Stream.fromIterable(later), changes: Effect.succeed(changes) });
        const core = yield* makeCore([trace], { provide: { provides: [Trace], layer: host } });
        const items = yield* core.run(Effect.flatMap(Registries, (registries) => registries.items(Channels)));
        return yield* body(new Map(items.map(({ item }) => [item.id, item])));
      }),
    ),
  );

describe("devtools.trace", () => {
  it("hides the secrets a request's span can hold before a trace leaves the host", () => {
    const request = span("r", "http.server GET", {
      "url.full": "http://127.0.0.1:7433/rpc?token=abc123&x=1",
      "http.request.header.authorization": "Bearer abc123",
      "http.request.header.cookie": "lemma=abc123",
      "http.response.status_code": 200,
    });
    expect(redacted(request).attributes).toEqual({
      "url.full": "http://127.0.0.1:7433/rpc?token=<redacted>&x=1",
      "http.request.header.authorization": "<redacted>",
      "http.request.header.cookie": "<redacted>",
      "http.response.status_code": 200,
    });
    const plain = span("p", "core.hook", { "plugin.id": "p" });
    expect(redacted(plain)).toBe(plain);
  });

  it("answers with the kept spans that match: by attribute, and ended since a time", () =>
    withTrace([], (channels) =>
      Effect.gen(function* () {
        const spans = channels.get("devtools.trace.spans") as ChannelCall;
        expect(((yield* resultOf(spans, {})) as SpanRecord[]).map((found) => found.id)).toEqual(["a", "b"]);
        expect(((yield* resultOf(spans, { where: { "session.id": "s2" } })) as SpanRecord[]).map((found) => found.id)).toEqual(["b"]);
        expect(((yield* resultOf(spans, { since: 3 })) as SpanRecord[]).map((found) => found.id)).toEqual(["b"]);
        expect(((yield* resultOf(spans, { limit: 1 })) as SpanRecord[]).map((found) => found.id)).toEqual(["b"]);
        expect(yield* resultOf(channels.get("devtools.trace.changes") as ChannelCall, undefined)).toEqual(changes);
      }),
    ));

  it("follows the spans that match as they end, in batches", () =>
    withTrace(
      [[span("c", "later", { "session.id": "s1" }), span("d", "other", { "session.id": "s2" })], [span("e", "last", { "session.id": "s1" })]],
      (channels) =>
        Effect.gen(function* () {
          const follow = channels.get("devtools.trace.follow") as ChannelStream;
          const batches = (yield* Stream.runCollect(elementsOf(follow, { where: { "session.id": "s1" } }))) as (readonly SpanRecord[])[];
          expect(batches.flat().map((found) => found.id)).toEqual(["c", "e"]);
        }),
    ));
});
