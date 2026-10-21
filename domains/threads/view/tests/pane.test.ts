import { describe, expect, test } from "vitest";
import {
  EMPTY,
  freshId,
  moved,
  onlyTab,
  pruned,
  readPanes,
  shareOf,
  toggled,
  withPane,
  withTab,
  withoutRightOf,
  withoutTab,
  withoutTabs,
} from "../src/pane.ts";
import type { PaneState, Tab } from "../src/pane.ts";

const tab = (id: string, view = id.split("-")[0]!): Tab => ({ id, view });
const ids = (state: PaneState) => state.tabs.map((each) => each.id);
const open = (...names: string[]): PaneState => ({ open: true, tabs: names.map((name) => tab(name)), active: names[0] });

describe("opening a tab", () => {
  test("opens the pane at it, after the others", () => {
    const state = withTab(EMPTY, tab("trace-a"));
    expect(state).toEqual({ open: true, tabs: [tab("trace-a")], active: "trace-a" });
    expect(ids(withTab(state, tab("browser-b")))).toEqual(["trace-a", "browser-b"]);
    expect(withTab(state, tab("browser-b")).active).toBe("browser-b");
  });

  test("in the background, leaves the one shown", () => {
    const state = withTab(open("trace-a"), tab("browser-b"), true);
    expect(state.active).toBe("trace-a");
    expect(ids(state)).toEqual(["trace-a", "browser-b"]);
  });

  test("in the background of a closed pane, shows it all the same", () => {
    expect(withTab(EMPTY, tab("browser-b"), true)).toMatchObject({ open: true, active: "browser-b" });
  });

  test("ids are new among every thread's tabs", () => {
    const letters = ["a", "a", "b"];
    expect(freshId({ t1: open("trace-a") }, "trace", () => letters.shift()!)).toBe("trace-b");
  });
});

describe("closing tabs", () => {
  test("the shown one gives way to the one after it, else the one before", () => {
    const state = { ...open("trace-a", "browser-b", "browser-c"), active: "browser-b" };
    expect(withoutTab(state, "browser-b")).toMatchObject({ open: true, active: "browser-c" });
    expect(withoutTab({ ...state, active: "browser-c" }, "browser-c")).toMatchObject({ open: true, active: "browser-b" });
    expect(withoutTab(state, "trace-a")).toMatchObject({ active: "browser-b" });
  });

  test("the last one closes the pane, which no longer fills the page", () => {
    expect(withoutTab({ ...open("trace-a"), maximized: true }, "trace-a")).toEqual({ open: false, tabs: [], active: undefined, maximized: undefined });
  });

  test("others, to the right, and all", () => {
    const state = { ...open("trace-a", "browser-b", "browser-c"), active: "browser-c" };
    expect(onlyTab(state, "browser-b")).toMatchObject({ tabs: [tab("browser-b")], active: "browser-b" });
    expect(withoutRightOf(state, "trace-a")).toMatchObject({ tabs: [tab("trace-a")], active: "trace-a" });
    expect(withoutRightOf({ ...state, active: "trace-a" }, "browser-b")).toMatchObject({ active: "trace-a" });
    expect(withoutTabs(state)).toMatchObject({ open: false, tabs: [] });
  });
});

describe("tabs of a view whose plugin is off", () => {
  const state: PaneState = { open: true, tabs: [tab("trace-a"), tab("todo-x"), tab("trace-c")], active: "trace-a" };
  const shows = (each: Tab) => each.view !== "todo";

  test("are passed over for the one shown next, and keep their places", () => {
    expect(withoutTab(state, "trace-a", shows)).toMatchObject({ open: true, active: "trace-c", tabs: [tab("todo-x"), tab("trace-c")] });
  });

  test("do not keep the pane open once the last tab that shows closes", () => {
    expect(withoutTab({ ...state, tabs: [tab("trace-a"), tab("todo-x")] }, "trace-a", shows)).toMatchObject({ open: false, tabs: [tab("todo-x")] });
  });

  test("stay when the others, those to the right, or all are closed", () => {
    expect(ids(onlyTab(state, "trace-c", shows))).toEqual(["todo-x", "trace-c"]);
    expect(ids(withoutRightOf(state, "trace-a", shows))).toEqual(["trace-a", "todo-x"]);
    expect(withoutTabs(state, shows)).toMatchObject({ open: false, tabs: [tab("todo-x")] });
  });

  test("are not opened at", () => {
    expect(toggled({ open: false, tabs: [tab("todo-x"), tab("trace-c")], active: "todo-x" }, shows)).toMatchObject({ open: true, active: "trace-c" });
  });
});

describe("moving a tab", () => {
  test("goes to its place among the shown ones; a hidden one keeps its own", () => {
    const state = open("trace-a", "todo-x", "browser-b", "browser-c");
    const shows = (each: Tab) => each.view !== "todo";
    expect(ids(moved(state, "browser-c", 0, shows))).toEqual(["browser-c", "todo-x", "trace-a", "browser-b"]);
    expect(ids(moved(state, "trace-a", 2, shows))).toEqual(["browser-b", "todo-x", "browser-c", "trace-a"]);
  });
});

describe("toggling", () => {
  test("opens at the tab last shown, else the first; closing leaves the page to the chat", () => {
    expect(toggled({ open: false, tabs: [tab("trace-a"), tab("browser-b")], active: "browser-b" })).toMatchObject({ open: true, active: "browser-b" });
    expect(toggled({ open: false, tabs: [tab("trace-a")] })).toMatchObject({ open: true, active: "trace-a" });
    expect(toggled({ ...open("trace-a"), maximized: true })).toMatchObject({ open: false, maximized: undefined });
  });

  test("never opens a pane with no tab to show", () => {
    expect(toggled(EMPTY)).toEqual(EMPTY);
    expect(toggled({ open: false, tabs: [tab("todo-x")] }, (each) => each.view !== "todo")).toMatchObject({ open: false });
  });
});

describe("its width", () => {
  const least = { pane: 280, chat: 360 };

  test("is its share of the page", () => {
    expect(shareOf(500, 1000, least)).toBe(0.5);
  });

  test("leaves the chat its least, and keeps its own", () => {
    expect(shareOf(900, 1000, least)).toBe(0.64);
    expect(shareOf(100, 1000, least)).toBe(0.28);
  });

  test("keeps its own least when the page is too narrow for both", () => {
    expect(shareOf(400, 500, least)).toBe(0.56);
  });

  test("is none for a page with no width", () => {
    expect(shareOf(400, 0, least)).toBeUndefined();
  });
});

describe("panes", () => {
  test("a closed, empty one is not kept; deleted threads' go", () => {
    expect(withPane({ t1: open("trace-a") }, "t1", EMPTY)).toEqual({});
    expect(pruned({ t1: open("trace-a"), t2: open("trace-b") }, new Set(["t2"]))).toEqual({ t2: open("trace-b") });
  });

  test("what is stored and is not a pane is dropped", () => {
    expect(readPanes({ t1: open("trace-a"), t2: { open: "yes", tabs: [] }, t3: { open: true, tabs: [{ id: 1 }] } })).toEqual({ t1: open("trace-a") });
    expect(readPanes(["t1"])).toEqual({});
  });
});
