import { describe, expect, test } from "vitest";
import { Context, Effect } from "effect";
import { CompositionError, definePlugin, PluginFault } from "../src/index.ts";
import { testPlugin } from "../src/testing.ts";

class Clock extends Context.Service<Clock, { readonly now: () => number }>()("test/Clock") {}
class Stamp extends Context.Service<Stamp, { readonly stamp: (text: string) => string }>()("test/Stamp") {}

const stamper = definePlugin({
  id: "stamper",
  config: { separator: "@" },
  requires: { clock: Clock },
  provides: { stamp: Stamp },
  setup: function* ({ clock }, { config, background }) {
    const released: string[] = [];
    yield* Effect.addFinalizer(() => Effect.sync(() => void released.push("stamper")));
    yield* background("audit", Effect.fail("audit log unreachable"));
    return { stamp: { stamp: (text: string) => `${text}${config.separator}${clock.now()}` } };
  },
});

describe("testPlugin", () => {
  test("runs a plugin with stand-ins for what it requires, and hands back promises", async () => {
    const tested = await testPlugin(stamper, { provide: [[Clock, { now: () => 42 }]], config: { separator: "#" } });
    try {
      const stamp = await tested.get(Stamp);
      expect(stamp.stamp("a")).toBe("a#42");
      expect(await tested.run(Effect.map(Stamp, (service) => service.stamp("b")))).toBe("b#42");
      const fault = await tested.waitForFault((candidate) => candidate.phase === "background");
      expect(fault.pluginId).toBe("stamper");
      expect(fault.operation).toBe("audit");
      // A stand-in is the application's, with no plugin row.
      const snapshot = await tested.inspect();
      expect(snapshot.plugins.map((plugin) => plugin.id)).toEqual(["stamper"]);
      expect(snapshot.provided).toEqual(["test/Clock"]);
    } finally {
      await tested.close();
    }
    expect((await tested.inspect()).state).toBe("closed");
  });

  test("fails as makeCore does when the plugin cannot plan or start", async () => {
    await expect(testPlugin(stamper)).rejects.toBeInstanceOf(CompositionError);
    const broken = definePlugin({ id: "broken", setup: () => Effect.fail("no") });
    await expect(testPlugin(broken)).rejects.toBeInstanceOf(PluginFault);
    // What a stand-in provides, no plugin may.
    const clock = definePlugin({ id: "clock", provides: { clock: Clock }, setup: () => Effect.succeed({ clock: { now: () => 1 } }) });
    await expect(testPlugin(clock, { provide: [[Clock, { now: () => 0 }]] })).rejects.toMatchObject({
      _tag: "CompositionError",
      reason: "ReservedCapability",
      plugins: ["clock"],
      capability: "test/Clock",
    });
  });

  test("waitForFault rejects, naming what was reported, when nothing matches in time", async () => {
    const tested = await testPlugin(stamper, { provide: [[Clock, { now: () => 0 }]] });
    try {
      await expect(tested.waitForFault((fault) => fault.phase === "dispose", 20)).rejects.toThrow(/No matching fault within 20 ms/);
    } finally {
      await tested.close();
    }
  });
});
