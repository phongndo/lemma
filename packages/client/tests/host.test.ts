import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { Effect, Layer, Schema, Stream } from "effect";
import { Agent, Channels, Commands, defineChannel, HostControl, HostError, Llm, serveChannel, Sessions, Workspace } from "@lemma/contracts";
import { readDiscovery } from "@lemma/contracts/discovery";
import { pathsPlugin } from "@lemma/contracts/testing";
import { definePlugin, makeCore, PluginContext } from "@lemma/core";
import type { Core } from "@lemma/core";
import transport from "@lemma/plugin-transport";
import { settled } from "../../../scripts/e2e.ts";
import { connect } from "../src/host.ts";
import type { Host } from "../src/host.ts";

/** What else the transport requires, as far as these tests reach it: `Host.Info` for the connect probe, nothing more. */
const stubs = definePlugin({
  id: "stubs",
  provides: [Sessions, Agent, Llm, HostControl, Workspace, Commands],
  layer: Layer.mergeAll(
    Layer.succeed(HostControl, { composition: Effect.succeed({ id: "test", plugins: [] }) } as never),
    Layer.succeed(Sessions, {} as never),
    Layer.succeed(Agent, {} as never),
    Layer.succeed(Llm, {} as never),
    Layer.succeed(Workspace, {} as never),
    Layer.succeed(Commands, {} as never),
  ),
});

// The declarations, as a contract module would export them for clients to import.
const double = defineChannel({ kind: "call", id: "doubler.double", title: "Double", payload: Schema.Number, success: Schema.Number });
const instanceOf = defineChannel({ kind: "stream", id: "doubler.instance", payload: Schema.Void, success: Schema.Number });
const later = defineChannel({ kind: "call", id: "doubler.later", payload: Schema.Struct({ from: Schema.Date }), success: Schema.Date });

let instances = 0;
const running = new Set<number>();
/** A call that doubles, a stream that says which instance of the plugin serves it, then waits, and a day after a date. */
const doubler = definePlugin({
  id: "doubler",
  layer: Layer.effectDiscard(
    Effect.gen(function* () {
      const owner = yield* PluginContext;
      const instance = ++instances;
      yield* owner.add(
        Channels,
        serveChannel(double, (n) => n * 2),
      );
      yield* owner.add(
        Channels,
        serveChannel(instanceOf, () =>
          Stream.concat(Stream.make(instance), Stream.never).pipe(
            Stream.onStart(Effect.sync(() => running.add(instance))),
            Stream.ensuring(Effect.sync(() => running.delete(instance))),
          ),
        ),
      );
      yield* owner.add(
        Channels,
        serveChannel(later, ({ from }) => new Date(from.getTime() + 86_400_000)),
      );
    }).pipe(Effect.orDie),
  ),
});

const withHost = (body: (host: Host, core: Core<any>) => Promise<void>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const home = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "lemma-client-"))),
          (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
        );
        const core = yield* makeCore([transport, pathsPlugin(home), stubs, doubler], { configs: { transport: { port: 0 } } });
        const found = yield* readDiscovery(home);
        if (found === undefined) return yield* Effect.die(new Error("no discovery file"));
        const host = yield* Effect.acquireRelease(
          Effect.promise(() => connect({ url: found.url, token: found.token })),
          (host) => Effect.promise(() => host.close()),
        );
        yield* Effect.promise(() => body(host, core));
      }),
    ),
  );

/** Collects what a callback is given; `until(n)` waits for the n-th. */
const listener = () => {
  const values: unknown[] = [];
  return {
    values,
    push: (value: unknown) => void values.push(value),
    until: async (count: number) => {
      await waitUntil(() => values.length >= count);
      return values[count - 1];
    },
  };
};

const waitUntil = async (done: () => boolean) => {
  if ((await settled(async () => done() || undefined)) === undefined) throw new Error("timed out");
};

describe("the channel facade", () => {
  test("lists and calls host plugins' channels by id; a refused call rejects with the host's code", () =>
    withHost(async (host) => {
      expect(await host.channel.list()).toEqual([
        { id: "doubler.double", kind: "call", title: "Double", source: "doubler" },
        { id: "doubler.instance", kind: "stream", source: "doubler" },
        { id: "doubler.later", kind: "call", source: "doubler" },
      ]);
      expect(await host.channel.call("doubler.double", 21)).toBe(42);
      const refused = await host.channel.call("doubler.double", "21").catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(HostError);
      expect(refused).toMatchObject({ code: "InvalidPayload", subject: "doubler.double" });
    }));

  test("calls and opens a declared channel typed: its payload encoded and its results decoded by its schemas", () =>
    withHost(async (host) => {
      const doubled: number = await host.channel.call(double, 21);
      expect(doubled).toBe(42);
      // Through the schemas' JSON codecs: a Date goes as a string and comes back a Date, as a client by id sees it as text.
      const next = await host.channel.call(later, { from: new Date(0) });
      expect(next).toEqual(new Date(86_400_000));
      expect(await host.channel.call("doubler.later", { from: "1970-01-01T00:00:00.000Z" })).toBe("1970-01-02T00:00:00.000Z");
      const first = listener();
      const close = host.channel.open(instanceOf, undefined, (element: number) => first.push(element));
      expect(typeof (await first.until(1))).toBe("number");
      close();
    }));

  test("a result the client's declaration does not read rejects Mismatch; a payload it cannot encode, InvalidPayload", () =>
    withHost(async (host) => {
      // Another version's declaration of the same channel.
      const older = defineChannel({ kind: "call", id: "doubler.double", payload: Schema.Number, success: Schema.String });
      expect(await host.channel.call(older, 21).catch((error: unknown) => error)).toMatchObject({ code: "Mismatch", subject: "doubler.double" });
      const ends = listener();
      host.channel.open(defineChannel({ ...instanceOf, success: Schema.String }), undefined, () => {}, ends.push);
      expect(await ends.until(1)).toMatchObject({ code: "Mismatch", subject: "doubler.instance" });
      expect(await host.channel.call(later, { from: new Date(Number.NaN) }).catch((error: unknown) => error)).toMatchObject({
        code: "InvalidPayload",
        subject: "doubler.later",
      });
    }));

  test("opens a stream until closed, stopping it on the host; one withdrawn by a reload ends with Withdrawn and opens again", () =>
    withHost(async (host, core) => {
      const first = listener();
      const ends = listener();
      const close = host.channel.open("doubler.instance", undefined, first.push, ends.push);
      const before = (await first.until(1)) as number;
      expect(running.has(before)).toBe(true);
      close();
      await waitUntil(() => !running.has(before));
      expect(ends.values).toEqual([]);

      const second = listener();
      host.channel.open("doubler.instance", undefined, second.push, ends.push);
      expect(await second.until(1)).toBe(before);
      await Effect.runPromise(core.restart("doubler", { force: true }));
      expect(await ends.until(1)).toMatchObject({ code: "Withdrawn", subject: "doubler.instance" });
      expect(running.has(before)).toBe(false);

      const third = listener();
      host.channel.open("doubler.instance", undefined, third.push);
      expect(await third.until(1)).toBe(before + 1);
    }));

  test("a stream whose connection drops ends with an RpcClientError, and stops on the host", () =>
    withHost(async (host, core) => {
      const first = listener();
      const ends = listener();
      host.channel.open("doubler.instance", undefined, first.push, ends.push);
      const instance = (await first.until(1)) as number;
      // The transport's restart closes every socket.
      await Effect.runPromise(core.restart("transport", { force: true }));
      const ended = await ends.until(1);
      expect(ended).toBeInstanceOf(Error);
      expect(ended).not.toBeInstanceOf(HostError);
      expect(ended).toMatchObject({ _tag: "RpcClientError" });
      await waitUntil(() => !running.has(instance));
    }));
});
