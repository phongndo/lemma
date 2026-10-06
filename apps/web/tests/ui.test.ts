import { describe, expect, it } from "vitest";
import { Context, Effect, Exit, Layer, Schema, Scope } from "effect";
import { createEffect, createRoot, createSignal } from "solid-js";
import { definePlugin, makeLoader } from "@lemma/core";
import type { Loader, Plugin } from "@lemma/core";
import { defineRoute } from "@lemma/router";
import { Slots, UiApi } from "../src/ui/contracts.ts";
import { defineUiPlugin, extendUiPlugin, routesOf } from "../src/ui/define.ts";
import slotsPlugin from "../src/plugins/slots.ts";
import { defineSlot } from "../src/ui/slots.ts";
import type { SlotsService } from "../src/ui/slots.ts";

/** Resolves once `ready` holds; slot changes from a plugin starting or stopping arrive asynchronously. */
const waitFor = async (ready: () => boolean) => {
  for (let tries = 0; tries < 200 && !ready(); tries++) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(ready()).toBe(true);
};

const Items = defineSlot<{ readonly label: string }>("test.items");

/** A plugin that adds `items` to `Items` (a UI plugin, as a bundled one would be). */
const adding = (id: string, items: readonly { readonly id: string; readonly label: string; readonly order?: number }[]) =>
  defineUiPlugin({
    id,
    requires: { slots: Slots },
    setup: ({ slots }) => {
      for (const item of items) slots.add(Items, item);
    },
  });

describe("slots", () => {
  it("orders items by order, then plugin id, then when they were added; a removal applies at once", async () => {
    let remove: (() => void) | undefined;
    const late = defineUiPlugin({
      id: "late",
      requires: { slots: Slots },
      setup: ({ slots }) => {
        remove = slots.add(Items, { id: "late", label: "L" });
      },
    });
    await run(
      [
        slotsPlugin,
        adding("b", [
          { id: "b1", label: "B" },
          { id: "b2", label: "B" },
        ]),
        adding("a", [{ id: "first", label: "F", order: -1 }]),
        late,
      ],
      async (loader) => {
        const slots = await Effect.runPromise(loader.core.run(Slots));
        expect(slots.list(Items).map((item) => item.id)).toEqual(["first", "b1", "b2", "late"]);
        expect(slots.first(Items)?.id).toBe("first");
        expect(slots.get(Items, "b2")?.label).toBe("B");
        remove!();
        expect(slots.list(Items).map((item) => item.id)).toEqual(["first", "b1", "b2"]);
        expect(slots.list(defineSlot<unknown>("test.empty"))).toEqual([]);
      },
    );
  });

  it("attributes each item to its plugin and drops them when it stops, cleanup or not", async () => {
    await run([slotsPlugin, adding("sidebar", [{ id: "a", label: "A" }]), adding("palette", [{ id: "b", label: "B" }])], async (loader) => {
      const slots = await Effect.runPromise(loader.core.run(Slots));
      const snapshot = await Effect.runPromise(loader.core.inspect);
      expect(snapshot.registries.find((registry) => registry.name === "test.items")?.items).toEqual([
        { pluginId: "palette", order: 0, key: "b" },
        { pluginId: "sidebar", order: 0, key: "a" },
      ]);
      // `adding` registers no cleanup: the core removes the items with the plugin.
      await Effect.runPromise(loader.apply({ plugins: { slots: {}, palette: {}, sidebar: { enabled: false } } }));
      await waitFor(() => slots.list(Items).length === 1);
      expect(slots.list(Items).map((item) => item.id)).toEqual(["b"]);
    });
  });

  it("an item that fails while drawing leaves the slot's views, named for its plugin, until the plugin adds it again", async () => {
    await run([slotsPlugin, adding("custom", [{ id: "mine", label: "M" }]), adding("kit", [{ id: "default", label: "D", order: 100 }])], async (loader) => {
      const slots = await Effect.runPromise(loader.core.run(Slots));
      const shown: (string | undefined)[] = [];
      const dispose = createRoot((dispose) => {
        createEffect(() => shown.push(slots.first(Items)?.id));
        return dispose;
      });
      slots.fail(Items, slots.first(Items)!, new Error("draw failed"));
      // Readers draw the next item: a part's default, the rest of a list.
      expect(shown).toEqual(["mine", "default"]);
      expect(slots.list(Items).map((item) => item.id)).toEqual(["default"]);
      expect(slots.failures(Items)).toMatchObject([{ item: { id: "mine" }, pluginId: "custom", error: new Error("draw failed") }]);
      const custom = (await Effect.runPromise(loader.core.inspect)).plugins.find((plugin) => plugin.id === "custom");
      expect(custom).toMatchObject({ state: "active", fault: { phase: "service", operation: 'draw test.items "mine"' } });
      // A restart adds it again: a new item, tried afresh.
      await Effect.runPromise(loader.core.restart("custom", { force: true }));
      await waitFor(() => slots.first(Items)?.id === "mine");
      expect(slots.failures(Items)).toEqual([]);
      dispose();
    });
  });

  it("gives every definition of a name the same slot, as a UI file loaded again defines it again", async () => {
    const own = (id: string) =>
      defineUiPlugin({
        id,
        requires: { slots: Slots },
        setup: ({ slots }) => {
          slots.add(defineSlot<{ readonly label: string }>("test.shared"), { id, label: id });
        },
      });
    await run([slotsPlugin, own("x"), own("y")], async (loader) => {
      const slots = await Effect.runPromise(loader.core.run(Slots));
      expect(slots.list(defineSlot("test.shared")).map((item) => item.id)).toEqual(["x", "y"]);
    });
  });

  it("ignores an add from a plugin that has stopped", async () => {
    let captured: SlotsService | undefined;
    const keeper = defineUiPlugin({
      id: "keeper",
      requires: { slots: Slots },
      setup: ({ slots }) => {
        captured = slots;
      },
    });
    await run([slotsPlugin, keeper], async (loader) => {
      const slots = await Effect.runPromise(loader.core.run(Slots));
      await Effect.runPromise(loader.apply({ plugins: { slots: {}, keeper: { enabled: false } } }));
      const remove = captured!.add(Items, { id: "late", label: "L" });
      remove();
      expect(slots.list(Items)).toEqual([]);
    });
  });
});

class Counter extends Context.Tag("test/Counter")<Counter, { readonly count: () => number; readonly add: () => void }>() {}

const counter = defineUiPlugin({
  id: "counter",
  provides: { counter: Counter },
  setup: () => {
    const [count, setCount] = createSignal(0);
    return { counter: { count, add: () => setCount(count() + 1) } };
  },
});

/** Runs `plugins` on the kernel the way the boot does, starting with those in `running`, and closes it. */
const run = async (plugins: readonly Plugin[], body: (loader: Loader) => Promise<void>, running = plugins.map((plugin) => plugin.id)) => {
  const scope = Effect.runSync(Scope.make());
  try {
    const loader = await Effect.runPromise(
      Scope.extend(
        makeLoader({
          source: { resolve: (id) => Effect.succeed(plugins.find((plugin) => plugin.id === id)!) },
          composition: { plugins: Object.fromEntries(running.map((id) => [id, {}])) },
        }),
        scope,
      ),
    );
    await body(loader);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
};

describe("defineUiPlugin", () => {
  it("provides services by name and hands required ones to setup", async () => {
    const seen: number[] = [];
    const reader = defineUiPlugin({
      id: "reader",
      requires: { counter: Counter, slots: Slots },
      setup: ({ counter, slots }) => {
        counter.add();
        seen.push(counter.count());
        slots.add(Items, { id: "reader", label: String(counter.count()) });
      },
    });
    await run([counter, slotsPlugin, reader], async (loader) => {
      expect(seen).toEqual([1]);
      const slots = await Effect.runPromise(loader.core.run(Slots));
      expect(slots.list(Items).map((item) => item.label)).toEqual(["1"]);
      // What it added is attributed to it, for the plugins inspector.
      const snapshot = await Effect.runPromise(loader.core.inspect);
      expect(snapshot.registries.find((registry) => registry.name === "test.items")?.items.map((item) => item.pluginId)).toEqual(["reader"]);
      // Turning it off runs its cleanups: its item leaves the slot.
      await Effect.runPromise(loader.apply({ plugins: { counter: {}, slots: {}, reader: { enabled: false } } }));
      await waitFor(() => slots.list(Items).length === 0);
    });
  });

  it("decodes its config and passes it to setup", async () => {
    const seen: unknown[] = [];
    const configured = defineUiPlugin({
      id: "configured",
      config: Schema.Struct({ size: Schema.optionalWith(Schema.Number, { default: () => 3 }) }),
      setup: (_, plugin) => void seen.push(plugin.config),
    });
    await run([configured], async (loader) => {
      await Effect.runPromise(loader.apply({ plugins: { configured: { config: { size: 5 } } } }));
    });
    expect(seen).toEqual([{ size: 3 }, { size: 5 }]);
  });

  it("a computation that throws after setup stops its plugin and what needs it, and the others keep updating", async () => {
    class Model extends Context.Tag("test/Model")<Model, { readonly ok: true }>() {}
    const [count, setCount] = createSignal(0);
    const seen: number[] = [];
    const faulty = defineUiPlugin({
      id: "faulty",
      provides: { model: Model },
      setup: () => {
        createEffect(() => {
          if (count() === 2) throw new Error("bad state");
        });
        return { model: { ok: true } };
      },
    });
    const needs = defineUiPlugin({ id: "needs", requires: { model: Model }, setup: () => {} });
    // Activated after `faulty` (ids in order), so its effect runs after the one that throws in the same update.
    const steady = defineUiPlugin({ id: "steady", setup: () => void createEffect(() => seen.push(count())) });
    await run([faulty, needs, steady], async (loader) => {
      const states = async () => Object.fromEntries((await Effect.runPromise(loader.core.inspect)).plugins.map((plugin) => [plugin.id, plugin.state]));
      setCount(1);
      setCount(2);
      setCount(3);
      expect(seen).toEqual([0, 1, 2, 3]);
      let now: Record<string, string> = {};
      await waitFor(() => (void states().then((value) => (now = value)), now.faulty === "failed"));
      expect(now).toEqual({ faulty: "failed", needs: "closed", steady: "active" });
      const fault = (await Effect.runPromise(loader.core.inspect)).plugins.find((plugin) => plugin.id === "faulty")?.fault;
      expect(fault).toMatchObject({ phase: "service", operation: "effects" });
    });
  });

  it("extends a definition, declares routes, and requires the API version it is written for", async () => {
    const Note = defineRoute("test.note", { path: "/notes/:id" });
    const calls: string[] = [];
    const base = defineUiPlugin({ id: "notes", api: 1, routes: [Note], setup: () => void calls.push("base") });
    expect(base.requires.map((tag) => tag.key)).toEqual(["lemma-ui/api@1"]);
    expect(routesOf(base)).toEqual([Note]);
    const extended = extendUiPlugin(base, (definition) => ({
      ...definition,
      setup: (use, plugin) => {
        calls.push("mine");
        return definition.setup(use, plugin);
      },
    }));
    expect([extended.id, routesOf(extended)]).toEqual(["notes", [Note]]);
    expect(() => extendUiPlugin(definePlugin({ id: "raw", layer: Layer.empty }), (definition) => definition)).toThrow(/not made with defineUiPlugin/);
    const app = defineUiPlugin({ id: "app", provides: { api: UiApi(1) }, setup: () => ({ api: 1 }) });
    await run([app, extended], async () => {
      expect(calls).toEqual(["mine", "base"]);
    });
  });

  it("a setup that throws fails only its own plugin, releasing what it added", async () => {
    const broken = defineUiPlugin({
      id: "broken",
      requires: { slots: Slots },
      setup: ({ slots }) => {
        slots.add(Items, { id: "broken", label: "half-made" });
        throw new Error("boom");
      },
    });
    await run(
      [slotsPlugin, broken],
      async (loader) => {
        const slots = await Effect.runPromise(loader.core.run(Slots));
        const applied = await Effect.runPromiseExit(loader.apply({ plugins: { slots: {}, broken: {} } }));
        expect(applied._tag).toBe("Failure");
        expect(slots.list(Items)).toEqual([]);
        // The rest keeps running.
        expect(await Effect.runPromise(loader.core.run(Slots))).toBe(slots);
      },
      ["slots"],
    );
  });
});
