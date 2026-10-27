import { describe, expect, it } from "vitest";
import { keepEnds, keepHead, lineCount } from "../src/bound.ts";

const numbered = (count: number, from = 1) => Array.from({ length: count }, (_, i) => `line ${from + i}`).join("\n");
const whole = (text: string) => ({ head: text, tail: text, chars: text.length, lines: lineCount(text) });

describe("keepEnds", () => {
  it("keeps a text within the budget whole", () => {
    expect(keepEnds(whole("one\ntwo\n"), 100, "Full output: /f")).toEqual({ text: "one\ntwo\n" });
  });

  it("keeps whole lines from the start and the end, within the budget, around one marker", () => {
    const text = `${numbered(1000)}\n`;
    const kept = keepEnds(whole(text), 1_000, "Full output: /f");
    expect(kept.text.length).toBeLessThanOrEqual(1_000);
    expect(kept.text).toMatch(
      /^line 1\nline 2\n[\s\S]*\n\n\[… (\d+) lines left out: showing lines 1-(\d+) and (\d+)-1000 of 1000\. Full output: \/f\]\n\n[\s\S]*line 1000\n$/,
    );
    const [, left, headTo, tailFrom] = /(\d+) lines left out: showing lines 1-(\d+) and (\d+)-/.exec(kept.text)!.map(Number);
    expect(left).toBe(tailFrom! - headTo! - 1);
    expect(kept.text).toContain(`line ${headTo}\n\n[…`);
    expect(kept.text).toContain(`]\n\nline ${tailFrom}\n`);
    expect(kept.cut).toMatchObject({ chars: text.length, lines: 1000 });
  });

  it("keeps the start and the end of a line too long for either half", () => {
    const kept = keepEnds(whole("a".repeat(500) + "b".repeat(500)), 400, "Full output: /f");
    expect(kept.text).toMatch(/^a+\n\n\[… \d+ characters left out: showing the start and the end of its one line\. Full output: \/f\]\n\nb+$/);
    expect(kept.text.length).toBeLessThanOrEqual(400);

    const two = keepEnds(whole(`${"a".repeat(600)}\n${"b".repeat(600)}`), 400, "");
    expect(two.text).toMatch(/^a+\n\n\[… \d+ characters left out: showing the start of line 1 and the end of line 2 of 2\.\]\n\nb+$/);
  });

  it("reads a streamed text by its ends and counts", () => {
    const text = numbered(5000);
    const kept = keepEnds({ head: text.slice(0, 2_000), tail: text.slice(-2_000), chars: text.length, lines: 5000 }, 1_000, "Full output: /f");
    expect(kept).toEqual(keepEnds(whole(text), 1_000, "Full output: /f"));
  });
});

describe("keepHead", () => {
  const rest = ({ next }: { readonly next: number }) => `Use offset=${next} to continue.`;

  it("keeps a text within the budget whole, unless more lines follow it", () => {
    expect(keepHead("one\ntwo\n", 100, { rest })).toEqual({ text: "one\ntwo\n" });
    expect(keepHead("two\nthree\n", 100, { from: 2, of: 5, rest }).text).toBe(
      "two\nthree\n\n[… 2 lines left out: showing lines 2-3 of 5. Use offset=4 to continue.]",
    );
    expect(keepHead("two\n", 100, { from: 2, of: undefined, rest }).text).toBe("two\n\n[… the rest left out: showing line 2. Use offset=3 to continue.]");
  });

  it("keeps whole lines from the start within the budget, saying how to go on", () => {
    const kept = keepHead(numbered(1000, 11), 1_000, { from: 11, of: 2000, rest });
    expect(kept.text.length).toBeLessThanOrEqual(1_000);
    const [, left, last, next] = /\[… (\d+) lines left out: showing lines 11-(\d+) of 2000\. Use offset=(\d+) to continue\.\]$/.exec(kept.text)!.map(Number);
    expect([left, next]).toEqual([2000 - last!, last! + 1]);
    expect(kept.text).toContain(`line ${last}\n\n[…`);
  });

  it("keeps the start of a first line longer than the budget", () => {
    const kept = keepHead(`${"x".repeat(2_000)}\nnext`, 1_000, {
      from: 3,
      of: 9,
      rest: ({ next, partial, kept }) => `next ${next}, partial ${partial}, kept ${kept}`,
    });
    const [, shown, kept_] =
      /^x+\n\n\[… the rest of line 3 and 6 lines after it left out: showing the first (\d+) characters of line 3 of 9\. next 3, partial true, kept (\d+)\]$/.exec(
        kept.text,
      )!;
    expect(kept_).toBe(shown);
    expect(kept.text.length).toBeLessThanOrEqual(1_000);
  });
});
