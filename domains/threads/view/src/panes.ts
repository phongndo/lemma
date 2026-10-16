/**
 * A thread page's panes, as Ghostty splits a window: a tree whose leaves are
 * panes, each showing one of the thread's views, and whose inner nodes split
 * their area in two. Every function returns a new tree; a pane keeps its id
 * wherever it moves, so what draws it can stay mounted.
 */
export type PaneTree = PaneLeaf | PaneSplit;

export interface PaneLeaf {
  readonly kind: "pane";
  readonly id: string;
  /** A `Views` item's id. */
  readonly view: string;
}

export interface PaneSplit {
  readonly kind: "split";
  /** `row` puts its halves side by side, `column` one above the other. */
  readonly dir: "row" | "column";
  /** The first half's share, 0 to 1. */
  readonly ratio: number;
  readonly first: PaneTree;
  readonly second: PaneTree;
}

/** Where on a pane another lands: the half it takes. */
export type Edge = "left" | "right" | "top" | "bottom";

/** A box in the page's panes area, each side a share of it from 0 to 1. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Which split a path names: from the root, `first` or `second` at each step. */
export type SplitPath = readonly ("first" | "second")[];

export const MIN_RATIO = 0.15;

export const single = (view: string, id = "p1"): PaneLeaf => ({ kind: "pane", id, view });

/** The panes, in reading order. */
export const panesOf = (tree: PaneTree): readonly PaneLeaf[] => (tree.kind === "pane" ? [tree] : [...panesOf(tree.first), ...panesOf(tree.second)]);

export const findPane = (tree: PaneTree, id: string): PaneLeaf | undefined => panesOf(tree).find((pane) => pane.id === id);

/** An id no pane in `tree` has. */
export const freshId = (tree: PaneTree): string => {
  const taken = new Set(panesOf(tree).map((pane) => pane.id));
  let n = taken.size + 1;
  while (taken.has(`p${n}`)) n++;
  return `p${n}`;
};

const mapPanes = (tree: PaneTree, at: (pane: PaneLeaf) => PaneTree): PaneTree =>
  tree.kind === "pane" ? at(tree) : { ...tree, first: mapPanes(tree.first, at), second: mapPanes(tree.second, at) };

/** `leaf` beside the pane `target`, taking the half of its area at `edge`. */
export const splitAt = (tree: PaneTree, target: string, edge: Edge, leaf: PaneLeaf): PaneTree =>
  mapPanes(tree, (pane) => {
    if (pane.id !== target) return pane;
    const dir = edge === "left" || edge === "right" ? "row" : "column";
    const before = edge === "left" || edge === "top";
    return { kind: "split", dir, ratio: 0.5, first: before ? leaf : pane, second: before ? pane : leaf };
  });

/** Without the pane `id`, its sibling taking the split's place; undefined when it was the only pane. */
export const removePane = (tree: PaneTree, id: string): PaneTree | undefined => {
  if (tree.kind === "pane") return tree.id === id ? undefined : tree;
  const first = removePane(tree.first, id);
  const second = removePane(tree.second, id);
  if (first === undefined) return second;
  if (second === undefined) return first;
  return first === tree.first && second === tree.second ? tree : { ...tree, first, second };
};

/** The pane `id` taken from where it is and put at `edge` of `target`; as it was when either is missing or they are one. */
export const movePane = (tree: PaneTree, id: string, target: string, edge: Edge): PaneTree => {
  const pane = findPane(tree, id);
  if (pane === undefined || id === target || findPane(tree, target) === undefined) return tree;
  const without = removePane(tree, id);
  return without === undefined ? tree : splitAt(without, target, edge, pane);
};

export const setView = (tree: PaneTree, id: string, view: string): PaneTree => mapPanes(tree, (pane) => (pane.id === id ? { ...pane, view } : pane));

/** The split at `path` with its first half's share set, kept between `MIN_RATIO` and its complement. */
export const resize = (tree: PaneTree, path: SplitPath, ratio: number): PaneTree => {
  if (tree.kind === "pane") return tree;
  const clamped = Math.min(1 - MIN_RATIO, Math.max(MIN_RATIO, ratio));
  const [step, ...rest] = path;
  if (step === undefined) return { ...tree, ratio: clamped };
  return { ...tree, [step]: resize(tree[step], rest, ratio) };
};

/** Each pane's box, by id. */
export const rects = (tree: PaneTree, area: Rect = { x: 0, y: 0, w: 1, h: 1 }): ReadonlyMap<string, Rect> => {
  if (tree.kind === "pane") return new Map([[tree.id, area]]);
  const [a, b] = halves(tree, area);
  return new Map([...rects(tree.first, a), ...rects(tree.second, b)]);
};

const halves = (split: PaneSplit, area: Rect): readonly [Rect, Rect] =>
  split.dir === "row"
    ? [
        { ...area, w: area.w * split.ratio },
        { ...area, x: area.x + area.w * split.ratio, w: area.w * (1 - split.ratio) },
      ]
    : [
        { ...area, h: area.h * split.ratio },
        { ...area, y: area.y + area.h * split.ratio, h: area.h * (1 - split.ratio) },
      ];

/** Every split: where it is, the area it divides, and its direction, for drawing and dragging its divider. */
export const splits = (
  tree: PaneTree,
  area: Rect = { x: 0, y: 0, w: 1, h: 1 },
  path: SplitPath = [],
): readonly { readonly path: SplitPath; readonly area: Rect; readonly split: PaneSplit }[] => {
  if (tree.kind === "pane") return [];
  const [a, b] = halves(tree, area);
  return [{ path, area, split: tree }, ...splits(tree.first, a, [...path, "first"]), ...splits(tree.second, b, [...path, "second"])];
};

const EPSILON = 1e-6;

/** The pane next to `id` toward `edge`: of those sharing that side, the one nearest its middle. */
export const neighbor = (tree: PaneTree, id: string, edge: Edge): string | undefined => {
  const boxes = rects(tree);
  const from = boxes.get(id);
  if (from === undefined) return undefined;
  const across = edge === "left" || edge === "right";
  const touches = (to: Rect) =>
    edge === "left"
      ? Math.abs(to.x + to.w - from.x) < EPSILON
      : edge === "right"
        ? Math.abs(from.x + from.w - to.x) < EPSILON
        : edge === "top"
          ? Math.abs(to.y + to.h - from.y) < EPSILON
          : Math.abs(from.y + from.h - to.y) < EPSILON;
  const overlap = (to: Rect) =>
    across ? Math.min(from.y + from.h, to.y + to.h) - Math.max(from.y, to.y) : Math.min(from.x + from.w, to.x + to.w) - Math.max(from.x, to.x);
  const middle = (box: Rect) => (across ? box.y + box.h / 2 : box.x + box.w / 2);
  let best: { readonly id: string; readonly distance: number } | undefined;
  for (const [other, box] of boxes) {
    if (other === id || !touches(box) || overlap(box) <= EPSILON) continue;
    const distance = Math.abs(middle(box) - middle(from));
    if (best === undefined || distance < best.distance) best = { id: other, distance };
  }
  return best?.id;
};

/** The half of a pane a point is over, as a share of its box from its top left: the side it is nearest to. */
export const edgeAt = (x: number, y: number): Edge => {
  const dx = x - 0.5;
  const dy = y - 0.5;
  return Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? "left" : "right") : dy < 0 ? "top" : "bottom";
};

/** Whether `value` is a tree these functions can work on, for one read back from storage. */
export const isPaneTree = (value: unknown): value is PaneTree => {
  if (typeof value !== "object" || value === null) return false;
  const node = value as Record<string, unknown>;
  if (node.kind === "pane") return typeof node.id === "string" && typeof node.view === "string";
  return (
    node.kind === "split" &&
    (node.dir === "row" || node.dir === "column") &&
    typeof node.ratio === "number" &&
    isPaneTree(node.first) &&
    isPaneTree(node.second)
  );
};
