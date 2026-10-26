import { defineSlot } from "@lemma/web";
import type { Region } from "@lemma/web";
import { Context } from "effect";
import type { Accessor, Component } from "solid-js";

export interface DialogsService {
  /** The open dialog's id; one at a time. Dialog plugins show themselves when theirs is current. */
  readonly current: Accessor<string | undefined>;
  readonly open: (id: string | undefined) => void;
}

export class Dialogs extends Context.Service<Dialogs, DialogsService>()("lemma-web/Dialogs") {}

export interface LayoutService {
  /** There is a sidebar, and it is out of view: collapsed, or a closed drawer on a narrow screen. */
  readonly sidebarHidden: Accessor<boolean>;
  /**
   * Collapses or brings back the sidebar; on a narrow screen opens or closes it as a drawer, which takes focus while
   * open and gives it back as it closes. A control that runs it is marked `data-sidebar-toggle` (a DOM convention):
   * when toggling hides the control that had focus (the sidebar's own toggle as it collapses, a header's as the
   * sidebar comes back), focus goes to the marked toggle in sight.
   */
  readonly toggleSidebar: () => void;
  /** On a narrow screen the sidebar is a drawer; picking something in it closes it. */
  readonly closeDrawer: () => void;
}

export class Layout extends Context.Service<Layout, LayoutService>()("lemma-web/Layout") {}

/**
 * Mounted over the whole app in order: the browser view's pages (0, each over its place in the pane), dialogs (the
 * bundled ones at orders 10 to 40), questions (50), toasts (100), the threads' notices (110), tooltips (200). Each
 * shows itself when it should. The toasts' stack, at the top right, is the CSS anchor `--toasts`: what else stacks
 * there goes under it with `top: anchor(--toasts bottom, 56px)`, from an item after it (an anchor comes first in the
 * page), as the notices do.
 */
export const Layers = defineSlot<Region>("layers");

/** Panels docked under the app (the devtools), in order: the app shrinks to the space above them. Each sizes itself and shows itself when it should. */
export const Docks = defineSlot<Region>("docks");

export const SidebarRegion = defineSlot<Region<{ readonly onPick: () => void }>>("sidebar", { shows: "first" });

export const MainRegion = defineSlot<Region>("main", { shows: "first" });

/**
 * A bar across the window's top, over the sidebar and the main region: horizontal tabs. In a desktop window it is the
 * title bar, beside the window's controls (`--titlebar-inset` is their width); what it draws drags the window unless
 * it is a control.
 */
export const TopRegion = defineSlot<Region>("top", { shows: "first" });

/** Buttons at the end of the sidebar's head, across from its toggle: the sidebar's search and new thread are its defaults. `onPick` closes the drawer on narrow screens. */
export const SidebarActions = defineSlot<Region<{ readonly onPick: () => void }>>("sidebar.actions");

/** Items at the foot of the sidebar: the settings button, the connection badge. `onPick` closes the drawer on narrow screens. */
export const SidebarFooter = defineSlot<Region<{ readonly onPick: () => void }>>("sidebar.footer");

/** An item in a menu about one thing: a session, a project. */
export interface MenuAction<Subject, Control = undefined> {
  readonly label: (subject: Subject) => string;
  readonly icon?: Component;
  /** Shown in red: it destroys something. */
  readonly danger?: boolean;
  /**
   * When it returns text, the first pick shows that, drawn as a danger button, and only a second pick runs the action.
   * Deleting one thing says `CONFIRM_DELETE` (`@lemma/look`), as everywhere one thing is deleted in place.
   */
  readonly confirm?: (subject: Subject) => string | undefined;
  readonly when?: (subject: Subject) => boolean;
  /** Starts a group: a separator comes before it. */
  readonly section?: boolean;
  readonly run: (subject: Subject, control: Control) => void;
}

/**
 * In the desktop app's window (`window.lemmaDesktop`), which, unlike a browser, hands the page the keys a browser keeps
 * for its tabs, windows, and history: ⌘T, ⌘W, ⌘N, ⌘L, ⌘[ and ⌘] (Alt+← and Alt+→ off macOS), ⌘⇧[ and ⌘⇧]. An action
 * binds those only here: in a browser the page never hears some of them, and taking the rest would stop the browser's
 * own (⌘[ going back).
 */
export const inDesktop = typeof window !== "undefined" && "lemmaDesktop" in window;

export { ActionMenu } from "./menu.tsx";
export { FRAME_CONTRACT } from "./version.ts";
