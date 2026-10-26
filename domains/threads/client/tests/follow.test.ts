import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { AgentChannels } from "@lemma/agent";
import type { QueuedPrompt } from "@lemma/agent";
import { SessionChannels } from "@lemma/sessions";
import type { EventData, SessionEvent, SessionInfo } from "@lemma/sessions";
import { LEAVING_MS } from "@lemma/threads";
import { followOpen, PRELOAD_MS, QUEUE_LIMIT } from "../src/follow.ts";
import { browser, fakeClient, handle, info, rooted, settle } from "./fakes.ts";

const event = (seq: number, data: EventData): SessionEvent => ({ seq, id: `e${seq}`, parent: seq === 1 ? null : `e${seq - 1}`, at: seq, data });
const prompt = (seq: number, requestId: string): SessionEvent =>
  event(seq, { type: "message", turnId: "turn", requestId, message: { role: "user", content: [{ type: "text", text: requestId }], timestamp: 0 } });
const queued = (requestId: string): QueuedPrompt => ({ requestId, mode: "follow-up", content: [{ type: "text", text: requestId }], at: 0 });
const text = (index: number, delta: string, seq: number) => ({
  type: "delta",
  sessionId: "s1",
  turnId: "turn",
  stepId: "step",
  seq,
  event: { type: "text-delta", index, delta },
});

const setup = () => {
  browser();
  const plugin = handle();
  const host = fakeClient();
  const [activeId, setActiveId] = createSignal<string>();
  const [active, setActive] = createSignal<SessionInfo>();
  const open = rooted(() => followOpen(plugin.plugin, host.client, { activeId, active }));
  /** Opens thread `id`, as the address naming it does. */
  const show = (id: string | undefined, extra: Partial<SessionInfo> = {}) => {
    setActive(id === undefined ? undefined : info(id, extra));
    setActiveId(id);
  };
  return { plugin, host, open, show };
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the open thread", () => {
  it("follows its log from the last event it has, its branch to the leaf, and follows the next thread's in its place", async () => {
    const { host, open, show } = setup();
    show("s1");
    expect(open.log()).toEqual({ loaded: false });
    const [log] = host.open(SessionChannels.log.id);
    expect(log!.payload()).toEqual({ sessionId: "s1", after: 0 });
    log!.push({ type: "subscribed", events: [event(1, { type: "title", title: "a" })] });
    log!.push({ type: "appended", event: event(2, { type: "title", title: "b" }) });
    expect(open.log()).toEqual({ loaded: true });
    expect(open.branch().map((each) => each.id)).toEqual(["e1", "e2"]);
    await open.opened();
    // Opened again (a reconnect), it asks for what came after the last event it has.
    expect(log!.payload()).toEqual({ sessionId: "s1", after: 2 });
    show("s2");
    expect(log!.closed).toBe(true);
    expect(open.branch()).toEqual([]);
    expect(host.open(SessionChannels.log.id).map((stream) => stream.payload())).toEqual([{ sessionId: "s2", after: 0 }]);
    expect(host.open(AgentChannels.output.id).map((stream) => stream.payload())).toEqual([{ sessionId: "s2" }]);
  });

  it("says what ends its log, unless following it carries on by itself", () => {
    const { host, open, show } = setup();
    show("s1");
    const [log] = host.open(SessionChannels.log.id);
    log!.end(new Error("connection lost"));
    expect(open.log()).toEqual({ loaded: false });
  });

  it("opens with a log preloaded while it was fresh", async () => {
    const { host, open, show } = setup();
    host.answer(SessionChannels.events.id, () => [event(1, { type: "title", title: "early" })]);
    open.preload("s1");
    open.preload("s1");
    expect(host.made(SessionChannels.events.id)).toEqual([{ sessionId: "s1" }]);
    show("s1");
    await settle();
    expect(open.branch().map((each) => each.id)).toEqual(["e1"]);
    expect(host.open(SessionChannels.log.id)[0]!.payload()).toEqual({ sessionId: "s1", after: 1 });
    // Once stale, a preload is not used: the log is read whole.
    open.preload("s2");
    vi.advanceTimersByTime(PRELOAD_MS);
    show("s2");
    await settle();
    expect(open.branch()).toEqual([]);
  });

  it("applies the model's output once a frame, at once past the queue limit, and goes on from the agent's view", () => {
    const { host, open, show } = setup();
    show("s1");
    const [output] = host.open(AgentChannels.output.id);
    output!.push({
      type: "subscribed",
      view: {
        turnId: "turn",
        draft: { stepId: "step", seq: 1, blocks: [{ index: 0, block: { type: "text", text: "Hel" } }] },
        output: [],
        queue: [],
        queueRevision: 0,
      },
    });
    expect(open.live().drafts[0]!.blocks[0]).toEqual({ kind: "text", text: "Hel" });
    // A delta the view already holds is skipped; the next waits for a frame.
    output!.push(text(0, "Hel", 1));
    output!.push(text(0, "lo", 2));
    expect(open.live().drafts[0]!.blocks[0]).toEqual({ kind: "text", text: "Hel" });
    vi.advanceTimersByTime(16);
    expect(open.live().drafts[0]!.blocks[0]).toEqual({ kind: "text", text: "Hello" });
    for (let seq = 3; seq < 3 + QUEUE_LIMIT; seq++) output!.push(text(0, ".", seq));
    expect((open.live().drafts[0]!.blocks[0] as { readonly text: string }).text).toHaveLength(5 + QUEUE_LIMIT);
    // The turn ended, as the agent said: nothing more streams for it.
    open.turnEnded("turn");
    expect(open.live().drafts).toEqual([]);
  });

  it("keeps a prompt that left the queue waiting until the log places it, or a while; one withdrawn here goes at once", () => {
    const { host, open, show } = setup();
    show("s1");
    const [log] = host.open(SessionChannels.log.id);
    log!.push({ type: "subscribed", events: [] });
    open.reportQueue({ queue: [queued("a"), queued("b"), queued("c")], revision: 1 });
    // An older report changes nothing.
    open.reportQueue({ queue: [], revision: 0 });
    expect(open.queue().map((each) => each.requestId)).toEqual(["a", "b", "c"]);
    open.withdrawing("c");
    open.reportQueue({ queue: [], revision: 2 });
    expect(open.queue().map((each) => each.requestId)).toEqual(["a", "b"]);
    log!.push({ type: "appended", event: prompt(1, "a") });
    expect(open.queue().map((each) => each.requestId)).toEqual(["b"]);
    vi.advanceTimersByTime(LEAVING_MS);
    expect(open.queue()).toEqual([]);
  });
});
