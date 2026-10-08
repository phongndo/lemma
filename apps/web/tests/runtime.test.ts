import { describe, expect, it, vi } from "vitest";
import type { ConnectionStatus, Host } from "@lemma/client";
import type { HostEvent, HostInfo, InteractionRequest, PluginStatus } from "@lemma/contracts";
import { createClient } from "../src/runtime/client.ts";
import { createHostPlugins } from "../src/runtime/host-plugins.ts";
import { createInteractions } from "../src/runtime/interactions.ts";
import { createNotify } from "../src/runtime/notify.ts";

/** A host connection the test drives: its status, its events, and the replies its calls get. */
const fakeHost = () => {
  let status: ConnectionStatus = { state: "connected", generation: 1, attempts: 0 };
  const statusListeners = new Set<(status: ConnectionStatus) => void>();
  const eventListeners = new Set<(event: HostEvent) => void>();
  const calls: unknown[][] = [];
  const info: HostInfo = { version: "0", cwd: "/work", home: "/home", composition: { id: "c", plugins: [] }, runtime: ["lemma/Paths"] };
  let plugins: readonly PluginStatus[] = [];
  /** Each `interaction.list` call's reply, resolved by the test. */
  const lists: ((requests: readonly InteractionRequest[]) => void)[] = [];
  const host = {
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
    host: host as unknown as Host,
    calls,
    lists,
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
    const { interactions, dispose } = createInteractions(client, notify);
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
