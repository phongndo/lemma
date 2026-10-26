import { describe, expect, test } from "vitest";
import { draftsOf, dropRetry, keepDraft, lostOnReload, returned, unsent } from "../src/drafts.ts";
import type { Draft, Drafts } from "../src/drafts.ts";

const image = { type: "image", data: "aGk=", mimeType: "image/png" } as const;
const other = { type: "image", data: "eW8=", mimeType: "image/png" } as const;

/** Drafts kept in a map, as `Threads` keeps them: one with nothing written is none. */
const kept = (entries: readonly (readonly [string, Draft])[] = []) => {
  const map = new Map(entries);
  const drafts: Drafts = {
    get: (key) => map.get(key),
    set: (key, draft) => void (draft === undefined || !unsent(draft) ? map.delete(key) : map.set(key, draft)),
  };
  return { map, drafts };
};

describe("unsent", () => {
  test("is text other than whitespace, or an image", () => {
    expect(unsent({ text: "hi", images: [] })).toBe(true);
    expect(unsent({ text: " \n", images: [] })).toBe(false);
    expect(unsent({ text: "", images: [image] })).toBe(true);
  });
});

describe("keepDraft", () => {
  test("keeps what the composer holds with the retry id the thread's draft had", () => {
    const { drafts } = kept([["t", { text: "old", images: [], requestId: "r1" }]]);
    keepDraft(drafts, "t", { text: "old", images: [image] }, false);
    expect(drafts.get("t")).toEqual({ text: "old", images: [image], requestId: "r1" });
    keepDraft(drafts, "u", { text: "new", images: [] }, false);
    expect(drafts.get("u")).toEqual({ text: "new", images: [] });
  });

  test("a sent prompt brought back is no draft: it drops the thread's", () => {
    const { map, drafts } = kept([["t", { text: "mine", images: [] }]]);
    keepDraft(drafts, "t", { text: "sent before", images: [] }, true);
    expect(map.has("t")).toBe(false);
  });
});

describe("dropRetry", () => {
  test("an edit makes the draft a new prompt: its request id goes, its content stays", () => {
    const { map, drafts } = kept([["t", { text: "a", images: [image], requestId: "r1" }]]);
    dropRetry(drafts, "t");
    expect(drafts.get("t")).toEqual({ text: "a", images: [image] });
    dropRetry(drafts, "none");
    expect(map.has("none")).toBe(false);
  });
});

describe("returned", () => {
  const sent: Draft = { text: "fix it", images: [image], requestId: "r1" };

  test("with nothing written since, the prompt comes back as it went, request id and all", () => {
    expect(returned(sent, undefined)).toBe(sent);
    expect(returned(sent, { text: "  ", images: [] })).toBe(sent);
  });

  test("ahead of what was written since, as a new prompt", () => {
    expect(returned(sent, { text: "and the docs", images: [other] })).toEqual({ text: "fix it\n\nand the docs", images: [image, other] });
  });

  test("leaves out empty text either side", () => {
    expect(returned({ text: "", images: [image], requestId: "r1" }, { text: "why", images: [] })).toEqual({ text: "why", images: [image] });
    expect(returned(sent, { text: "", images: [other] })).toEqual({ text: "fix it", images: [image, other] });
  });
});

describe("draftsOf", () => {
  test("reads a thread's draft as Threads has it now, and writes it through, none dropping it", () => {
    const written: [string, Draft | undefined][] = [];
    const drafts = draftsOf({
      draft: (key) => (key === "t" ? { text: "kept", images: [] } : undefined),
      setDraft: (key, draft) => void written.push([key, draft]),
    });
    expect(drafts.get("t")).toEqual({ text: "kept", images: [] });
    expect(drafts.get("u")).toBeUndefined();
    keepDraft(drafts, "t", { text: "kept more", images: [image] }, false);
    drafts.set("", undefined);
    expect(written).toEqual([
      ["t", { text: "kept more", images: [image] }],
      ["", undefined],
    ]);
  });
});

describe("lostOnReload", () => {
  test("is a draft's images, a send that did not get through, or one written with no thread shown; not text alone", () => {
    expect(lostOnReload("t", { text: "hi", images: [] })).toBe(false);
    expect(lostOnReload("t", { text: "hi", images: [image] })).toBe(true);
    expect(lostOnReload("t", { text: "hi", images: [], requestId: "r1" })).toBe(true);
    expect(lostOnReload("", { text: "hi", images: [] })).toBe(true);
    expect(lostOnReload("", { text: " ", images: [] })).toBe(false);
  });
});
