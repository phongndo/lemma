import { describe, expect, it } from "vitest";
import { HostError } from "@lemma/contracts";
import type { ChannelDeclaration, RuntimeEvent } from "@lemma/contracts";
import { follow } from "../src/follow.ts";
import type { Followable } from "../src/follow.ts";
import type { ConnectionStatus } from "../src/host.ts";

/** A stream opened on the fake connection. */
interface Opened {
  readonly id: string;
  readonly payload: unknown;
  readonly send: (element: unknown) => void;
  /** Ends it as the host would. */
  readonly end: (error?: Error) => void;
  closed: boolean;
}

/** A connection the test drives: its status, its events, and the streams opened on it. */
const fakeConnection = () => {
  let status: ConnectionStatus = { state: "connected", generation: 1, attempts: 0 };
  const statusListeners = new Set<(status: ConnectionStatus) => void>();
  const eventListeners = new Set<(event: RuntimeEvent) => void>();
  const opened: Opened[] = [];
  const connection: Followable = {
    status: () => status,
    onStatus: (listener) => {
      statusListeners.add(listener);
      listener(status);
      return () => void statusListeners.delete(listener);
    },
    onEvent: (listener) => {
      eventListeners.add(listener);
      return () => void eventListeners.delete(listener);
    },
    channel: {
      open: ((target: string | ChannelDeclaration, payload: unknown, onElement: (element: unknown) => void, onEnd?: (error?: Error) => void) => {
        const stream: Opened = {
          id: typeof target === "string" ? target : target.id,
          payload,
          send: (element) => !stream.closed && onElement(element),
          end: (error) => {
            if (stream.closed) return;
            stream.closed = true;
            onEnd?.(error);
          },
          closed: false,
        };
        opened.push(stream);
        return () => void (stream.closed = true);
      }) as Followable["channel"]["open"],
    },
  };
  return {
    connection,
    opened,
    setStatus: (next: Partial<ConnectionStatus>) => {
      status = { ...status, ...next };
      for (const listener of statusListeners) listener(status);
    },
    emit: (event: RuntimeEvent) => {
      for (const listener of eventListeners) listener(event);
    },
    listeners: () => statusListeners.size + eventListeners.size,
  };
};

const withdrawn = new HostError({ code: "Withdrawn", subject: "test.feed", message: "withdrawn" });
const notFound = new HostError({ code: "NotFound", subject: "test.feed", message: "none" });
const listing: RuntimeEvent = { type: "channels-changed", channels: [{ id: "test.feed", kind: "stream", source: "x" }] };

describe("follow", () => {
  it("opens a stream while connected, again on a new connection and when withdrawn, and once listed after nothing served it", () => {
    const fake = fakeConnection();
    fake.setStatus({ state: "reconnecting" });
    const elements: unknown[] = [];
    const ends: (string | undefined)[] = [];
    let after = 0;
    const close = follow(
      fake.connection,
      "test.feed",
      () => ({ after }),
      (element) => void elements.push(element),
      (error) => void ends.push(error instanceof HostError ? error.code : error?.message),
    );
    expect(fake.opened).toEqual([]);
    fake.setStatus({ state: "connected", generation: 2 });
    expect(fake.opened.map((stream) => [stream.id, stream.payload])).toEqual([["test.feed", { after: 0 }]]);
    fake.opened[0]!.send("a");
    after = 1;
    // Its plugin reloads: opened again at once, from where its reader is.
    fake.opened[0]!.end(withdrawn);
    expect(fake.opened.map((stream) => stream.payload)).toEqual([{ after: 0 }, { after: 1 }]);
    // The replacement is not there yet: it waits for a `channels-changed` that lists it.
    fake.opened[1]!.end(notFound);
    fake.emit({ type: "channels-changed", channels: [{ id: "other", kind: "stream", source: "x" }] });
    expect(fake.opened).toHaveLength(2);
    fake.emit(listing);
    expect(fake.opened).toHaveLength(3);
    fake.opened[2]!.send("b");
    // A channels-changed while it is open, and an element from a stream it left, change nothing.
    fake.emit(listing);
    fake.opened[0]!.send("stale");
    expect(fake.opened).toHaveLength(3);
    // The connection drops and comes back: the stream it had is replaced by a new one.
    fake.setStatus({ state: "reconnecting" });
    fake.opened[2]!.end(new Error("Error in socket"));
    fake.setStatus({ state: "connected", generation: 3 });
    expect(fake.opened).toHaveLength(4);
    expect(elements).toEqual(["a", "b"]);
    expect(ends).toEqual(["Withdrawn", "NotFound", "Error in socket"]);
    close();
    expect(fake.opened[3]!.closed).toBe(true);
    fake.setStatus({ state: "connected", generation: 4 });
    expect(fake.opened).toHaveLength(4);
    expect(fake.listeners()).toBe(0);
  });

  it("opens a stream again at once when the listing that names it crossed the failed opening", () => {
    const fake = fakeConnection();
    const close = follow(fake.connection, "test.feed", undefined, () => {});
    // Its plugin is replaced: the opening made at once finds nothing, but the replacement is listed before that is heard.
    fake.opened[0]!.end(withdrawn);
    fake.emit(listing);
    expect(fake.opened).toHaveLength(2);
    fake.opened[1]!.end(notFound);
    expect(fake.opened).toHaveLength(3);
    // Once the stream has sent something, a listing heard before or since says nothing about how it ends: it waits for the next.
    fake.emit(listing);
    fake.opened[2]!.send("subscribed");
    fake.emit(listing);
    fake.opened[2]!.end(notFound);
    expect(fake.opened).toHaveLength(3);
    fake.emit(listing);
    expect(fake.opened).toHaveLength(4);
    close();
  });

  it("stops following when closed from its onEnd, as one that gives up on an ending does", () => {
    const fake = fakeConnection();
    const close = follow(
      fake.connection,
      "test.feed",
      undefined,
      () => {},
      (error) => {
        if (error instanceof HostError && error.code === "Failed") close();
      },
    );
    fake.opened[0]!.end(new HostError({ code: "Failed", subject: "test.feed", message: "broken" }));
    fake.emit(listing);
    fake.setStatus({ state: "connected", generation: 2 });
    expect(fake.opened).toHaveLength(1);
    expect(fake.listeners()).toBe(0);
  });
});
