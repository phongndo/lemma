import { describe, expect, it } from "vitest";
import { createRoot } from "solid-js";
import type { SpanRecord } from "@lemma/contracts";
import { createTrace, KEPT } from "../src/model.ts";
import type { TraceSource } from "../src/model.ts";

const span = (id: string): SpanRecord => ({ id, traceId: "t", name: id, start: 0, ms: 1, status: "ok", attributes: {} });

/** A source whose answer to `spans` waits for `answer`, and whose follow `end` delivers to. */
const source = () => {
  let heard: ((spans: readonly SpanRecord[]) => void) | undefined;
  let answer!: (spans: readonly SpanRecord[]) => void;
  const answered = new Promise<readonly SpanRecord[]>((resolve) => (answer = resolve));
  const trace: TraceSource = {
    name: "host",
    spans: () => answered,
    follow: (listener) => {
      heard = listener;
      return () => (heard = undefined);
    },
    changes: async () => [],
  };
  return { trace, answer, end: (...spans: SpanRecord[]) => heard?.(spans) };
};

describe("a trace a view shows", () => {
  it("keeps a span that ended while a refresh was on its way, though the answer was read before it ended", async () => {
    const { trace, answer, end } = source();
    await createRoot(async (dispose) => {
      const model = createTrace(trace);
      const refreshed = model.refresh();
      // Followed before the answer arrives, and not in it; and one in both, held once.
      end(span("late"), span("both"));
      answer([span("early"), span("both")]);
      await refreshed;
      expect(model.spans().map((held) => held.id)).toEqual(["early", "both", "late"]);
      end(span("late"), span("next"));
      expect(model.spans().map((held) => held.id)).toEqual(["early", "both", "late", "next"]);
      dispose();
    });
  });

  it("holds the newest, as many as it keeps, and takes again a span it dropped", () => {
    const { trace, end } = source();
    createRoot((dispose) => {
      const model = createTrace(trace);
      end(...Array.from({ length: KEPT + 1 }, (_, index) => span(`s${index}`)));
      expect(model.spans()).toHaveLength(KEPT);
      expect(model.spans()[0]!.id).toBe("s1");
      // The dropped one is no longer known, so it is held again when it comes.
      end(span("s0"));
      expect(model.spans().at(-1)!.id).toBe("s0");
      dispose();
    });
  });
});
