import { expect, test } from "vitest";
import type { SpanRecord } from "@lemma/contracts";
import { matches } from "../src/index.ts";

test("a span matches the attributes it has with those values, and not one it lacks, whatever the value asked", () => {
  const span: SpanRecord = { id: "a", traceId: "t", name: "x", start: 0, ms: 1, status: "ok", attributes: { "session.id": "s1", "step.index": 2 } };
  expect(matches(span, undefined)).toBe(true);
  expect(matches(span, { "session.id": "s1", "step.index": "2" })).toBe(true);
  expect(matches(span, { "session.id": "s2" })).toBe(false);
  expect(matches(span, { "turn.id": "undefined" })).toBe(false);
});
