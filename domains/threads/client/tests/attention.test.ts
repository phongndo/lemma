import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { ThreadWaits } from "@lemma/threads";
import type { ThreadWait } from "@lemma/threads";
import type { SlotsService } from "@lemma/web";
import { createAttention, UNSEEN_KEY } from "../src/attention.ts";
import { browser, handle, info, rooted } from "./fakes.ts";

const setup = (options: { readonly looking?: boolean } = {}) => {
  const page = browser();
  if (options.looking === false) page.look(false);
  const plugin = handle();
  const [list, setList] = createSignal([info("t1"), info("t2")]);
  const [loaded, setLoaded] = createSignal(true);
  const [running, setRunning] = createSignal<readonly string[]>([]);
  const [activeId, setActiveId] = createSignal<string>();
  const [waits, setWaits] = createSignal<readonly ThreadWait[]>([]);
  const slots = { list: (slot: unknown) => (slot === ThreadWaits ? waits() : []) } as unknown as SlotsService;
  const store = rooted(() => createAttention(plugin.plugin, slots, { list, loaded, running, activeId }));
  const stored = () => JSON.parse(page.local.get(UNSEEN_KEY) ?? "{}") as Record<string, { readonly reason: string }>;
  const state = (id: string) => store.attention().get(id)?.state;
  return { page, store, setList, setLoaded, setRunning, setActiveId, setWaits, stored, state };
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("attention", () => {
  it("keeps a turn's end unseen, in the browser too, until its thread shows to a person looking", () => {
    const { page, store, setActiveId, stored, state } = setup({ looking: false });
    store.turnEnded("t1", "done");
    store.turnEnded("t2", "error");
    expect([state("t1"), state("t2")]).toEqual(["done", "failed"]);
    expect(Object.keys(stored()).sort()).toEqual(["t1", "t2"]);
    setActiveId("t1");
    expect(state("t1")).toBe("done");
    page.look(true);
    expect(state("t1")).toBeUndefined();
    expect(Object.keys(stored())).toEqual(["t2"]);
    store.markSeen();
    expect(store.attention().size).toBe(0);
    expect(page.local.has(UNSEEN_KEY)).toBe(false);
  });

  it("sees at once an end in the thread shown to a person looking; a cancelled turn leaves nothing", () => {
    const { store, setActiveId, state } = setup();
    setActiveId("t1");
    store.turnEnded("t1", "done");
    store.turnEnded("t2", "cancelled");
    expect([state("t1"), state("t2")]).toEqual([undefined, undefined]);
  });

  it("hears another tab's ends for the threads this page lists, and sees here what it saw", () => {
    const { page, store, state } = setup({ looking: false });
    page.otherTab(UNSEEN_KEY, { t1: { reason: "done", at: 5 }, elsewhere: { reason: "done", at: 6 } });
    expect(state("t1")).toBe("done");
    expect(store.attention().has("elsewhere")).toBe(false);
    page.otherTab(UNSEEN_KEY, { elsewhere: { reason: "done", at: 6 } });
    expect(state("t1")).toBeUndefined();
  });

  it("takes up the ends kept for its threads once the list is in, and drops a deleted thread's", () => {
    const { page } = setup({ looking: false });
    page.local.set(UNSEEN_KEY, JSON.stringify({ t1: { reason: "max-steps", at: 5 }, gone: { reason: "done", at: 6 } }));
    const plugin = handle();
    const [list, setList] = createSignal([info("t1"), info("gone")]);
    const [loaded, setLoaded] = createSignal(false);
    const slots = { list: () => [] } as unknown as SlotsService;
    const store = rooted(() => createAttention(plugin.plugin, slots, { list, loaded, running: () => [], activeId: () => undefined }));
    expect(store.attention().size).toBe(0);
    setLoaded(true);
    expect(store.attention().get("t1")).toMatchObject({ state: "failed", label: "Out of steps" });
    setList([info("t1")]);
    expect(store.attention().has("gone")).toBe(false);
    expect(Object.keys(JSON.parse(page.local.get(UNSEEN_KEY)!))).toEqual(["t1"]);
  });

  it("is working while a turn runs, since this page saw it start; a turn that stops unheard ended, unseen", () => {
    const { store, setRunning, state } = setup({ looking: false });
    vi.setSystemTime(1000);
    setRunning(["t1", "t2"]);
    vi.setSystemTime(2000);
    expect(store.attention().get("t1")).toEqual({ state: "working", label: "Working", since: 1000 });
    // t1's end was heard; t2 stopped with none heard.
    store.turnEnded("t1", "done");
    setRunning([]);
    expect([state("t1"), state("t2")]).toEqual(["done", "done"]);
    // A prompt sent starts a turn whose end is the one to hear: its stopping unheard is an end again.
    store.turnStarted("t1");
    store.sent("t1");
    setRunning(["t1"]);
    setRunning([]);
    expect(state("t1")).toBe("done");
  });

  it("puts what a thread waits on the person for above its turn, from the first wait that says", () => {
    const { setRunning, setWaits, store } = setup();
    setRunning(["t1"]);
    setWaits([{ waiting: (id) => (id === "t1" ? "Needs input" : undefined) }]);
    expect(store.attention().get("t1")).toMatchObject({ state: "waiting", label: "Needs input" });
  });
});
