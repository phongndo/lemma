import { describe, expect, it } from "vitest";
import { capTree, consoleLevel, consoleMessage, fieldRefs, keepMessage, maskFields, MAX_CONSOLE_MESSAGES, withGeneration } from "../src/snapshot.ts";
import type { ConsoleMessage } from "@lemma/browser";

describe("snapshots", () => {
  it("give their refs the snapshot's generation, in frames too", () => {
    expect(withGeneration('- button "Save" [ref=e12]\n  - link "x" [ref=f1e3]', 4)).toBe('- button "Save" [ref=s4-e12]\n  - link "x" [ref=s4-f1e3]');
  });

  it("hide the values of the fields named secret, however the snapshot wrote them", () => {
    const tree = [
      '- textbox "Password" [ref=e3]: "p@ss: word #1"',
      '- textbox "Pin" [ref=f1e4]: "9876"',
      '- textbox "Email" [ref=e5]: me@example.com',
      '- textbox "Empty" [ref=e6]',
      "- text: hunter2 is my name",
    ].join("\n");
    expect(fieldRefs(tree)).toEqual(["e3", "f1e4", "e5"]);
    expect(maskFields(tree, new Set(["e3", "f1e4"]))).toBe(
      [
        '- textbox "Password" [ref=e3]: ••••••',
        '- textbox "Pin" [ref=f1e4]: ••••••',
        '- textbox "Email" [ref=e5]: me@example.com',
        '- textbox "Empty" [ref=e6]',
        "- text: hunter2 is my name",
      ].join("\n"),
    );
  });

  it("are cut at a line near the limit, saying how much is left", () => {
    const tree = Array.from({ length: 100 }, (_, i) => `- listitem: item ${i}`).join("\n");
    const { tree: cut, truncated } = capTree(tree, 200);
    expect(truncated).toBe(true);
    expect(cut.split("\n")[0]).toBe("- listitem: item 0");
    expect(cut).toMatch(/\[Snapshot cut here: \d+ more lines \(\d+ KB\) not shown\. Read the rest with browser_evaluate/);
    expect(capTree("- a", 200)).toEqual({ tree: "- a", truncated: false });
  });
});

describe("console messages", () => {
  it("keep their level, a short text, and only the newest", () => {
    expect(consoleLevel("warning")).toBe("warning");
    expect(consoleLevel("dir")).toBe("log");
    expect(consoleMessage("log", "x".repeat(600)).text).toHaveLength(501);
    const kept: ConsoleMessage[] = [];
    for (let i = 0; i < MAX_CONSOLE_MESSAGES + 5; i++) keepMessage(kept, { level: "log", text: String(i) });
    expect(kept).toHaveLength(MAX_CONSOLE_MESSAGES);
    expect(kept[0]!.text).toBe("5");
  });
});
