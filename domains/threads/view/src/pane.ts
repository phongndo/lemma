/**
 * Each thread's inspection pane, as plain data: whether it is open, its tabs (views opened in it) in their order, the
 * one shown, and whether it fills the page. Every function returns a new state.
 */

/** A tab: a `Views` item's, with an id no other tab of any thread has. */
export interface Tab {
  readonly id: string;
  readonly view: string;
}

export interface PaneState {
  readonly open: boolean;
  readonly tabs: readonly Tab[];
  /** The tab shown while the pane is open. */
  readonly active?: string | undefined;
  /** It fills the page, the chat out of sight. */
  readonly maximized?: boolean | undefined;
}

/** Each thread's pane, by its session id; a thread with none has a closed, empty one. */
export type Panes = Readonly<Record<string, PaneState>>;

export const EMPTY: PaneState = { open: false, tabs: [] };

const isTab = (value: unknown): value is Tab =>
  typeof value === "object" && value !== null && typeof (value as Tab).id === "string" && typeof (value as Tab).view === "string";

const isState = (value: unknown): value is PaneState =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as PaneState).open === "boolean" &&
  Array.isArray((value as PaneState).tabs) &&
  (value as PaneState).tabs.every(isTab);

/** Stored panes, without what is not one. */
export const readPanes = (value: unknown): Panes =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter(([, state]) => isState(state))) : {};

export const paneOf = (panes: Panes, thread: string): PaneState => panes[thread] ?? EMPTY;

/** `panes` with the thread's pane `state`; one closed and empty is dropped. */
export const withPane = (panes: Panes, thread: string, state: PaneState): Panes => {
  const { [thread]: _old, ...rest } = panes;
  return state.open || state.tabs.length > 0 ? { ...rest, [thread]: state } : rest;
};

/** Without the panes of threads not in `threads` (deleted ones). */
export const pruned = (panes: Panes, threads: ReadonlySet<string>): Panes =>
  Object.fromEntries(Object.entries(panes).filter(([thread]) => threads.has(thread)));

/** A tab id no tab of `panes` has: the view's, and a few letters. */
export const freshId = (panes: Panes, view: string, random: () => string): string => {
  const taken = new Set(Object.values(panes).flatMap((state) => state.tabs.map((tab) => tab.id)));
  let id = `${view}-${random()}`;
  while (taken.has(id)) id = `${view}-${random()}`;
  return id;
};

/** `tab` after the others, shown (opening the pane), or, in the `background`, left for later while another shows. */
export const withTab = (state: PaneState, tab: Tab, background = false): PaneState =>
  background && state.open && state.active !== undefined
    ? { ...state, tabs: [...state.tabs, tab] }
    : { ...state, open: true, tabs: [...state.tabs, tab], active: tab.id };

/** The pane open at the tab `id`. */
export const showing = (state: PaneState, id: string): PaneState => ({ ...state, open: true, active: id });

/**
 * Which tabs show: a view whose plugin is off has its tabs hidden, kept in their places for when it is back. Every
 * function below that closes tabs or picks one to show counts only the ones that show.
 */
export type Shows = (tab: Tab) => boolean;

const all: Shows = () => true;

/**
 * Without the tab `id`: when it shows, the one after it shows instead, else the one before. Without its last tab the
 * pane closes.
 */
export const withoutTab = (state: PaneState, id: string, shows: Shows = all): PaneState => {
  const shown = state.tabs.filter(shows);
  const at = shown.findIndex((tab) => tab.id === id);
  if (!state.tabs.some((tab) => tab.id === id)) return state;
  const rest = shown.filter((tab) => tab.id !== id);
  const active = state.active === id ? rest[Math.min(Math.max(at, 0), rest.length - 1)]?.id : state.active;
  return settled({ ...state, tabs: state.tabs.filter((tab) => tab.id !== id), active }, shows);
};

/** Only the tab `id` of the ones that show, shown. */
export const onlyTab = (state: PaneState, id: string, shows: Shows = all): PaneState =>
  settled({ ...state, tabs: state.tabs.filter((tab) => tab.id === id || !shows(tab)), active: id }, shows);

/** Without the tabs that show after `id`; `id` shows when the one shown was among them. */
export const withoutRightOf = (state: PaneState, id: string, shows: Shows = all): PaneState => {
  const at = state.tabs.findIndex((tab) => tab.id === id);
  if (at === -1) return state;
  const tabs = state.tabs.filter((tab, index) => index <= at || !shows(tab));
  return settled({ ...state, tabs, active: tabs.some((tab) => tab.id === state.active && shows(tab)) ? state.active : id }, shows);
};

/** None of the tabs that show: the pane closes. */
export const withoutTabs = (state: PaneState, shows: Shows = all): PaneState =>
  settled({ ...state, tabs: state.tabs.filter((tab) => !shows(tab)), active: undefined }, shows);

/** A pane with no tab that shows is closed, and only an open one fills the page. */
const settled = (state: PaneState, shows: Shows): PaneState => {
  const open = state.open && state.tabs.some(shows);
  return { ...state, open, maximized: open ? state.maximized : undefined };
};

/** The tab `id` at `index` among the tabs that show; the hidden ones keep their places. */
export const moved = (state: PaneState, id: string, index: number, shows: Shows = all): PaneState => {
  const moving = state.tabs.find((tab) => tab.id === id);
  if (moving === undefined) return state;
  const shown = state.tabs.filter((tab) => tab !== moving && shows(tab));
  shown.splice(Math.max(0, Math.min(shown.length, index)), 0, moving);
  let next = 0;
  return { ...state, tabs: state.tabs.map((tab) => (tab === moving || shows(tab) ? shown[next++]! : tab)) };
};

/** Closed, no longer filling the page; or open at the tab shown last, else the first that shows, else empty. */
export const toggled = (state: PaneState, shows: Shows = all): PaneState => {
  if (state.open) return { ...state, open: false, maximized: undefined };
  const last = state.tabs.find((tab) => tab.id === state.active && shows(tab));
  return { ...state, open: true, active: (last ?? state.tabs.find(shows))?.id };
};
