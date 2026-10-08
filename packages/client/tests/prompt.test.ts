import { describe, expect, test } from "vitest";
import { HostError } from "@lemma/contracts";
import type { AgentActivity, ChannelInfo, RuntimeEvent } from "@lemma/contracts";
import { follow } from "../src/follow.ts";
import type { Followable } from "../src/follow.ts";
import { startPrompt } from "../src/prompt.ts";
import type { PromptConnection } from "../src/prompt.ts";

interface Call {
  readonly id: string;
  readonly payload: { readonly requestId?: string; readonly whenBusy?: string };
  readonly resolve: (value?: unknown) => void;
  readonly reject: (error: Error) => void;
}

/**
 * A connection the test drives, connected throughout: the streams opened, the calls made and their replies, and the
 * host's events. Streams are followed with `follow`, as the web app's `Client` follows them.
 */
const fakeConnection = () => {
  const streams = new Set<{ readonly onElement: (element: AgentActivity) => void; readonly onEnd?: (error?: Error) => void }>();
  const calls: Call[] = [];
  const listeners = new Set<(event: RuntimeEvent) => void>();
  let opened = 0;
  const followable = {
    status: () => ({ state: "connected", generation: 1, attempts: 0 }),
    onStatus: (listener: (status: unknown) => void) => {
      listener({ state: "connected", generation: 1, attempts: 0 });
      return () => {};
    },
    onEvent: (listener: (event: RuntimeEvent) => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    channel: {
      open: (_channel: unknown, _payload: unknown, onElement: (element: AgentActivity) => void, onEnd?: (error?: Error) => void) => {
        opened++;
        const stream = { onElement, ...(onEnd === undefined ? {} : { onEnd }) };
        streams.add(stream);
        return () => void streams.delete(stream);
      },
    },
  } as unknown as Followable;
  const connection = {
    follow: (channel: never, payload: never, onElement: never, onEnd?: never) => follow(followable, channel, payload, onElement, onEnd),
    channel: {
      call: (channel: { readonly id: string }, payload: Call["payload"]) =>
        new Promise((resolve, reject) => calls.push({ id: channel.id, payload, resolve, reject })),
    },
  };
  return {
    connection: connection as unknown as PromptConnection,
    calls,
    streams,
    opened: () => opened,
    send: (activity: AgentActivity) => {
      for (const stream of streams) stream.onElement(activity);
    },
    /** Ends every open stream as the host would, with `error`; not one opened again as they end. */
    end: (error: Error) => {
      const ending = Array.from(streams);
      streams.clear();
      for (const stream of ending) stream.onEnd?.(error);
    },
    emit: (event: RuntimeEvent) => {
      for (const listener of listeners) listener(event);
    },
    listeners,
  };
};

/** Lets what the last step started run on: the fake answers at once, so a few turns of the microtask queue are enough. */
const tick = async () => {
  for (let turn = 0; turn < 20; turn++) await Promise.resolve();
};
const state = (promise: Promise<unknown>) =>
  Promise.race([
    promise.then(
      () => "resolved",
      () => "rejected",
    ),
    new Promise((resolve) => setTimeout(() => resolve("pending"), 5)),
  ]);
const withdrawn = (id: string) => new HostError({ code: "Withdrawn", subject: id, message: `"${id}" was withdrawn` });
const unserved = (id: string) => new HostError({ code: "NotFound", subject: id, message: `No channel "${id}"` });
const listed = (...ids: string[]): readonly ChannelInfo[] => ids.map((id) => ({ id, kind: "stream", source: "agent" }));

describe("startPrompt", () => {
  test("sends once agent.activity is subscribed, and is accepted when its session's turn starts, long before the turn ends", async () => {
    const fake = fakeConnection();
    const started = startPrompt(fake.connection, "s1", [{ type: "text", text: "hi" }]);
    await tick();
    expect(fake.streams.size).toBe(1);
    expect(fake.calls).toEqual([]);
    fake.send({ type: "subscribed", running: [] });
    await tick();
    expect(fake.calls.map((call) => [call.id, call.payload.requestId])).toEqual([["agent.prompt", started.requestId]]);
    fake.send({ type: "turn-started", sessionId: "other", turnId: "t0" });
    expect(await state(started.accepted)).toBe("pending");
    fake.send({ type: "turn-started", sessionId: "s1", turnId: "t1" });
    expect(await state(started.accepted)).toBe("resolved");
    // Taken: its activity is no longer needed.
    expect(fake.streams.size).toBe(0);
    expect(await state(started.done)).toBe("pending");
    fake.calls[0]!.resolve();
    expect(await state(started.done)).toBe("resolved");
    expect([fake.calls.length, fake.listeners.size]).toEqual([1, 0]);
  });

  test("is accepted when it is queued behind the running turn", async () => {
    const fake = fakeConnection();
    const queued = startPrompt(fake.connection, "s1", [{ type: "text", text: "next" }], undefined, { requestId: "r1", whenBusy: "follow-up" });
    expect(queued.requestId).toBe("r1");
    fake.send({ type: "subscribed", running: ["s1"] });
    await tick();
    expect(fake.calls[0]!.payload.whenBusy).toBe("follow-up");
    fake.send({ type: "queue-changed", sessionId: "s1", queue: [], revision: 1 });
    expect(await state(queued.accepted)).toBe("pending");
    fake.send({ type: "queue-changed", sessionId: "s1", queue: [{ requestId: "r1", content: [], mode: "follow-up", at: 1 }], revision: 2 });
    expect(await state(queued.accepted)).toBe("resolved");
  });

  test("a refused prompt rejects acceptance, so the caller keeps its input", async () => {
    const fake = fakeConnection();
    const started = startPrompt(fake.connection, "s1", [{ type: "text", text: "hi" }]);
    fake.send({ type: "subscribed", running: [] });
    await tick();
    fake.calls[0]!.reject(new HostError({ code: "Busy", subject: "s1", message: "Session s1 already has a turn in progress" }));
    await expect(started.accepted).rejects.toThrow("already has a turn");
    await expect(started.done).rejects.toThrow();
    expect([fake.streams.size, fake.listeners.size]).toEqual([0, 0]);
  });

  test("a turn that ends with no activity seen still counts as accepted, and a withdrawn prompt ends quietly", async () => {
    const fake = fakeConnection();
    const started = startPrompt(fake.connection, "s1", [{ type: "text", text: "hi" }]);
    fake.send({ type: "subscribed", running: [] });
    await tick();
    fake.calls[0]!.resolve();
    expect(await state(started.accepted)).toBe("resolved");
    const retracted = startPrompt(fake.connection, "s1", [{ type: "text", text: "later" }]);
    fake.send({ type: "subscribed", running: ["s1"] });
    await tick();
    fake.calls[1]!.reject(new HostError({ code: "Retracted", subject: "s1", message: "The prompt was withdrawn from the queue" }));
    expect([await state(retracted.accepted), await state(retracted.done)]).toEqual(["resolved", "resolved"]);
  });

  test("the agent reloading while it waits: the prompt is sent once, and its activity followed onto the replacement, where its acceptance is seen", async () => {
    const fake = fakeConnection();
    const started = startPrompt(fake.connection, "s1", [{ type: "text", text: "hi" }]);
    // Withdrawn before it was subscribed: opened again at once.
    fake.end(withdrawn("agent.activity"));
    await tick();
    expect(fake.opened()).toBe(2);
    fake.send({ type: "subscribed", running: [] });
    await tick();
    expect(fake.calls).toHaveLength(1);
    // The agent reloads, its replacement not listed yet: the activity waits for `channels-changed` to list it.
    fake.end(withdrawn("agent.activity"));
    await tick();
    fake.end(unserved("agent.activity"));
    await tick();
    fake.emit({ type: "channels-changed", channels: listed("agent.activity") });
    await tick();
    expect(fake.opened()).toBe(4);
    fake.send({ type: "subscribed", running: [] });
    fake.send({ type: "turn-started", sessionId: "s1", turnId: "t1" });
    expect(await state(started.accepted)).toBe("resolved");
    // The host made the call again on the replacement: this client sent it once.
    fake.calls[0]!.resolve();
    expect(await state(started.done)).toBe("resolved");
    expect([fake.calls.length, fake.streams.size, fake.listeners.size]).toEqual([1, 0, 0]);
  });

  test("a prompt still withdrawn is the host's answer: nothing answered it, and the client does not send it again", async () => {
    const fake = fakeConnection();
    const started = startPrompt(fake.connection, "s1", [{ type: "text", text: "hi" }]);
    fake.send({ type: "subscribed", running: [] });
    await tick();
    fake.calls[0]!.reject(withdrawn("agent.prompt"));
    await expect(started.done).rejects.toThrow("was withdrawn");
    await expect(started.accepted).rejects.toThrow("was withdrawn");
    expect([fake.calls.length, fake.streams.size, fake.listeners.size]).toEqual([1, 0, 0]);
  });

  test("with no agent to listen to, it is refused unsent", async () => {
    const fake = fakeConnection();
    const missing = startPrompt(fake.connection, "s1", [{ type: "text", text: "hi" }]);
    fake.end(unserved("agent.activity"));
    await expect(missing.accepted).rejects.toThrow("No channel");
    expect(fake.calls).toEqual([]);
    expect([fake.streams.size, fake.listeners.size]).toEqual([0, 0]);
  });
});
