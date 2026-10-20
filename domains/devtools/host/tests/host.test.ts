import { describe, expect, it } from "vitest";
import { Cause, Effect, Exit, Layer, Schema } from "effect";
import { Channels, HostControl, HostError, Inspectors, resultOf, wireCodec } from "@lemma/contracts";
import type { ChannelCall, PluginInfo, PluginStatus } from "@lemma/contracts";
import { pathsPlugin } from "@lemma/contracts/testing";
import { definePlugin, makeCore, PluginFault, Registries } from "@lemma/core";
import { HostChannels } from "@lemma/devtools";
import host from "../src/index.ts";

const plugins: PluginInfo[] = [
  { id: "tools.read", version: "0.1.0", source: "bundled", enabled: true, provides: [], requires: [], state: "active" },
  {
    id: "notes",
    source: "user",
    enabled: true,
    scope: "user",
    provides: [],
    requires: [],
    state: "failed",
    fault: new PluginFault({ pluginId: "notes", phase: "activate", cause: Cause.fail(new Error("boom")) }),
    // A key typed into a plain field, as a URL's parameter.
    config: { values: { baseUrl: "https://llm.example/v1?key=sk-1&region=eu" }, secretsSet: ["apiKey"] },
  },
];

const control = Layer.succeed(HostControl, {
  runtime: ["lemma/Paths", "lemma/HostControl"],
  process: { pid: 42, startedAt: 7, startedBy: "cli" },
  plugins: Effect.succeed(plugins),
  composition: Effect.succeed({ id: "c0ffee", plugins: [{ id: "tools.read", version: "0.1.0" }] }),
  restart: () => Effect.die("not called"),
  reload: Effect.die("not called"),
  configure: () => Effect.die("not called"),
  web: Effect.die("not called"),
});

/** Adds inspectors: one that shows its state, one that shows nothing, one that fails. */
const inspected = definePlugin({
  id: "inspected",
  setup: (_, owner) =>
    Effect.all(
      [
        owner.add(Inspectors, { id: "inspected.state", title: "State", description: "What it holds", snapshot: () => [{ key: "a", value: 1 }] }),
        owner.add(Inspectors, { id: "inspected.none", title: "Nothing", snapshot: Effect.succeed(undefined) }),
        owner.add(Inspectors, { id: "inspected.broken", title: "Broken", snapshot: () => Promise.reject(new Error("cannot look")) }),
        owner.add(Inspectors, {
          id: "inspected.tabs",
          title: "Tabs",
          snapshot: () => ({ tabs: [{ url: "https://app.example/callback?code=abc&state=1", apiKey: "sk-1", tokens: 12 }] }),
        }),
      ],
      { discard: true },
    ),
});

/** Runs the plugin over `control` and hands `body` its channels by key of `HostChannels`. */
const withHost = <A>(body: (channels: Record<keyof typeof HostChannels, ChannelCall>) => Effect.Effect<A, unknown>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* makeCore([pathsPlugin("/home/me/.lemma", { cwd: "/work" }), inspected, host], {
          provide: { provides: [HostControl], layer: control },
        });
        const items = yield* core.run(Effect.flatMap(Registries, (registries) => registries.items(Channels)));
        const byId = new Map(items.map(({ item }) => [item.id, item as ChannelCall]));
        const channels = Object.fromEntries(Object.entries(HostChannels).map(([key, declaration]) => [key, byId.get(declaration.id)!]));
        return yield* body(channels as Record<keyof typeof HostChannels, ChannelCall>);
      }),
    ),
  );

/** `value` as a client receives it: encoded by the channel's result schema, as the transport sends it. */
const onTheWire = (channel: ChannelCall, value: unknown) => Schema.encodeUnknownEffect(wireCodec(channel.success))(value);

describe("devtools.host", () => {
  it("tells where the host runs, what it provides itself, its process, and its plugin set", () =>
    withHost(({ info }) =>
      Effect.gen(function* () {
        const answer = yield* resultOf(info, undefined);
        expect(yield* onTheWire(info, answer)).toEqual({
          cwd: "/work",
          home: "/home/me/.lemma",
          runtime: ["lemma/Paths", "lemma/HostControl"],
          pid: 42,
          startedAt: 7,
          startedBy: "cli",
          composition: { id: "c0ffee", plugins: [{ id: "tools.read", version: "0.1.0" }] },
        });
      }),
    ));

  it("lists every plugin as clients see it, its fault in a line, or those ids names", () =>
    withHost(({ plugins: listed }) =>
      Effect.gen(function* () {
        const all = yield* onTheWire(listed, yield* resultOf(listed, {}));
        expect(all).toEqual([
          expect.objectContaining({ id: "tools.read", state: "active", enabled: true }),
          expect.objectContaining({
            id: "notes",
            state: "failed",
            fault: expect.objectContaining({ phase: "activate", message: expect.stringContaining("boom") }),
          }),
        ]);
        const notes = (yield* resultOf(listed, { ids: ["notes"] })) as PluginStatus[];
        expect(notes.map((plugin) => plugin.id)).toEqual(["notes"]);
        // The secret parameter hidden, and which secrets are set still said: only text is redacted, not field names.
        expect(notes[0]!.config).toEqual({ values: { baseUrl: "https://llm.example/v1?key=<redacted>&region=eu" }, secretsSet: ["apiKey"] });
      }),
    ));

  it("lists the inspectors by the plugin that adds each, and shows one's snapshot, null for none", () =>
    withHost(({ inspectors, inspect }) =>
      Effect.gen(function* () {
        expect(yield* resultOf(inspectors, undefined)).toEqual([
          { id: "inspected.state", title: "State", description: "What it holds", source: "inspected" },
          { id: "inspected.none", title: "Nothing", source: "inspected" },
          { id: "inspected.broken", title: "Broken", source: "inspected" },
          { id: "inspected.tabs", title: "Tabs", source: "inspected" },
        ]);
        expect(yield* resultOf(inspect, { id: "inspected.state" })).toEqual([{ key: "a", value: 1 }]);
        expect(yield* resultOf(inspect, { id: "inspected.none" })).toBeNull();
        // Secrets a snapshot shows leave hidden: a login's code in a URL, a field named for a key; a count of tokens stays.
        expect(yield* resultOf(inspect, { id: "inspected.tabs" })).toEqual({
          tabs: [{ url: "https://app.example/callback?code=<redacted>&state=1", apiKey: "<redacted>", tokens: 12 }],
        });
      }),
    ));

  it("fails NotFound for an inspector there is not, and Failed for one that fails", () =>
    withHost(({ inspect }) =>
      Effect.gen(function* () {
        const failure = (exit: Exit.Exit<unknown, unknown>) => (Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined);
        expect(failure(yield* Effect.exit(resultOf(inspect, { id: "gone" })))).toEqual(
          new HostError({ code: "NotFound", subject: "gone", message: 'No inspector "gone"' }),
        );
        expect(failure(yield* Effect.exit(resultOf(inspect, { id: "inspected.broken" })))).toMatchObject({ code: "Failed", subject: "inspected.broken" });
      }),
    ));
});
