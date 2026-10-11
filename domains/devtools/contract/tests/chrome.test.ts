import { describe, expect, test } from "vitest";
import type { SpanRecord } from "@lemma/contracts";
import { chromeTrace } from "../src/chrome.ts";

const span = (id: string, start: number, ms: number, more: Partial<SpanRecord> = {}): SpanRecord => ({
  id,
  traceId: "t1",
  name: id,
  start,
  ms,
  status: "ok",
  attributes: {},
  ...more,
});

describe("chromeTrace", () => {
  test("a trace is a process named for its root; a span nests in its parent's lane, and side by side ones get their own", () => {
    const { traceEvents } = chromeTrace([
      // In the order they ended, as the host keeps them.
      span("read", 1001, 3, { parentId: "step", attributes: { "plugin.id": "tools.read" } }),
      span("bash", 1002, 5, { parentId: "step", status: "error", error: "exit 1" }),
      span("step", 1000, 10, { parentId: "turn" }),
      span("turn", 1000, 20),
      span("other", 5000, 1, { traceId: "t2" }),
    ]);
    expect(traceEvents.filter((event) => event.ph === "M").map((event) => [event.pid, event.args.name])).toEqual([
      [1, "turn"],
      [2, "other"],
    ]);
    const lane = Object.fromEntries(traceEvents.flatMap((event) => (event.ph === "X" ? [[event.name, [event.pid, event.tid]]] : [])));
    expect(lane).toEqual({ turn: [1, 1], step: [1, 1], read: [1, 1], bash: [1, 2], other: [2, 1] });
    expect(traceEvents.find((event) => event.ph === "X" && event.name === "bash")).toMatchObject({
      ts: 1_002_000,
      dur: 5000,
      cat: "lemma",
      args: { "span.id": "bash", status: "error", error: "exit 1" },
    });
    expect(traceEvents.find((event) => event.ph === "X" && event.name === "read")).toMatchObject({ cat: "tools.read" });
  });

  test("a lane that a span ended in is free for the next one", () => {
    const { traceEvents } = chromeTrace([span("root", 0, 10), span("a", 1, 2, { parentId: "root" }), span("b", 4, 2, { parentId: "root" })]);
    expect(traceEvents.flatMap((event) => (event.ph === "X" ? [event.tid] : []))).toEqual([1, 1, 1]);
  });
});
