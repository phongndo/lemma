import { describe, expect, it, vi } from "vitest";
import type { ConnectionStatus } from "@lemma/client";
import { HostError } from "@lemma/contracts";
import type { ChannelDeclaration, HostEvent, HostInfo, InteractionRequest, PluginStatus } from "@lemma/contracts";
import { createClient } from "../src/runtime/client.ts";
import { createHostPlugins } from "../src/runtime/host-plugins.ts";
import { createInteractions } from "../src/runtime/interactions.ts";
import { createNotify } from "../src/runtime/notify.ts";
import type { HostConnection } from "../src/ui/runtime.ts";

/** A stream the client opened on the fake connection. */
interface Opened {
  readonly id: string;
  readonly payload: unknown;
  readonly send: (element: unknown) => void;
  /** Ends it as the host would. */
  readonly end: (error?: Error) => void;
  closed: boolean;
}

/** A host connection the test drives: its status, its events, the replies its calls get, and the streams opened on it. */
const fakeHost = () => {
  let status: ConnectionStatus = { state: "connected", generation: 1, attempts: 0 };
  const statusListeners = new Set<(status: ConnectionStatus) => void>();
  const eventListeners = new Set<(event: HostEvent) => void>();
  const calls: unknown[][] = [];
  const info: HostInfo = { version: "0", cwd: "/work", home: "/home", composition: { id: "c", plugins: [] }, runtime: ["lemma/Paths"] };
  let plugins: readonly PluginStatus[] = [];
  /** Each `interaction.list` call's reply, resolved by the test. */
  const lists: ((requests: readonly InteractionRequest[]) => void)[] = [];
  const opened: Opened[] = [];
  const host = {
    channel: {
      open: (target: string | ChannelDeclaration, payload: unknown, onElement: (element: unknown) => void, onEnd?: (error?: Error) => void) => {
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
      },
    },
    status: () => status,
    onStatus: (listener: (status: ConnectionStatus) => void) => {
      statusListeners.add(listener);
      listener(status);
      return () => void statusListeners.delete(listener);
    },
    onEvent: (listener: (event: HostEvent) => void) => {
      eventListeners.add(listener);
      return () => void eventListeners.delete(listener);
    },
    host: {
      info: async () => (calls.push(["info"]), info),
      plugins: async () => (calls.push(["plugins"]), plugins),
      configure: async (rows: unknown, options: unknown) => (calls.push(["configure", rows, options]), { started: [], restarted: [], stopped: [] }),
    },
    interaction: {
      list: () => new Promise<readonly InteractionRequest[]>((resolve) => lists.push(resolve)),
      answer: async (id: string, answer: unknown) => void calls.push(["answer", id, answer]),
      dismiss: async (id: string) => void calls.push(["dismiss", id]),
    },
  };
  return {
    host: host as unknown as HostConnection,
    calls,
    lists,
    opened,
    setPlugins: (next: readonly PluginStatus[]) => void (plugins = next),
    setStatus: (next: Partial<ConnectionStatus>) => {
      status = { ...status, ...next };
      for (const listener of statusListeners) listener(status);
    },
    emit: (event: HostEvent) => {
      for (const listener of eventListeners) listener(event);
    },
    listeners: () => statusListeners.size + eventListeners.size,
  };
};

const confirm = (id: string): InteractionRequest => ({ type: "confirm", id, title: `Question ${id}` });
const plugin = (id: string, fields: Partial<PluginStatus> = {}): PluginStatus => ({
  id,
  source: "bundled",
  enabled: true,
  state: "active",
  provides: [],
  requires: [],
  ...fields,
});

describe("createClient", () => {
  it("resyncs now and on each new connection, once per generation, and one failing resync leaves the others", async () => {
    const fake = fakeHost();
    const { client, dispose } = createClient(fake.host);
    const synced: string[] = [];
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    client.onConnect(() => {
      throw new Error("broken model");
    });
    const stop = client.onConnect(() => void synced.push("a"));
    expect(synced).toEqual(["a"]);
    await vi.waitFor(() => expect(client.info()?.runtime).toEqual(["lemma/Paths"]));
    fake.setStatus({ state: "reconnecting" });
    expect(client.connected()).toBe(false);
    fake.setStatus({ state: "connected", generation: 2 });
    // The same connection again is no new one.
    fake.setStatus({ state: "connected", generation: 2 });
    expect(synced).toEqual(["a", "a"]);
    expect(errors).toHaveBeenCalledTimes(2);
    stop();
    fake.setStatus({ state: "connected", generation: 3 });
    expect(synced).toEqual(["a", "a"]);
    expect(fake.calls.filter(([call]) => call === "info")).toHaveLength(3);
    dispose();
    expect(fake.listeners()).toBe(0);
    errors.mockRestore();
  });

  it("passes on the host's own events only: each subsystem streams its own", () => {
    const fake = fakeHost();
    const { client } = createClient(fake.host);
    const heard: string[] = [];
    const stop = client.onEvent((event) => void heard.push(event.type));
    fake.emit({ type: "plugins-changed", plugins: [] });
    fake.emit({ type: "models-changed" });
    fake.emit({ type: "turn-started", sessionId: "s", turnId: "t" });
    fake.emit({ type: "channels-changed", channels: [] });
    expect(heard).toEqual(["plugins-changed", "channels-changed"]);
    stop();
  });

  it("follows a stream: opened while connected, again after a reconnect and when withdrawn, and once listed after nothing served it", () => {
    const fake = fakeHost();
    fake.setStatus({ state: "reconnecting" });
    const { client } = createClient(fake.host);
    const elements: unknown[] = [];
    const ends: (string | undefined)[] = [];
    let after = 0;
    const close = client.follow(
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
    fake.opened[0]!.end(new HostError({ code: "Withdrawn", subject: "test.feed", message: "withdrawn" }));
    expect(fake.opened.map((stream) => stream.payload)).toEqual([{ after: 0 }, { after: 1 }]);
    // The replacement is not there yet: it waits for a `channels-changed` that lists it.
    fake.opened[1]!.end(new HostError({ code: "NotFound", subject: "test.feed", message: "none" }));
    fake.emit({ type: "channels-changed", channels: [{ id: "other", kind: "stream", source: "x" }] });
    expect(fake.opened).toHaveLength(2);
    fake.emit({ type: "channels-changed", channels: [{ id: "test.feed", kind: "stream", source: "x" }] });
    expect(fake.opened).toHaveLength(3);
    fake.opened[2]!.send("b");
    // A channels-changed while it is open, and an element from a stream it left, change nothing.
    fake.emit({ type: "channels-changed", channels: [{ id: "test.feed", kind: "stream", source: "x" }] });
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
    expect(fake.listeners()).toBe(1);
  });

  it("opens a stream again at once when the listing that names it crossed the failed opening", () => {
    const fake = fakeHost();
    const { client } = createClient(fake.host);
    const withdrawn = new HostError({ code: "Withdrawn", subject: "test.feed", message: "withdrawn" });
    const notFound = new HostError({ code: "NotFound", subject: "test.feed", message: "none" });
    const listing: HostEvent = { type: "channels-changed", channels: [{ id: "test.feed", kind: "stream", source: "x" }] };
    const close = client.follow("test.feed", undefined, () => {});
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
});

describe("createNotify", () => {
  it("keeps the app's messages and the host's notices until dismissed, and leaves showing them to a plugin", () => {
    const fake = fakeHost();
    const { client } = createClient(fake.host);
    const { notify, dispose } = createNotify(client);
    const first = notify.toast({ level: "info", message: "saved" });
    fake.emit({
      type: "notice",
      notice: { level: "warning", message: "open this", links: [{ url: "https://example.com" }], origin: "login:x", kind: "sign-in" },
    });
    notify.report(new Error("boom"), "Sync failed");
    expect(notify.toasts()).toEqual([
      { id: first, level: "info", message: "saved" },
      { id: first + 1, level: "warning", message: "open this", links: [{ url: "https://example.com" }], origin: "login:x", kind: "sign-in" },
      { id: first + 2, level: "error", message: "Sync failed: boom" },
    ]);
    notify.dismiss(first);
    notify.dismissWhere((toast) => toast.origin === "login:x");
    expect(notify.toasts().map((toast) => toast.message)).toEqual(["Sync failed: boom"]);
    // With nothing dismissing them, the latest 50 stay.
    for (let index = 0; index < 60; index++) notify.toast({ level: "info", message: `m${index}` });
    expect(notify.toasts()).toHaveLength(50);
    expect(notify.toasts()[0]?.message).toBe("m10");
    dispose();
    fake.emit({ type: "notice", notice: { level: "info", message: "unheard" } });
    expect(notify.toasts().at(-1)?.message).toBe("m59");
  });

  it("claims messages for a view of their own, each claim released alone", () => {
    const { notify } = createNotify(createClient(fakeHost().host).client);
    const login = notify.toast({ level: "info", message: "code", code: "ABCD", origin: "login:x" });
    const plain = notify.toast({ level: "info", message: "plain" });
    const byId = (id: number) => notify.toasts().find((toast) => toast.id === id)!;
    const release = notify.claim((toast) => toast.origin === "login:x");
    const again = notify.claim((toast) => toast.origin === "login:x");
    expect([notify.claimed(byId(login)), notify.claimed(byId(plain))]).toEqual([true, false]);
    release();
    expect(notify.claimed(byId(login))).toBe(true);
    again();
    expect(notify.claimed(byId(login))).toBe(false);
  });
});

describe("createInteractions", () => {
  it("follows questions asked and closed, reads the ones waiting on each connection, and drops them while reconnecting", async () => {
    const fake = fakeHost();
    const { client } = createClient(fake.host);
    const { notify } = createNotify(client);
    const { interactions, dispose } = createInteractions(fake.host, client, notify);
    const ids = () => interactions.open().map((request) => request.id);
    fake.emit({ type: "interaction", request: confirm("a") });
    // The first connection's list is on its way; "b" closes before it arrives, so the reply cannot bring it back.
    fake.emit({ type: "interaction", request: confirm("b") });
    fake.emit({ type: "interaction-closed", id: "b" });
    fake.lists[0]!([confirm("waiting"), confirm("a"), confirm("b")]);
    await vi.waitFor(() => expect(ids()).toEqual(["waiting", "a"]));
    interactions.answer("a", { type: "confirm", value: true });
    interactions.dismiss("waiting");
    expect(ids()).toEqual([]);
    expect(fake.calls.filter(([call]) => call === "answer" || call === "dismiss")).toEqual([
      ["answer", "a", { type: "confirm", value: true }],
      ["dismiss", "waiting"],
    ]);
    fake.emit({ type: "interaction", request: confirm("c") });
    fake.setStatus({ state: "reconnecting" });
    expect(ids()).toEqual([]);
    fake.setStatus({ state: "connected", generation: 2 });
    fake.lists[1]!([confirm("c")]);
    await vi.waitFor(() => expect(ids()).toEqual(["c"]));
    const release = interactions.claim((request) => request.id === "c");
    expect(interactions.claimed(interactions.open()[0]!)).toBe(true);
    release();
    expect(interactions.claimed(interactions.open()[0]!)).toBe(false);
    dispose();
  });
});

describe("createHostPlugins", () => {
  it("lists the host's plugins, kept current, with what the host provides itself, and writes a change where its row is set", async () => {
    const fake = fakeHost();
    fake.setPlugins([plugin("agent")]);
    const { client } = createClient(fake.host);
    const { notify } = createNotify(client);
    const { plugins, dispose } = createHostPlugins(client, notify);
    await vi.waitFor(() => expect(plugins.list().map((status) => status.id)).toEqual(["agent"]));
    await vi.waitFor(() => expect(plugins.runtime()).toEqual(["lemma/Paths"]));
    fake.emit({ type: "plugins-changed", plugins: [plugin("agent"), plugin("tools")] });
    expect(plugins.list().map((status) => status.id)).toEqual(["agent", "tools"]);
    await plugins.setEnabled(plugin("tools", { scope: "project" }), false);
    await plugins.setEnabled(plugin("agent"), false);
    await plugins.setConfig(plugin("agent", { configScope: "project" }), { maxSteps: 3 });
    expect(fake.calls.filter(([call]) => call === "configure")).toEqual([
      ["configure", { tools: { enabled: false } }, { scope: "project" }],
      ["configure", { agent: { enabled: false } }, undefined],
      ["configure", { agent: { values: { maxSteps: 3 } } }, { scope: "project" }],
    ]);
    dispose();
  });
});
