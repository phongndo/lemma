import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "@lemma/llm";
import { formatThroughput, throughput } from "../src/speed.ts";
import { assistant, usage } from "../src/testing.ts";

type Timing = { startedAt: number; firstTokenAt?: number; endedAt: number };
const call = (output: number, timing?: Timing, extra: Partial<AssistantMessage> = {}) => ({
  message: assistant([], { usage: usage(10, output), ...extra }),
  timing,
});

describe("throughput", () => {
  it("counts the calls' streaming, not their wait for a first token or a call that came whole", () => {
    const calls = [
      call(100, { startedAt: 0, firstTokenAt: 5000, endedAt: 7000 }),
      call(50, { startedAt: 0, firstTokenAt: 1000, endedAt: 2000 }),
      call(999, { startedAt: 0, firstTokenAt: 1000, endedAt: 1010 }),
      call(999, { startedAt: 0, endedAt: 1000 }),
      call(999),
    ];
    expect(throughput(calls)).toBe(50);
    expect(throughput([call(999)])).toBeUndefined();
  });

  it("leaves out reasoning the provider did not stream, and keeps reasoning it did", () => {
    const timing = { startedAt: 0, firstTokenAt: 20_000, endedAt: 21_000 };
    const hidden = call(5100, timing, { usage: { ...usage(10, 5100), reasoning: 5000 } });
    expect(throughput([hidden])).toBe(100);
    const shown = call(5100, timing, { usage: { ...usage(10, 5100), reasoning: 5000 }, content: [{ type: "thinking", thinking: "…" }] });
    expect(throughput([shown])).toBe(5100);
  });

  it("formats", () => {
    expect([formatThroughput(50), formatThroughput(4.25)]).toEqual(["50 tok/s", "4.3 tok/s"]);
  });
});
