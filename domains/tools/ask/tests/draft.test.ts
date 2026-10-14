import { describe, expect, it } from "vitest";
import { answerOf, answersOf, describeAnswer, emptyDraft, pick } from "../src/draft.ts";
import { answerProblem, displayLabel, inputProblem } from "../src/questions.ts";
import { askView } from "../src/view.tsx";
import { KEEP_MS, dropped, makeAsking } from "../src/asking.ts";

const one = { header: "Storage", question: "Where?", options: [{ label: "SQLite (Recommended)" }, { label: "JSON files" }] };
const many = { header: "Tests", question: "Which tests?", options: [{ label: "Unit" }, { label: "E2E" }, { label: "Fuzz" }], multiSelect: true };

describe("a question's draft", () => {
  it("picks one option, or toggles several in the order offered; picking a picked one unpicks it", () => {
    expect(pick(one, pick(one, emptyDraft, "JSON files"), "SQLite (Recommended)").picked).toEqual(["SQLite (Recommended)"]);
    expect(pick(one, { ...emptyDraft, picked: ["JSON files"], text: "note" }, "JSON files")).toEqual({ ...emptyDraft, text: "note" });
    const both = pick(many, pick(many, emptyDraft, "Fuzz"), "Unit");
    expect(both.picked).toEqual(["Unit", "Fuzz"]);
    expect(pick(many, both, "Fuzz").picked).toEqual(["Unit"]);
    expect(pick(one, { ...emptyDraft, skipped: true }, "JSON files").skipped).toBe(false);
  });

  it("answers with a pick, the user's own words, or both; unanswered ones go as skipped", () => {
    expect(answerOf(emptyDraft)).toBeUndefined();
    expect(answerOf({ ...emptyDraft, text: "  " })).toBeUndefined();
    expect(answerOf({ ...emptyDraft, picked: ["Unit"] })).toEqual({ kind: "answered", selected: ["Unit"] });
    expect(answerOf({ ...emptyDraft, text: " Redis " })).toEqual({ kind: "answered", selected: [], text: "Redis" });
    expect(answerOf({ ...emptyDraft, picked: ["Unit"], text: "only fast ones" })).toEqual({ kind: "answered", selected: ["Unit"], text: "only fast ones" });
    expect(answersOf([emptyDraft, { ...emptyDraft, skipped: true }])).toEqual([{ kind: "skipped" }, { kind: "skipped" }]);
  });

  it("describes an answer for the review and the transcript", () => {
    expect(describeAnswer(undefined)).toBe("Not answered: the agent decides");
    expect(describeAnswer({ kind: "skipped" })).toBe("Skipped: the agent decides");
    expect(describeAnswer({ kind: "answered", selected: ["SQLite (Recommended)"] })).toBe("SQLite");
    expect(describeAnswer({ kind: "answered", selected: ["Unit", "E2E"], text: "fast" })).toBe("Unit, E2E — “fast”");
    expect(describeAnswer({ kind: "answered", selected: [], text: "Redis" })).toBe("“Redis”");
  });
});

describe("questions", () => {
  it("show a recommended option's suffix as a badge", () => {
    expect(displayLabel("SQLite (Recommended)")).toEqual({ text: "SQLite", recommended: true });
    expect(displayLabel("JSON files")).toEqual({ text: "JSON files", recommended: false });
  });

  it("need distinct texts and labels, since answers name options by label", () => {
    expect(inputProblem({ questions: [one, many] })).toBeUndefined();
    expect(inputProblem({ questions: [one, one] })).toContain("asked twice");
    expect(inputProblem({ questions: [{ ...one, options: [{ label: "A" }, { label: " " }] }] })).toContain("has no label");
  });

  it("take answers that fit them", () => {
    expect(answerProblem([one], [])).toContain("1 questions need 1 answers");
    expect(answerProblem([one], [{ kind: "answered", selected: [] }])).toContain("picks nothing and says nothing");
    expect(answerProblem([many], [{ kind: "answered", selected: ["Unit", "Unit"] }])).toContain("picked twice");
    expect(answerProblem([one, many], [{ kind: "skipped" }, { kind: "answered", selected: ["Unit", "Fuzz"] }])).toBeUndefined();
  });
});

describe("askView", () => {
  it("sums a call up by its first question", () => {
    expect(askView.summary?.({ questions: [one, many] }, {})).toEqual({ primary: "Where?", secondary: "and 1 more" });
    expect(askView.summary?.({ questions: [one] }, {})).toEqual({ primary: "Where?" });
    expect(askView.summary?.(undefined, {})).toEqual({});
  });
});

describe("answering a call", () => {
  const open = (questions: readonly (typeof one | typeof many)[]) => ({ sessionId: "s", toolCallId: "c1", questions, at: 0 });
  const make = (questions: readonly (typeof one | typeof many)[]) => {
    const sent: (readonly unknown[])[] = [];
    const asking = makeAsking(open(questions), { submit: async (answers) => void sent.push(answers) });
    return { asking, sent };
  };

  it("keeps each question's own text, steps through them to a review, and sends from it", async () => {
    const { asking, sent } = make([one, many]);
    expect(asking.submitLabel()).toBe("Next question");
    asking.setText("Redis");
    asking.next();
    expect(asking.tab()).toBe(1);
    expect(asking.draft().text).toBe("");
    expect(asking.submitLabel()).toBe("Review answers");
    asking.goTo(0);
    expect(asking.draft().text).toBe("Redis");
    asking.goTo(2);
    expect(asking.question()).toBeUndefined();
    expect(asking.submitLabel()).toBe("Submit answers");
    asking.next();
    await Promise.resolve();
    expect(sent).toEqual([[{ kind: "answered", selected: [], text: "Redis" }, { kind: "skipped" }]]);
  });

  it("takes a menu's keys from the empty text box: move, pick by digit or Enter, change question", async () => {
    const { asking, sent } = make([many, one]);
    expect(asking.active()).toBeUndefined();
    expect(asking.boxKey("Enter")).toBe(false);
    expect(asking.boxKey("ArrowUp")).toBe(true);
    expect(asking.active()).toBe(2);
    expect(asking.boxKey("ArrowDown")).toBe(true);
    expect(asking.active()).toBe(0);
    expect(asking.boxKey("Enter")).toBe(true);
    expect(asking.boxKey("3")).toBe(true);
    expect(asking.draft().picked).toEqual(["Unit", "Fuzz"]);
    // The highlighted option is picked now: Enter is the send button's, to go on.
    expect(asking.boxKey("Enter")).toBe(false);
    expect(asking.boxKey("9")).toBe(false);
    expect(asking.boxKey("ArrowRight")).toBe(true);
    expect(asking.tab()).toBe(1);
    asking.setText("Redis");
    expect(asking.boxKey("ArrowLeft")).toBe(false);
    expect(asking.boxKey("1")).toBe(false);
    asking.setText("");
    expect(asking.boxKey("ArrowLeft")).toBe(true);
    // Back on a question, its first pick is highlighted.
    expect(asking.active()).toBe(0);
    asking.goTo(1);
    expect(asking.boxKey("2")).toBe(true);
    expect(asking.boxKey("Enter")).toBe(false);
    expect(sent).toEqual([]);
  });

  it("stays on a question after a pick, for a note, and a lone one sends only on Enter", async () => {
    const several = make([one, many]);
    several.asking.choose(1);
    several.asking.setText("for now");
    expect(several.asking.tab()).toBe(0);
    several.asking.choose(1);
    expect(several.asking.draft()).toEqual({ picked: [], text: "for now", skipped: false });

    const lone = make([one]);
    expect(lone.asking.submitLabel()).toBe("Submit answer");
    lone.asking.choose(0);
    lone.asking.setText("keep it local");
    await Promise.resolve();
    expect(lone.sent).toEqual([]);
    lone.asking.next();
    await Promise.resolve();
    expect(lone.sent).toEqual([[{ kind: "answered", selected: ["SQLite (Recommended)"], text: "keep it local" }]]);
  });

  it("dismisses every question as skipped, whatever was picked or written", async () => {
    const { asking, sent } = make([one, many]);
    asking.choose(0);
    asking.setText("maybe");
    asking.dismiss();
    asking.dismiss();
    await Promise.resolve();
    expect(sent).toEqual([[{ kind: "skipped" }, { kind: "skipped" }]]);
  });

  it("asks for a note once something is picked, and a skip keeps what was written", () => {
    const { asking } = make([one, many]);
    expect(asking.placeholder()).toBe("Type your own answer, or pick an option above");
    asking.setText("not sure yet");
    asking.choose(0);
    expect(asking.placeholder()).toBe("Add a note to “SQLite”, or leave this blank");
    asking.skip();
    asking.goTo(0);
    expect(asking.draft()).toEqual({ picked: [], text: "not sure yet", skipped: true });
  });
});

describe("a call's answers, once asked", () => {
  const open = (questions: readonly (typeof one)[]) => ({ sessionId: "s", toolCallId: "c1", questions, at: 0 });

  it("are not sent for a lone question before it has an answer, and are sent once", async () => {
    let sent = 0;
    const asking = makeAsking(open([one]), { submit: async () => void sent++ });
    expect(asking.canSubmit()).toBe(false);
    asking.next();
    await Promise.resolve();
    expect(sent).toBe(0);
    asking.setText("Redis");
    expect(asking.canSubmit()).toBe(true);
    asking.next();
    await Promise.resolve();
    await Promise.resolve();
    expect(sent).toBe(1);
    expect(asking.submitLabel()).toBe("Sent");
    expect(asking.canSubmit()).toBe(false);
    asking.next();
    asking.skip();
    await Promise.resolve();
    expect(sent).toBe(1);
  });

  it("are dropped once their call leaves a live list, and kept a while when missing from a fresh one", () => {
    const seen = new Map([["gone", 0]]);
    expect(dropped(["gone", "open"], new Set(["open"]), seen, false, 1)).toEqual(["gone"]);
    expect(dropped(["gone", "open"], new Set(["open"]), seen, true, 1)).toEqual([]);
    expect(dropped(["gone"], new Set(), seen, true, KEEP_MS + 1)).toEqual(["gone"]);
  });
});
