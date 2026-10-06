import { createComponent, createEffect, createRoot, createSignal } from "solid-js";
import { describe, expect, test } from "vitest";
import { createMemoryHistory, createNavigator, createRouteTable, defineRoute } from "@lemma/router";
import type { AnyRoute } from "@lemma/router";
import { RouterProvider, useLocation, useMatch, useNavigator } from "../src/context.ts";
import { ActiveContext, createKeepAlive, onResume, onSuspend, useActive } from "../src/keep-alive.ts";

const Item = defineRoute("item", { path: "/items/:id" });
const Home = defineRoute("home", { path: "/" });

describe("RouterProvider", () => {
  test("hands each part of a page its own navigator over one table", () => {
    const table = createRouteTable<{ readonly route: AnyRoute }>();
    table.setEntries([{ route: Home }, { route: Item }]);
    const left = createNavigator(table, { history: createMemoryHistory("/items/1") });
    const right = createNavigator(table, { history: createMemoryHistory("/") });
    const read: Record<string, string[]> = { left: [], right: [] };
    const provided: Record<string, unknown> = {};
    const dispose = createRoot((dispose) => {
      for (const [name, navigator] of [
        ["left", left],
        ["right", right],
      ] as const) {
        createComponent(RouterProvider, {
          navigator,
          get children() {
            const item = useMatch(Item);
            const location = useLocation();
            provided[name] = useNavigator();
            createEffect(() => read[name]!.push(item()?.params.id ?? location().pathname));
            return undefined;
          },
        });
      }
      return dispose;
    });
    expect(provided).toEqual({ left, right });
    expect(read).toEqual({ left: ["1"], right: ["/"] });
    left.navigate("/items/2");
    expect(read).toEqual({ left: ["1", "2"], right: ["/"] });
    right.navigate("/items/9");
    expect(read).toEqual({ left: ["1", "2"], right: ["/", "9"] });
    // Removed, a provider's signals stop following its navigator.
    dispose();
    left.navigate("/items/3");
    expect(read.left).toEqual(["1", "2"]);
  });

  test("follows a navigator it is given in place of its first", () => {
    const table = createRouteTable<{ readonly route: AnyRoute }>();
    table.setEntries([{ route: Home }, { route: Item }]);
    const first = createNavigator(table, { history: createMemoryHistory("/items/1") });
    const second = createNavigator(table, { history: createMemoryHistory("/items/2") });
    const [navigator, setNavigator] = createSignal(first);
    const read: (string | undefined)[] = [];
    const dispose = createRoot((dispose) => {
      createComponent(RouterProvider, {
        get navigator() {
          return navigator();
        },
        get children() {
          const item = useMatch(Item);
          createEffect(() => read.push(item()?.params.id));
          return undefined;
        },
      });
      return dispose;
    });
    setNavigator(second);
    first.navigate("/items/3");
    second.navigate("/items/4");
    expect(read).toEqual(["1", "2", "4"]);
    dispose();
  });

  test("outside a provider, the hooks say what is missing", () => {
    expect(() => createRoot(() => useMatch(Item))).toThrow(/needs a RouterProvider/);
    expect(() => createRoot(() => useNavigator())).toThrow(/needs a RouterProvider/);
  });
});

describe("createKeepAlive", () => {
  test("keeps the active key and the most recent others, in a stable order, up to the limit", () => {
    createRoot((dispose) => {
      const [active, setActive] = createSignal<string | undefined>("a");
      const [keep, setKeep] = createSignal(3);
      const state = createKeepAlive(active, keep);
      expect(state.mounted()).toEqual(["a"]);
      setActive("b");
      setActive("c");
      expect(state.mounted()).toEqual(["a", "b", "c"]);
      // Back to a: nothing moves, nothing is dropped.
      setActive("a");
      expect(state.mounted()).toEqual(["a", "b", "c"]);
      expect(state.isActive("a")).toBe(true);
      // A fourth drops the least recent (b), keeping the others where they were.
      setActive("d");
      expect(state.mounted()).toEqual(["a", "c", "d"]);
      setKeep(1);
      expect(state.mounted()).toEqual(["d"]);
      setActive(undefined);
      expect(state.mounted()).toEqual(["d"]);
      dispose();
    });
  });

  test("drops a key that is no longer open at once, and takes a limit it cannot use as the default", () => {
    createRoot((dispose) => {
      const [active, setActive] = createSignal<string | undefined>("a");
      const [open, setOpen] = createSignal<readonly string[]>(["a", "b", "c"]);
      const state = createKeepAlive(active, () => Number.NaN, open);
      setActive("b");
      setActive("c");
      expect(state.mounted()).toEqual(["a", "b", "c"]);
      // Tab b closes: its view goes now, not when newer ones push it out.
      setOpen(["a", "c"]);
      setActive("a");
      expect(state.mounted()).toEqual(["a", "c"]);
      // An id used again mounts a new view: none of the old one is left to bring back.
      setOpen(["a", "b", "c"]);
      setActive("b");
      expect(state.mounted()).toEqual(["a", "c", "b"]);
      for (const key of ["d", "e", "f", "g"]) {
        setOpen([...open(), key]);
        setActive(key);
      }
      expect(state.mounted()).toHaveLength(5);
      dispose();
    });
  });

  test("a view hears when it is suspended and resumed; outside a KeepAlive it is active", () => {
    const heard: string[] = [];
    createRoot((dispose) => {
      expect(useActive()()).toBe(true);
      dispose();
    });
    const [active, setActive] = createSignal(true);
    const dispose = createRoot((dispose) => {
      // A view under a provider of its activity, as KeepAlive provides it.
      const view = () => {
        onSuspend(() => heard.push("suspended"));
        onResume(() => heard.push("resumed"));
        return undefined;
      };
      createComponent(ActiveContext.Provider, {
        value: active,
        get children() {
          return view();
        },
      });
      return dispose;
    });
    setActive(false);
    setActive(true);
    setActive(true);
    expect(heard).toEqual(["suspended", "resumed"]);
    dispose();
  });
});
