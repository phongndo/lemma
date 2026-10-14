import { describe, expect, test } from "vitest";
import { createRoot, createSignal } from "solid-js";
import type { ComposerCompletion, ComposerSuggestion } from "@lemma/threads";
import type { SlotItem, SlotsService } from "@lemma/web";
import { createCompletion, ghostText } from "../src/completion.ts";

const suggestion = (key: string): ComposerSuggestion => ({ key, label: key, insert: key });

/** A completion over one `@` source answering at once, with the text and cursor as signals the test sets. */
const harness = (run: (h: ReturnType<typeof make>) => Promise<void>) =>
  createRoot(async (dispose) => {
    try {
      await run(make());
    } finally {
      dispose();
    }
  });

const make = () => {
  const source: SlotItem<ComposerCompletion> = {
    id: "files",
    trigger: "@",
    label: "Files",
    suggest: (query) => ["a", "b", "c"].map((name) => suggestion(`${query}${name}`)),
  };
  const slots = { list: () => [source] } as unknown as SlotsService;
  const [text, setText] = createSignal("");
  const [cursor, setCursor] = createSignal(0);
  const completion = createCompletion(slots, text, cursor, () => true);
  /** Types `value` with the cursor at its end (or at `at`), then lets the source's answer settle. */
  const type = async (value: string, at = value.length) => {
    setText(value);
    setCursor(at);
    await Promise.resolve();
    await Promise.resolve();
  };
  return { completion, type, setCursor };
};

describe("createCompletion", () => {
  test("Escape dismisses the word while typing on in it; leaving it and coming back opens the menu again", () =>
    harness(async ({ completion, type, setCursor }) => {
      await type("see @fo");
      expect(completion.open()).toBe(true);
      completion.dismiss();
      expect(completion.open()).toBe(false);
      await type("see @foo");
      expect(completion.open()).toBe(false);
      setCursor(2);
      expect(completion.match()).toBeUndefined();
      await type("see @foo");
      expect(completion.open()).toBe(true);
    }));

  test("dismissing one word leaves another word's menu open", () =>
    harness(async ({ completion, type }) => {
      await type("@a");
      completion.dismiss();
      await type("@a @b");
      expect(completion.open()).toBe(true);
      expect(completion.match()?.start).toBe(3);
    }));

  test("the active suggestion is chosen by key, and a new word starts at the first", () =>
    harness(async ({ completion, type }) => {
      await type("@x");
      expect(completion.items().map((item) => item.suggestion.key)).toEqual(["xa", "xb", "xc"]);
      completion.move(2);
      expect(completion.active()).toBe(2);
      completion.move(1);
      expect(completion.active()).toBe(0);
      completion.setActive(1);
      expect(completion.active()).toBe(1);
      await type("@x @y");
      expect(completion.active()).toBe(0);
    }));
});

describe("ghostText", () => {
  const word = { trigger: "/", query: "mcp rec", start: 0, end: 8, quoted: false };
  const active: ComposerSuggestion = { key: "reconnect", label: "reconnect", insert: "/mcp reconnect", hint: "<server>" };

  test("shows the rest of the active suggestion and what follows it, while the cursor ends the prompt", () => {
    expect(ghostText("/mcp rec", word, 8, active, [])).toBe("onnect <server>");
    expect(ghostText("/mcp rec", word, 3, active, [])).toBe("");
  });

  test("shows nothing for a suggestion what is typed does not begin, and a group's hint with none active", () => {
    expect(ghostText("/mcp rec", word, 8, { ...active, insert: "/other" }, [])).toBe("");
    expect(ghostText("/mcp rec", word, 8, undefined, [{}, { hint: "<server>" }])).toBe("<server>");
  });
});
