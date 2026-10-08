import { describe, expect, test } from "vitest";
import { HostError } from "@lemma/contracts";
import type { AgentActivity, ChannelInfo } from "@lemma/contracts";
import { startPrompt } from "../src/prompt.ts";
import type { PromptConnection } from "../src/prompt.ts";

interface Call {
  readonly id: string;
  readonly payload: { readonly requestId?: string; readonly whenBusy?: string };
  readonly resolve: (value?: unknown) => void;
  readonly reject: (error: Error) => void;
}

/** A connection the test drives: the streams opened, the calls made and their replies, and the host's events. */
const fakeConnection = () => {
  const streams = new Set<{ readonly onElement: (element: AgentActivity) => void; readonly onEnd?: (error?: Error) => void }>();
  const calls: Call[] = [];
  const listeners = new Set<(event: { readonly type: string; readonly channels?: readonly ChannelInfo[] }) => void>();
  const connection = {
    channel: {
      open: (_channel: unknown, _payload: unknown, onElement: (element: AgentActivity) => void, onEnd?: (error?: Error) => void) => {
        const stream = { onElement, ...(onEnd === undefined ? {} : { onEnd }) };
        streams.add(stream);
        return () => void streams.delete(stream);
      },
      call: (channel: { readonly id: string }, payload: Call["payload"]) =>
        new Promise((resolve, reject) => calls.push({ id: channel.id, payload, resolve, reject })),
    },
    onEvent: (listener: (event: { readonly type: string; readonly channels?: readonly ChannelInfo[] }) => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  return {
    connection: connection as unknown as PromptConnection,
    calls,
    streams,
    send: (activity: AgentActivity) => {
      for (const stream of streams) stream.onElement(activity);
    },
    /** Ends every open stream as the host would, with `error`. */
    end: (error: Error) => {
      for (const stream of streams) {
        streams.delete(stream);
        stream.onEnd?.(error);
      }
    },
    emit: (event: { readonly type: string; readonly channels?: readonly ChannelInfo[] }) => {
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
const listed = (...ids: string[]): readonly ChannelInfo[] => ids.map((id) => ({ id, kind: "call", source: "agent" }));

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
    // The agent reloads while the turn runs: sent again at once, without listening again.
    fake.calls[0]!.reject(withdrawn("agent.prompt"));
    await tick();
    expect([fake.streams.size, fake.calls.length]).toEqual([0, 2]);
    fake.calls[1]!.resolve();
    expect(await state(started.done)).toBe("resolved");
    expect(fake.listeners.size).toBe(0);
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
    expect(fake.streams.size).toBe(0);
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

  test("withdrawn while it waits, it is sent again with the same id once the agent answers, listening afresh first", async () => {
    const fake = fakeConnection();
    const started = startPrompt(fake.connection, "s1", [{ type: "text", text: "hi" }]);
    fake.send({ type: "subscribed", running: [] });
    await tick();
    // The agent reloads: its stream and the call both end, and the replacement answers at once.
    fake.end(withdrawn("agent.activity"));
    fake.calls[0]!.reject(withdrawn("agent.prompt"));
    await tick();
    expect(fake.streams.size).toBe(1);
    expect(fake.calls).toHaveLength(1);
    fake.send({ type: "subscribed", running: ["s1"] });
    await tick();
    expect(fake.calls.map((call) => call.payload.requestId)).toEqual([started.requestId, started.requestId]);
    // This time the replacement is not listed yet: the call waits for `channels-changed` to list the agent's channels.
    fake.end(withdrawn("agent.activity"));
    fake.calls[1]!.reject(withdrawn("agent.prompt"));
    await tick();
    fake.end(new HostError({ code: "NotFound", subject: "agent.activity", message: 'No channel "agent.activity"' }));
    await tick();
    expect(fake.calls).toHaveLength(2);
    fake.emit({ type: "channels-changed", channels: listed("agent.prompt") });
    await tick();
    expect(fake.streams.size).toBe(0);
    fake.emit({ type: "channels-changed", channels: listed("agent.prompt", "agent.activity") });
    await tick();
    fake.send({ type: "subscribed", running: ["s1"] });
    await tick();
    expect(fake.calls).toHaveLength(3);
    expect(fake.calls[2]!.payload.requestId).toBe(started.requestId);
    fake.calls[2]!.resolve();
    expect(await state(started.done)).toBe("resolved");
    expect([fake.streams.size, fake.listeners.size]).toEqual([0, 0]);
  });

  test("withdrawn, it waits for the agent's channels only while they are not served: a NotFound naming its session fails at once", async () => {
    const fake = fakeConnection();
    const started = startPrompt(fake.connection, "s1", [{ type: "text", text: "hi" }]);
    fake.send({ type: "subscribed", running: [] });
    await tick();
    fake.calls[0]!.reject(withdrawn("agent.prompt"));
    await tick();
    fake.send({ type: "subscribed", running: [] });
    await tick();
    // The replacement answers, and the session is gone meanwhile: no listing of the agent's channels changes that.
    fake.calls[1]!.reject(new HostError({ code: "NotFound", subject: "s1", message: 'No session "s1"' }));
    await expect(started.done).rejects.toThrow('No session "s1"');
    await expect(started.accepted).rejects.toThrow('No session "s1"');
    expect([fake.streams.size, fake.listeners.size]).toEqual([0, 0]);
  });

  test("with no agent to listen to, it is refused unsent", async () => {
    const fake = fakeConnection();
    const missing = startPrompt(fake.connection, "s1", [{ type: "text", text: "hi" }]);
    fake.end(new HostError({ code: "NotFound", subject: "agent.activity", message: 'No channel "agent.activity"' }));
    await expect(missing.accepted).rejects.toThrow("No channel");
    expect(fake.calls).toEqual([]);
  });
});
