import { defineSlot } from "@lemma/web";
import type { Component } from "solid-js";

/**
 * Something the user can do: listed in the command palette and, with `keys`,
 * bound to a shortcut. Keys are `mod+k`, `mod+shift+o`, `escape`, `/`; `mod`
 * is ⌘ on macOS and Ctrl elsewhere. When several match, the first in order
 * whose `when` holds runs.
 */
export interface Action {
  readonly title: string;
  /** Shown before the title, as in `Git: Switch branch…`. */
  readonly category?: string;
  readonly detail?: string;
  readonly keywords?: readonly string[];
  readonly icon?: Component;
  readonly keys?: string | readonly string[];
  /** Offered at all, in the palette and by its keys. */
  readonly when?: () => boolean;
  /** Its keys work while a dialog or question is open. */
  readonly global?: boolean;
  /** Its keys work in a text field; keys with `mod` always do. */
  readonly whileTyping?: boolean;
  /**
   * Its keys reach the app even while a web page in it has focus (the browser view's, in the desktop app), as a browser
   * keeps its tab keys from the page it shows; a page keeps the others (⌘B, ⌘I, ⌘K for its editors).
   */
  readonly inPages?: boolean;
  /** Not listed in the palette. */
  readonly hidden?: boolean;
  /**
   * Asks for a value in the palette first (the question is read when asked); `run` receives it.
   * Pressing its keys does the same: the keymap runs `ActionIds.palette` with this action's id.
   */
  readonly input?: () => { readonly title: string; readonly placeholder?: string };
  readonly run: (value?: string) => void;
}

export const Actions = defineSlot<Action>("actions");

/** Something the palette lists and runs. */
export interface PaletteItem {
  /** Stable across threads, for remembering recent choices; prefix it with your source's id. */
  readonly key: string;
  readonly title: string;
  /** Shown before the title, as in `Git: Switch branch…`. */
  readonly category?: string | undefined;
  readonly detail?: string | undefined;
  /** Matched too, more weakly than the title. */
  readonly keywords?: readonly string[] | undefined;
  readonly shortcut?: string | undefined;
  readonly icon?: Component | undefined;
  /** Marked as the current one (the open session). */
  readonly current?: boolean | undefined;
  /** Asks for a value in the palette first; `run` receives it. */
  readonly input?: (() => { readonly title: string; readonly placeholder?: string }) | undefined;
  /**
   * `run` works with the palette open, which shows the questions it asks,
   * until its promise settles; the palette then closes unless it resolved
   * false. Otherwise the palette closes first.
   */
  readonly keepOpen?: boolean | undefined;
  readonly run: (value?: string) => unknown;
}

/** Where the palette's items come from: its commands, threads, and projects are sources, and a plugin adds its own. */
export interface PaletteSource {
  /** What it holds, for the palette's hints: `commands`, `threads`. */
  readonly label: string;
  /** Its heading while browsing; without one its items lead. */
  readonly heading?: string;
  /** Typed first, searches only this source: `>`, `@`, `#`. */
  readonly prefix?: string;
  /** While browsing, at most this many of its items. */
  readonly browse?: number;
  readonly items: () => readonly PaletteItem[];
  /**
   * More items for what is typed, found elsewhere (the host's search), after its own: asked once typing pauses on two
   * or more letters, and again as the text changes; `signal` aborts once the answer is no longer wanted. They show in
   * the order given, under `searchHeading`, but for those whose `key` the results already hold. A rejection's message
   * shows in their place.
   */
  readonly search?: ((text: string, context: { readonly signal: AbortSignal }) => Promise<readonly PaletteItem[]>) | undefined;
  /** What its `search` looks through, as the heading its results show under, and in `Searching …`: `messages`. */
  readonly searchLabel?: string | undefined;
}

export const PaletteSources = defineSlot<PaletteSource>("palette.sources");

/**
 * Actions plugins run on each other by id (`slots.get(Actions, id)?.run()`),
 * so a plugin that replaces one keeps its id and what calls it keeps working.
 */
export const ActionIds = {
  /** Run with an action's id, opens asking for that action's value. */
  palette: "palette.open",
  /** Opens the palette searching threads only (its `@` source). */
  searchThreads: "palette.search-threads",
} as const;
