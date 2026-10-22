import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { Context, Effect, Exit, Layer, Schema, Scope } from "effect";
import { Show, children, createComponent, createEffect, createRenderEffect, createRoot, createSignal } from "solid-js";
import type { Component, JSX } from "solid-js";
import { checkComposition, definePlugin, makeLoader } from "@lemma/core";
import type { ApplicationServices, Loader, Plugin } from "@lemma/core";
import { planComposition } from "@lemma/composition";
import { defineRoute } from "@lemma/router";
import { makeSlots } from "../src/runtime/slots.ts";
import * as look from "@lemma/look";
import * as llm from "@lemma/llm/web";
import * as threads from "@lemma/threads";
import { TogglePart } from "@lemma/look";
import {
  Notify,
  Slots,
  WEB_API,
  WebApi,
  defineWebPlugin,
  extendWebPlugin,
  routesOf,
  definePart,
  defineSlot,
  fallbackOf,
  Client,
  usePlugin,
  Contained,
  partView,
  SlotsContext,
} from "@lemma/web";
import type { Part, SlotsService, ClientService } from "@lemma/web";
import { PluginStopped } from "@lemma/core/plain";

/** Resolves once `ready` holds; slot changes from a plugin starting or stopping arrive asynchronously. */
const waitFor = async (ready: () => boolean) => {
  for (let tries = 0; tries < 200 && !ready(); tries++) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(ready()).toBe(true);
};

const Items = defineSlot<{ readonly label: string }>("test.items");

/** A plugin that adds `items` to `Items` (a UI plugin, as a bundled one would be). */
const adding = (id: string, items: readonly { readonly id: string; readonly label: string; readonly order?: number }[]) =>
  defineWebPlugin({
    id,
    requires: { slots: Slots },
    setup: ({ slots }) => {
      for (const item of items) slots.add(Items, item);
    },
  });

describe("slots", () => {
  it("orders items by order, then plugin id, then when they were added; a removal applies at once", async () => {
    let remove: (() => void) | undefined;
    const late = defineWebPlugin({
      id: "late",
      requires: { slots: Slots },
      setup: ({ slots }) => {
        remove = slots.add(Items, { id: "late", label: "L" });
      },
    });
    await run(
      [
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
    await run([adding("sidebar", [{ id: "a", label: "A" }]), adding("palette", [{ id: "b", label: "B" }])], async (loader) => {
      const slots = await Effect.runPromise(loader.core.run(Slots));
      const snapshot = await Effect.runPromise(loader.core.inspect);
      expect(snapshot.registries.find((registry) => registry.name === "test.items")?.items).toEqual([
        { pluginId: "palette", order: 0, key: "b" },
        { pluginId: "sidebar", order: 0, key: "a" },
      ]);
      // `adding` registers no cleanup: the core removes the items with the plugin.
      await Effect.runPromise(loader.apply({ plugins: { palette: {}, sidebar: { enabled: false } } }));
      await waitFor(() => slots.list(Items).length === 1);
      expect(slots.list(Items).map((item) => item.id)).toEqual(["b"]);
    });
  });

  it("an item that fails while drawing leaves the slot's views, named for its plugin, until the plugin adds it again", async () => {
    await run([adding("custom", [{ id: "mine", label: "M" }]), adding("kit", [{ id: "default", label: "D", order: 100 }])], async (loader) => {
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

  it("logs a reader that throws on a change, and goes on following the slot", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await run([adding("a", [{ id: "a", label: "A" }]), adding("b", [{ id: "b", label: "B" }])], async (loader) => {
        const slots = await Effect.runPromise(loader.core.run(Slots));
        const dispose = createRoot((dispose) => {
          createEffect(() => {
            if (slots.list(Items).length === 1) throw new Error("reader failed");
          });
          return dispose;
        });
        // A plugin stopping removes its items in the core: only the slot's watcher hears it.
        await Effect.runPromise(loader.apply({ plugins: { a: {}, b: { enabled: false } } }));
        await waitFor(() => logged.mock.calls.some(([message]) => message === "lemma web: a reader of test.items failed"));
        await Effect.runPromise(loader.apply({ plugins: { a: { enabled: false }, b: { enabled: false } } }));
        await waitFor(() => slots.list(Items).length === 0);
        dispose();
      });
    } finally {
      logged.mockRestore();
    }
  });

  it("gives every definition of a name the same slot, as a web half loaded again defines it again", async () => {
    const own = (id: string) =>
      defineWebPlugin({
        id,
        requires: { slots: Slots },
        setup: ({ slots }) => {
          slots.add(defineSlot<{ readonly label: string }>("test.shared"), { id, label: id });
        },
      });
    await run([own("x"), own("y")], async (loader) => {
      const slots = await Effect.runPromise(loader.core.run(Slots));
      expect(slots.list(defineSlot("test.shared")).map((item) => item.id)).toEqual(["x", "y"]);
    });
  });

  it("shows a part's replacement over its defaults by phase, whatever the numbers, and a better default over another", async () => {
    // As `look.kit` and `look.file-icons` add theirs (`ui:check` checks theirs in the app).
    const providing = (id: string, item: { readonly id: string; readonly phase?: string; readonly order?: number }) =>
      defineWebPlugin({ id, requires: { slots: Slots }, setup: ({ slots }) => void slots.add(look.FileIconPart, { ...item, component: () => null }) });
    const kit = providing("look.kit", { id: "kit.file-icon", phase: "default" });
    const fileIcons = providing("look.file-icons", { id: "file-icons", phase: "default", order: -1 });
    // A phase it does not name: it goes in `replace`, before every default, however high its order.
    const mine = providing("aaa.mine", { id: "mine", order: 1_000_000 });
    await run([kit, fileIcons, mine], async (loader) => {
      const slots = await Effect.runPromise(loader.core.run(Slots));
      expect(slots.contributions(look.FileIconPart).map(({ item, phase, order }) => [item.id, phase, order])).toEqual([
        ["mine", "replace", 1_000_000],
        ["file-icons", "default", -1],
        ["kit.file-icon", "default", 0],
      ]);
      await Effect.runPromise(loader.apply({ plugins: { "look.kit": {}, "look.file-icons": {}, "aaa.mine": { enabled: false } } }));
      await waitFor(() => slots.first(look.FileIconPart)?.id === "file-icons");
      await Effect.runPromise(loader.apply({ plugins: { "look.kit": {}, "look.file-icons": { enabled: false }, "aaa.mine": { enabled: false } } }));
      await waitFor(() => slots.first(look.FileIconPart)?.id === "kit.file-icon");
    });
  });

  it("takes a part's slot named before its part is declared for a part's, and refuses a default phase without phases", () => {
    // One web half adds to another's part, by name, before the other has declared it.
    const early = defineSlot("part.test.early-row");
    expect(early.options.phases).toEqual(["replace", "default"]);
    expect(definePart("test.early-row")).toBe(early);
    expect(defineSlot("test.not-a-part").options.phases).toBeUndefined();
    expect(() => defineSlot("test.stray-default", { defaultPhase: "b" })).toThrow("has a default phase but no phases");
  });

  it("fixes what a slot shows and its phases at its first declaration, and refuses a different one", () => {
    const declared = defineSlot<{ readonly label: string }>("test.declared", { shows: "first" });
    expect(declared.options.phases).toEqual(["replace", "default"]);
    expect(defineSlot("test.declared")).toBe(declared);
    expect(defineSlot("test.declared", { shows: "first" })).toBe(declared);
    expect(() => defineSlot("test.declared", { shows: "all" })).toThrow("test.declared is declared already, showing first in phases replace, default");
    expect(() => defineSlot("test.declared", { shows: "first", phases: ["a", "b"], defaultPhase: "a" })).toThrow("is declared already");
    const phased = defineSlot("test.phased", { phases: ["early", "late"], defaultPhase: "late" });
    expect(defineSlot("test.phased", { phases: ["early", "late"], defaultPhase: "late" })).toBe(phased);
    expect(() => defineSlot("test.phased", { phases: ["early", "late"], defaultPhase: "early" })).toThrow("is declared already");
  });

  it("fixes a bundled part's fallback by its declaration: a web half defining the part again cannot change it", () => {
    const declared = fallbackOf(TogglePart);
    expect(declared).toBeDefined();
    // `api.definePart` passes no fallback, and one passed anyway is refused.
    expect(fallbackOf(definePart("toggle"))).toBe(declared);
    expect(() => definePart("toggle", () => null)).toThrow("part.toggle has a fallback from its declaration");
    expect(fallbackOf(TogglePart)).toBe(declared);
    expect(fallbackOf(definePart("test.bare"))).toBeUndefined();
  });

  it("gives a fallback to every part the always-on plugins draw, as their imports of the parts' views name them", () => {
    const repo = fileURLToPath(new URL("../../../", import.meta.url));
    const contracts = { ...look, ...threads, ...llm } as unknown as Readonly<Record<string, Part<any>>>;
    // What each view exported beside its part draws: the parts its definition names, directly or through another
    // export (`PlusIcon` through `Icon`).
    const exports = new Map<string, string>();
    for (const file of ["domains/look/contract/src/parts.tsx", "domains/threads/contract/src/parts.tsx", "domains/llm/contract/src/web/parts.tsx"]) {
      for (const [, name, body] of readFileSync(join(repo, file), "utf8").matchAll(/^export const (\w+)\s*=([\s\S]*?);$/gm)) exports.set(name!, body!);
    }
    const partsOf = (name: string, seen = new Set<string>()): string[] => {
      if (seen.has(name)) return [];
      seen.add(name);
      return [...(exports.get(name) ?? "").matchAll(/\w+/g)].flatMap(([word]) =>
        /^[A-Z]\w*Part$/.test(word) ? [word] : exports.has(word) ? partsOf(word, seen) : [],
      );
    };
    // The plugins kept on: `PINNED` in ui/boot.tsx and what they need (ui:check asserts the list).
    const drawn = new Set<string>();
    for (const dir of ["domains/frame/shell", "domains/frame/pages", "domains/settings/page", "domains/settings/plugins"].map((dir) =>
      join(repo, dir, "src"),
    )) {
      const files = readdirSync(dir, { recursive: true }).map((file) => join(dir, String(file)));
      for (const file of files.filter((path) => /\.tsx?$/.test(path) && existsSync(path))) {
        for (const [, names] of readFileSync(file, "utf8").matchAll(/import\s*\{([^}]*)\}\s*from\s*["']@lemma\/(?:look|threads|llm\/web)["']/g)) {
          for (const name of names!.split(",").map((entry) => entry.trim().split(/\s+as\s+/)[0]!)) for (const part of partsOf(name)) drawn.add(part);
        }
      }
    }
    // What they draw today, so a reading that finds nothing cannot pass.
    expect([...drawn]).toEqual(expect.arrayContaining(["ConfigFormPart", "IconPart", "SearchFieldPart", "TogglePart"]));
    for (const part of drawn) expect(fallbackOf(contracts[part]!), part).toBeDefined();
  });

  it("ignores an add from a plugin that has stopped", async () => {
    let captured: SlotsService | undefined;
    const keeper = defineWebPlugin({
      id: "keeper",
      requires: { slots: Slots },
      setup: ({ slots }) => {
        captured = slots;
      },
    });
    await run([keeper], async (loader) => {
      const slots = await Effect.runPromise(loader.core.run(Slots));
      await Effect.runPromise(loader.apply({ plugins: { keeper: { enabled: false } } }));
      const remove = captured!.add(Items, { id: "late", label: "L" });
      remove();
      expect(slots.list(Items)).toEqual([]);
    });
  });

  it("refuses an add through the page's own view, which belongs to no plugin", async () => {
    await run([adding("a", [{ id: "a", label: "A" }])], async (loader) => {
      const slots = await Effect.runPromise(loader.core.run(Slots));
      expect(() => slots.add(Items, { id: "orphan", label: "O" })).toThrow(/add through a plugin's own slots/);
      expect(slots.list(Items).map((item) => item.id)).toEqual(["a"]);
      // It still reads, and still blames a failing item on the plugin that added it.
      slots.fail(Items, slots.first(Items)!, new Error("draw failed"));
      expect(slots.failures(Items)).toMatchObject([{ item: { id: "a" }, pluginId: "a" }]);
    });
  });
});

class Counter extends Context.Service<Counter, { readonly count: () => number; readonly add: () => void }>()("test/Counter") {}

const counter = defineWebPlugin({
  id: "counter",
  provides: { counter: Counter },
  setup: () => {
    const [count, setCount] = createSignal(0);
    return { counter: { count, add: () => setCount(count() + 1) } };
  },
});

/** The runtime these tests need, as the boot provides it: the page's slots, and the contracts' version. */
const runtime: ApplicationServices<readonly [typeof Slots, ReturnType<typeof WebApi>]> = {
  provides: [Slots, WebApi(WEB_API)],
  layer: Layer.effectContext(Effect.map(makeSlots, (slots) => Context.make(Slots, slots).pipe(Context.add(WebApi(WEB_API), WEB_API)))),
};

/** The runtime with a connection too, `client`. */
const connected = (client: ClientService): ApplicationServices<readonly [typeof Slots, ReturnType<typeof WebApi>, typeof Client]> => ({
  provides: [Slots, WebApi(WEB_API), Client],
  layer: Layer.effectContext(
    Effect.map(makeSlots, (slots) => Context.make(Slots, slots).pipe(Context.add(WebApi(WEB_API), WEB_API), Context.add(Client, client))),
  ),
});

/** Runs `plugins` on the kernel the way the boot does, over the runtime, starting with those in `running`, and closes it. */
const run = async (
  plugins: readonly Plugin[],
  body: (loader: Loader) => Promise<void>,
  running = plugins.map((plugin) => plugin.id),
  provide: ApplicationServices<readonly any[]> = runtime,
) => {
  const scope = Effect.runSync(Scope.make());
  try {
    const loader = await Effect.runPromise(
      Scope.provide(
        makeLoader({
          source: { resolve: (id) => Effect.succeed(plugins.find((plugin) => plugin.id === id)!) },
          composition: { plugins: Object.fromEntries(running.map((id) => [id, {}])) },
          provide,
        }),
        scope,
      ),
    );
    await body(loader);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
};

describe("defineWebPlugin", () => {
  it("provides services by name and hands required ones to setup", async () => {
    const seen: number[] = [];
    const reader = defineWebPlugin({
      id: "reader",
      requires: { counter: Counter, slots: Slots },
      setup: ({ counter, slots }) => {
        counter.add();
        seen.push(counter.count());
        slots.add(Items, { id: "reader", label: String(counter.count()) });
      },
    });
    await run([counter, reader], async (loader) => {
      expect(seen).toEqual([1]);
      const slots = await Effect.runPromise(loader.core.run(Slots));
      expect(slots.list(Items).map((item) => item.label)).toEqual(["1"]);
      // What it added is attributed to it, for the plugins inspector.
      const snapshot = await Effect.runPromise(loader.core.inspect);
      expect(snapshot.registries.find((registry) => registry.name === "test.items")?.items.map((item) => item.pluginId)).toEqual(["reader"]);
      // Turning it off runs its cleanups: its item leaves the slot.
      await Effect.runPromise(loader.apply({ plugins: { counter: {}, reader: { enabled: false } } }));
      await waitFor(() => slots.list(Items).length === 0);
    });
  });

  it("decodes its config and passes it to setup", async () => {
    const seen: unknown[] = [];
    const configured = defineWebPlugin({
      id: "configured",
      config: Schema.Struct({ size: Schema.Number.pipe(Schema.withDecodingDefaultType(Effect.sync(() => 3))) }),
      setup: (_, plugin) => void seen.push(plugin.config),
    });
    await run([configured], async (loader) => {
      await Effect.runPromise(loader.apply({ plugins: { configured: { config: { size: 5 } } } }));
    });
    expect(seen).toEqual([{ size: 3 }, { size: 5 }]);
  });

  it("a computation that throws after setup stops its plugin and what needs it, and the others keep updating", async () => {
    class Model extends Context.Service<Model, { readonly ok: true }>()("test/Model") {}
    const [count, setCount] = createSignal(0);
    const seen: number[] = [];
    const faulty = defineWebPlugin({
      id: "faulty",
      provides: { model: Model },
      setup: () => {
        createEffect(() => {
          if (count() === 2) throw new Error("bad state");
        });
        return { model: { ok: true } };
      },
    });
    const needs = defineWebPlugin({ id: "needs", requires: { model: Model }, setup: () => {} });
    // Activated after `faulty` (ids in order), so its effect runs after the one that throws in the same update.
    const steady = defineWebPlugin({ id: "steady", setup: () => void createEffect(() => seen.push(count())) });
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
    const base = defineWebPlugin({ id: "notes", api: WEB_API, routes: [Note], setup: () => void calls.push("base") });
    expect(base.requires.map((tag) => tag.key)).toEqual([`lemma-web/api@${WEB_API}`]);
    expect(routesOf(base)).toEqual([Note]);
    const extended = extendWebPlugin(base, (definition) => ({
      ...definition,
      setup: (use, plugin) => {
        calls.push("mine");
        return definition.setup(use, plugin);
      },
    }));
    expect([extended.id, routesOf(extended)]).toEqual(["notes", [Note]]);
    expect(() => extendWebPlugin(definePlugin({ id: "raw", layer: Layer.empty }), (definition) => definition)).toThrow(/not made with defineWebPlugin/);
    // `api.bundled.notify`: the runtime is not a plugin.
    expect(() => extendWebPlugin(undefined, (definition) => definition)).toThrow(/the web app's runtime, not plugins/);
    await run([extended], async () => {
      expect(calls).toEqual(["mine", "base"]);
    });
  });

  it("refuses a plugin that provides what the runtime provides: the boot leaves it out, and the page keeps its own", () => {
    const slots = defineWebPlugin({ id: "my-slots", provides: { slots: Slots }, setup: () => ({ slots: {} as SlotsService }) });
    const version = defineWebPlugin({ id: "old-app", provides: { api: WebApi(WEB_API) }, setup: () => ({ api: WEB_API }) });
    const notify = defineWebPlugin({ id: "my-notify", provides: { notify: Notify }, setup: () => ({ notify: {} as never }) });
    const keeps = adding("keeps", []);
    expect(checkComposition([slots], {}, { provided: runtime.provides }).map((error) => error.reason)).toEqual(["ReservedCapability"]);
    const plan = planComposition({
      bundled: [keeps],
      local: [slots, version, notify].map((plugin) => ({ plugin, source: "user" as const })),
      rows: {},
      provided: [...runtime.provides, Notify],
    });
    const runs = Object.entries(plan.resolved.composition.plugins).filter(([, entry]) => entry.enabled !== false);
    expect(runs.map(([id]) => id)).toEqual(["keeps"]);
    expect([...plan.problems.keys()]).toEqual(["my-slots", "old-app", "my-notify"]);
    expect(plan.diagnostics.map((diagnostic) => [diagnostic.severity, diagnostic.suggestion])).toEqual([
      ["warning", 'Stop providing "lemma-web/Slots": the app provides it, or turn it off'],
      ["warning", `Stop providing "lemma-web/api@${WEB_API}": the app provides it, or turn it off`],
      ["warning", 'Stop providing "lemma-web/Notify": the app provides it, or turn it off'],
    ]);
  });

  it("hands its helpers to setup and to what it draws (usePlugin), and ends what they started when it stops", async () => {
    const Views = defineSlot<{ readonly component: Component }>("test.views");
    const seen: string[] = [];
    let click: (() => void) | undefined;
    const View: Component = () => {
      const plugin = usePlugin();
      seen.push(`drawn by ${plugin.id}`);
      click = plugin.action("click", () => void seen.push("clicked"));
      return null;
    };
    const viewer = defineWebPlugin({
      id: "viewer",
      requires: { slots: Slots },
      setup: ({ slots }, plugin) => {
        slots.add(Views, { id: "view", component: View });
        plugin.every(1, () => void seen.push("tick"));
      },
    });
    await run([viewer], async (loader) => {
      const slots = await Effect.runPromise(loader.core.run(Slots));
      const item = slots.first(Views)!;
      const dispose = createRoot((dispose) => {
        createComponent(SlotsContext.Provider, {
          value: () => slots,
          get children() {
            return createComponent(Contained, { slot: Views, item, component: item.component });
          },
        });
        return dispose;
      });
      expect(seen.filter((entry) => entry !== "tick")).toEqual(["drawn by viewer"]);
      await waitFor(() => seen.includes("tick"));
      await Effect.runPromise(loader.apply({ plugins: { viewer: { enabled: false } } }));
      await waitFor(() => slots.list(Views).length === 0);
      const ticks = seen.length;
      // Its handlers do nothing once it has stopped, and its timer has ended with it.
      click!();
      // Long enough for a timer of its period that outlived it to run: a witness of that period fires a few times.
      let fired = 0;
      const witness = setInterval(() => fired++, 1);
      await waitFor(() => fired >= 5);
      clearInterval(witness);
      expect(seen.length).toBe(ticks);
      dispose();
    });
    // Outside any plugin's slot item, there is no plugin to find.
    expect(() => createRoot(() => usePlugin())).toThrow(/outside any plugin's slot item/);
  });

  it("keeps a running plugin's helpers for what it draws when its replacement fails to start", async () => {
    const Views = defineSlot<{ readonly component: Component }>("test.views");
    const found: string[] = [];
    const View: Component = () => {
      found.push(usePlugin().id);
      return null;
    };
    const replaced = defineWebPlugin({
      id: "replaced",
      config: Schema.Struct({ broken: Schema.optional(Schema.Boolean) }),
      requires: { slots: Slots },
      setup: ({ slots }, plugin) => {
        if (plugin.config.broken === true) throw new Error("cannot start");
        slots.add(Views, { id: "view", component: View });
      },
    });
    await run([replaced], async (loader) => {
      const slots = await Effect.runPromise(loader.core.run(Slots));
      expect(Exit.isFailure(await Effect.runPromiseExit(loader.apply({ plugins: { replaced: { config: { broken: true } } } })))).toBe(true);
      // The instance it was to replace goes on, and what it draws still finds it.
      const item = slots.first(Views)!;
      createRoot((dispose) => {
        createComponent(SlotsContext.Provider, {
          value: () => slots,
          get children() {
            return createComponent(Contained, { slot: Views, item, component: item.component });
          },
        });
        dispose();
      });
      expect(found).toEqual(["replaced"]);
    });
  });

  it("draws what a plugin hands a part (its children) as that plugin's, though another plugin provides the part", async () => {
    const Views = defineSlot<{ readonly component: Component }>("test.views");
    const Box = definePart<{ readonly children: JSX.Element }>("test.box");
    const Popup = definePart<{ readonly children: (close: () => void) => JSX.Element }>("test.popup");
    const [BoxView, PopupView] = [partView(Box), partView(Popup)];
    const seen: string[] = [];
    const Probe: Component<{ readonly name: string }> = (props) => {
      seen.push(`${props.name} as ${usePlugin().id}`);
      return null;
    };
    const boxer = defineWebPlugin({
      id: "boxer",
      requires: { slots: Slots },
      setup: ({ slots }) => {
        slots.add(Box, { id: "box", component: (props) => [createComponent(Probe, { name: "the box" }), props.children] as unknown as JSX.Element });
        slots.add(Popup, { id: "popup", component: (props) => props.children(() => {}) });
      },
    });
    const caller = defineWebPlugin({
      id: "caller",
      requires: { slots: Slots },
      setup: ({ slots }) =>
        void slots.add(Views, {
          id: "view",
          component: () =>
            [
              createComponent(BoxView, {
                get children() {
                  return createComponent(Probe, { name: "box content" });
                },
              }),
              createComponent(PopupView, { children: () => createComponent(Probe, { name: "popup content" }) }),
              // The same handed on through a getter, as a spread or `splitProps` hands it: still a function to call.
              createComponent(PopupView, {
                get children() {
                  return (close: unknown) => createComponent(Probe, { name: `popup content, by a getter, given ${typeof close}` });
                },
              }),
            ] as unknown as JSX.Element,
        }),
    });
    await run([boxer, caller], async (loader) => {
      const slots = await Effect.runPromise(loader.core.run(Slots));
      const item = slots.first(Views)!;
      createRoot((dispose) => {
        createComponent(SlotsContext.Provider, {
          value: () => slots,
          get children() {
            return createComponent(Contained, { slot: Views, item, component: item.component });
          },
        });
        dispose();
      });
      expect(seen).toEqual(["the box as boxer", "box content as caller", "popup content as caller", "popup content, by a getter, given function as caller"]);
    });
  });

  it("keeps what a plugin hands a part up to date where the part draws it, and its own however it is handed", async () => {
    const Views = defineSlot<{ readonly component: Component }>("test.views");
    const Box = definePart<{ readonly name: string; readonly children: JSX.Element }>("test.box");
    const BoxView = partView(Box);
    // `<Show>` as JSX draws it, unkeyed.
    const Unkeyed: Component<{ readonly when: boolean; readonly fallback: JSX.Element; readonly children: JSX.Element }> = Show;
    const [on, setOn] = createSignal(false);
    const drawn: string[] = [];
    const seen: string[] = [];
    const Probe: Component<{ readonly name: string }> = (props) => {
      seen.push(`${props.name} as ${usePlugin().id}`);
      return null;
    };
    const boxer = defineWebPlugin({
      id: "boxer",
      requires: { slots: Slots },
      // Reads its children as `insert` does: a function, called with nothing in a computation of its own.
      setup: ({ slots }) =>
        void slots.add(Box, {
          id: "box",
          component: (props) => {
            const shown = children(() => props.children);
            createRenderEffect(() =>
              drawn.push(
                `${props.name}: ${shown
                  .toArray()
                  .filter((each) => typeof each === "string")
                  .join("")}`,
              ),
            );
            return null;
          },
        }),
    });
    const caller = defineWebPlugin({
      id: "caller",
      requires: { slots: Slots },
      setup: ({ slots }) =>
        void slots.add(Views, {
          id: "view",
          component: () =>
            [
              createComponent(BoxView, {
                name: "a <Show>",
                get children() {
                  return createComponent(Unkeyed, {
                    get when() {
                      return on();
                    },
                    fallback: "off",
                    children: "on",
                  });
                },
              }),
              createComponent(BoxView, {
                name: "a condition",
                get children() {
                  return on() ? "on" : "off";
                },
              }),
              createComponent(BoxView, {
                name: "a function",
                children: (() => [createComponent(Probe, { name: "a function's" }), on() ? "on" : "off"]) as unknown as JSX.Element,
              }),
            ] as unknown as JSX.Element,
        }),
    });
    await run([boxer, caller], async (loader) => {
      const slots = await Effect.runPromise(loader.core.run(Slots));
      const item = slots.first(Views)!;
      const dispose = createRoot((dispose) => {
        createComponent(SlotsContext.Provider, {
          value: () => slots,
          get children() {
            return createComponent(Contained, { slot: Views, item, component: item.component });
          },
        });
        return dispose;
      });
      setOn(true);
      dispose();
      const names = ["a <Show>", "a condition", "a function"];
      expect(names.map((name) => drawn.find((entry) => entry.startsWith(`${name}:`)))).toEqual(names.map((name) => `${name}: off`));
      expect(names.map((name) => drawn.filter((entry) => entry.startsWith(`${name}:`)).at(-1))).toEqual(names.map((name) => `${name}: on`));
      // Drawn again as it changed, and the caller's each time.
      expect(new Set(seen)).toEqual(new Set(["a function's as caller"]));
    });
  });

  it("gives it its own view of the connection: its subscriptions end and its calls are refused when it stops", async () => {
    const open = new Set<string>();
    const subscribe = (name: string) => () => {
      open.add(name);
      return () => void open.delete(name);
    };
    const client = {
      onEvent: subscribe("events"),
      onConnect: subscribe("connect"),
      follow: subscribe("follow"),
      channel: { list: async () => [], call: () => new Promise(() => {}), open: subscribe("open") },
      plugins: async () => [],
      web: { composition: async () => ({}) },
    } as unknown as ClientService;
    let pending: Promise<unknown> | undefined;
    let mine: ClientService | undefined;
    const caller = defineWebPlugin({
      id: "caller",
      requires: { client: Client },
      setup: ({ client }) => {
        mine = client;
        client.onEvent(() => {});
        client.follow("sessions.log", {}, () => {});
        const end = client.onConnect(() => {});
        end();
        pending = client.channel.call("slow", {});
      },
    });
    await run(
      [caller],
      async (loader) => {
        expect([...open].sort()).toEqual(["events", "follow"]);
        await Effect.runPromise(loader.apply({ plugins: { caller: { enabled: false } } }));
        expect(open.size).toBe(0);
        // The answer it waited for never lands in it, and what it calls afterwards is refused.
        await expect(pending).rejects.toBeInstanceOf(PluginStopped);
        await expect(mine!.plugins()).rejects.toMatchObject({ pluginId: "caller", operation: "plugins" });
        expect(mine!.onEvent(() => {})).toBeTypeOf("function");
        expect(open.size).toBe(0);
      },
      undefined,
      connected(client),
    );
  });

  it("a setup that throws fails only its own plugin, releasing what it added", async () => {
    const broken = defineWebPlugin({
      id: "broken",
      requires: { slots: Slots },
      setup: ({ slots }) => {
        slots.add(Items, { id: "broken", label: "half-made" });
        throw new Error("boom");
      },
    });
    await run(
      [broken],
      async (loader) => {
        const slots = await Effect.runPromise(loader.core.run(Slots));
        const applied = await Effect.runPromiseExit(loader.apply({ plugins: { broken: {} } }));
        expect(applied._tag).toBe("Failure");
        expect(slots.list(Items)).toEqual([]);
        // The rest keeps running.
        expect(await Effect.runPromise(loader.core.run(Slots))).toBe(slots);
      },
      [],
    );
  });
});
