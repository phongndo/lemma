import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import type { SessionInfo } from "@lemma/sessions";
import { createDrafts, DRAFTS_KEY, SAVE_MS } from "../src/drafts.ts";
import { browser, handle, info, rooted } from "./fakes.ts";

const image = { type: "image", data: "aGk=", mimeType: "image/png" } as const;

const setup = (threads: readonly SessionInfo[] = [info("t1"), info("t2")]) => {
  const page = browser();
  const plugin = handle();
  const [list, setList] = createSignal(threads);
  const [loaded, setLoaded] = createSignal(false);
  const store = rooted(() => createDrafts(plugin.plugin, { list, loaded }));
  const stored = () => JSON.parse(page.local.get(DRAFTS_KEY) ?? "{}") as Record<string, string>;
  return { page, plugin, store, setList, setLoaded, stored };
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the drafts", () => {
  it("hold a draft at once, and tell lists at once of one gained or lost, and of its text a moment after the last change", () => {
    const { store } = setup();
    store.setDraft("t1", { text: "a", images: [] });
    expect(store.draft("t1")).toEqual({ text: "a", images: [] });
    expect(store.drafts().get("t1")?.text).toBe("a");
    store.setDraft("t1", { text: "ab", images: [] });
    expect(store.draft("t1")?.text).toBe("ab");
    expect(store.drafts().get("t1")?.text).toBe("a");
    vi.advanceTimersByTime(SAVE_MS);
    expect(store.drafts().get("t1")?.text).toBe("ab");
    // Nothing written is no draft.
    store.setDraft("t1", { text: "  ", images: [] });
    expect(store.draft("t1")).toBeUndefined();
    expect(store.drafts().has("t1")).toBe(false);
  });

  it("write their text to the browser a moment after the last change, into what another tab stored", () => {
    const { page, store, stored } = setup();
    page.local.set(DRAFTS_KEY, JSON.stringify({ elsewhere: "theirs" }));
    store.setDraft("t1", { text: "mine", images: [image], requestId: "r1" });
    expect(stored()).toEqual({ elsewhere: "theirs" });
    vi.advanceTimersByTime(SAVE_MS);
    expect(stored()).toEqual({ elsewhere: "theirs", t1: "mine" });
    store.setDraft("t1", undefined);
    // As the page goes, what is not written yet is.
    window.dispatchEvent(new Event("pagehide"));
    expect(stored()).toEqual({ elsewhere: "theirs" });
  });

  it("keep images, a retry's request id, and the new-thread page's draft while the page lasts, storing none of them", () => {
    const { store, stored } = setup();
    store.setDraft("", { text: "before the thread is there", images: [] });
    store.setDraft("t1", { text: "again", images: [image], requestId: "r1" });
    expect(store.drafts().get("")?.text).toBe("before the thread is there");
    expect(store.draft("t1")).toEqual({ text: "again", images: [image], requestId: "r1" });
    vi.advanceTimersByTime(SAVE_MS);
    expect(stored()).toEqual({ t1: "again" });
    // An edit drops the request id: a change lists hear of.
    store.setDraft("t1", { text: "again", images: [image] });
    expect(store.draft("t1")).toEqual({ text: "again", images: [image] });
  });

  it("come back from the browser, and follow another tab's saves for the threads this one has not changed since", () => {
    const { page } = setup();
    page.local.set(DRAFTS_KEY, JSON.stringify({ t1: "kept" }));
    const plugin = handle();
    const [list] = createSignal([info("t1"), info("t2"), info("t3")]);
    const store = rooted(() => createDrafts(plugin.plugin, { list, loaded: () => true }));
    expect(store.draft("t1")).toEqual({ text: "kept", images: [] });
    store.setDraft("t2", { text: "pasted", images: [image] });
    store.setDraft("t3", { text: "typing", images: [] });
    store.setDraft("", { text: "new", images: [] });
    // Another tab saved: t1 changed, t2 dropped (its image here stays), t3 is this tab's own change, not saved yet.
    page.otherTab(DRAFTS_KEY, { t1: "theirs" });
    expect(store.drafts().get("t1")).toEqual({ text: "theirs", images: [] });
    expect(store.draft("t2")?.images).toEqual([image]);
    expect(store.draft("t3")?.text).toBe("typing");
    expect(store.draft("")?.text).toBe("new");
    page.otherTab(DRAFTS_KEY, undefined);
    expect(store.draft("t1")).toBeUndefined();
  });

  it("drop a deleted thread's once the list is in, but not the new-thread page's", () => {
    const { store, setList, setLoaded } = setup();
    store.setDraft("t1", { text: "a", images: [] });
    store.setDraft("t2", { text: "b", images: [] });
    store.setDraft("", { text: "c", images: [] });
    setList([info("t1")]);
    expect(store.draft("t2")?.text).toBe("b");
    setLoaded(true);
    expect([...store.drafts().keys()].sort()).toEqual(["", "t1"]);
  });
});
