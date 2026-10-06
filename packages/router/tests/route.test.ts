import { Effect, Result, Schema } from "effect";
import { describe, expect, test } from "vitest";
import { defineRoute } from "../src/route.ts";

const Thread = defineRoute("thread", {
  path: "/threads/:id/:view?",
  params: Schema.Struct({ id: Schema.String, view: Schema.optional(Schema.String) }),
  search: Schema.Struct({
    tab: Schema.Literals(["overview", "faults"]).pipe(Schema.withDecodingDefaultType(Effect.sync(() => "overview" as const))),
    since: Schema.optional(Schema.FiniteFromString),
  }),
});

describe("defineRoute", () => {
  test("decodes the URL's strings into typed values", () => {
    expect(Thread.decodeParams({ id: "x" })).toEqual(Result.succeed({ id: "x" }));
    expect(Thread.decodeSearch({ since: "12", tab: "faults" })).toEqual(Result.succeed({ tab: "faults", since: 12 }));
    expect(Thread.decodeSearch({})).toEqual(Result.succeed({ tab: "overview" }));
    expect(Result.isFailure(Thread.decodeSearch({ since: "soon" }))).toBe(true);
  });

  test("ignores search keys it does not declare", () => {
    expect(Thread.decodeSearch({ safe: "", tab: "faults" })).toEqual(Result.succeed({ tab: "faults" }));
  });

  test("encodes typed values back, leaving out defaults", () => {
    expect(Thread.href({ id: "x" })).toBe("/threads/x");
    expect(Thread.href({ id: "x", view: "trajectory" }, { tab: "overview" })).toBe("/threads/x/trajectory");
    expect(Thread.href({ id: "x" }, { tab: "faults", since: 3 })).toBe("/threads/x?tab=faults&since=3");
  });

  test("an encoded href decodes to what was encoded", () => {
    const href = Thread.href({ id: "a b", view: "chat" }, { since: 7 });
    const url = new URL(href, "http://x");
    expect(url.pathname).toBe("/threads/a%20b/chat");
    expect(Thread.decodeSearch(Object.fromEntries(url.searchParams))).toEqual(Result.succeed({ tab: "overview", since: 7 }));
  });

  test("params that do not encode throw", () => {
    const Numbered = defineRoute("numbered", { path: "/n/:n", params: Schema.Struct({ n: Schema.FiniteFromString }) });
    expect(Numbered.href({ n: 4 })).toBe("/n/4");
    expect(Result.isFailure(Numbered.decodeParams({ n: "four" }))).toBe(true);
  });

  test("without Schemas, params are strings and there is no search", () => {
    const Plain = defineRoute("plain", { path: "/p/:a" });
    expect(Plain.decodeParams({ a: "1" })).toEqual(Result.succeed({ a: "1" }));
    expect(Plain.href({ a: "1" })).toBe("/p/1");
    expect(Plain.defaults).toEqual({});
  });
});
