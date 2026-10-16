import { describe, expect, test } from "vitest";
import {
  edgeAt,
  findPane,
  freshId,
  isPaneTree,
  movePane,
  neighbor,
  panesOf,
  rects,
  removePane,
  resize,
  setView,
  single,
  splitAt,
  splits,
} from "../src/panes.ts";
import type { PaneTree } from "../src/panes.ts";

const views = (tree: PaneTree) => panesOf(tree).map((pane) => pane.view);
// transcript | trajectory, the right half split into trajectory over browser.
const three = splitAt(splitAt(single("transcript"), "p1", "right", single("trajectory", "p2")), "p2", "bottom", single("browser", "p3"));

describe("splitting and removing", () => {
  test("a pane put at an edge takes that half, before or after the target", () => {
    expect(views(splitAt(single("a"), "p1", "right", single("b", "p2")))).toEqual(["a", "b"]);
    expect(views(splitAt(single("a"), "p1", "left", single("b", "p2")))).toEqual(["b", "a"]);
    const down = splitAt(single("a"), "p1", "bottom", single("b", "p2"));
    expect(down.kind === "split" && down.dir).toBe("column");
  });

  test("removing a pane gives its split's place to its sibling; the last one leaves nothing", () => {
    expect(views(removePane(three, "p2")!)).toEqual(["transcript", "browser"]);
    expect(removePane(single("a"), "p1")).toBeUndefined();
  });

  test("a fresh id is one no pane has", () => {
    expect(freshId(three)).toBe("p4");
    expect(["p2", "p3"]).not.toContain(freshId(removePane(three, "p1")!));
  });
});

describe("moving", () => {
  test("a pane moves to another's edge, keeping its id", () => {
    const moved = movePane(three, "p1", "p3", "right");
    expect(views(moved)).toEqual(["trajectory", "browser", "transcript"]);
    expect(findPane(moved, "p1")?.view).toBe("transcript");
  });

  test("onto itself, or to a pane that is not there, nothing moves", () => {
    expect(movePane(three, "p1", "p1", "left")).toBe(three);
    expect(movePane(three, "p1", "nope", "left")).toBe(three);
  });
});

describe("geometry", () => {
  test("boxes follow the splits' ratios", () => {
    const boxes = rects(resize(three, [], 0.6));
    expect(boxes.get("p1")).toEqual({ x: 0, y: 0, w: 0.6, h: 1 });
    expect(boxes.get("p3")!.y).toBeCloseTo(0.5);
  });

  test("a ratio stays clear of the edges", () => {
    const tight = resize(three, ["second"], 0.01);
    expect(tight.kind === "split" && tight.second.kind === "split" && tight.second.ratio).toBe(0.15);
  });

  test("every split is listed with its path, for its divider", () => {
    expect(splits(three).map((entry) => entry.path)).toEqual([[], ["second"]]);
  });

  test("the neighbor toward an edge shares that side", () => {
    expect(neighbor(three, "p1", "right")).toBe("p2");
    expect(neighbor(three, "p3", "left")).toBe("p1");
    expect(neighbor(three, "p2", "bottom")).toBe("p3");
    expect(neighbor(three, "p1", "left")).toBeUndefined();
  });

  test("a point takes the half of the side it is nearest", () => {
    expect(edgeAt(0.1, 0.5)).toBe("left");
    expect(edgeAt(0.9, 0.4)).toBe("right");
    expect(edgeAt(0.5, 0.05)).toBe("top");
    expect(edgeAt(0.45, 0.95)).toBe("bottom");
  });
});

test("a view is set in place, and a stored tree is checked before use", () => {
  expect(findPane(setView(three, "p3", "todo"), "p3")?.view).toBe("todo");
  expect(isPaneTree(JSON.parse(JSON.stringify(three)))).toBe(true);
  expect(isPaneTree({ kind: "split", dir: "diagonal" })).toBe(false);
});
