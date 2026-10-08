import { describe, expect, test } from "vitest";
import { Effect, Schema, Stream } from "effect";
import { channelProblem, serveChannel } from "../src/channels.ts";

describe("channelProblem", () => {
  const good = { kind: "call", id: "probe.call", payload: Schema.Void, success: Schema.Void, handle: () => Effect.void };

  test("accepts a channel as serveChannel makes it, with or without a title and description", () => {
    expect(channelProblem(serveChannel({ kind: "call", id: "probe.call", payload: Schema.Void, success: Schema.Void }, () => Effect.void))).toBeUndefined();
    expect(channelProblem({ ...good, kind: "stream", title: "Probe", description: "Ticks", handle: () => Stream.empty })).toBeUndefined();
  });

  test("names what is wrong with an untyped plugin's item", () => {
    expect(channelProblem(undefined)).toBe("a channel is an object");
    expect(channelProblem({ ...good, id: "" })).toBe("its `id` must be a non-empty string");
    expect(channelProblem({ ...good, kind: "subscription" })).toBe('"probe.call": its `kind` must be "call" or "stream", not "subscription"');
    expect(channelProblem({ ...good, kind: undefined })).toBe('"probe.call": its `kind` must be "call" or "stream", not undefined');
    expect(channelProblem({ ...good, title: 1 })).toBe('"probe.call": its `title` must be a string');
    expect(channelProblem({ ...good, description: {} })).toBe('"probe.call": its `description` must be a string');
    expect(channelProblem({ ...good, payload: {} })).toBe('"probe.call": its `payload` must be a Schema');
    expect(channelProblem({ ...good, success: undefined })).toBe('"probe.call": its `success` must be a Schema');
    expect(channelProblem({ ...good, handle: "run" })).toBe('"probe.call": its `handle` must be a function');
  });
});
