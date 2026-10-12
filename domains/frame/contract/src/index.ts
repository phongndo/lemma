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
  readonly toggleSidebar: () => void;
  /** On a narrow screen the sidebar is a drawer; picking something in it closes it. */
  readonly closeDrawer: () => void;
}

export class Layout extends Context.Service<Layout, LayoutService>()("lemma-web/Layout") {}

/**
 * Mounted over the whole app in order: dialogs (the bundled ones at orders 10 to 40), questions (50), toasts (100),
 * tooltips (200). Each shows itself when it should.
 */
export const Layers = defineSlot<Region>("layers");

/** Panels docked under the app (the devtools), in order: the app shrinks to the space above them. Each sizes itself and shows itself when it should. */
export const Docks = defineSlot<Region>("docks");

export const SidebarRegion = defineSlot<Region<{ readonly onPick: () => void }>>("sidebar", { shows: "first" });

export const MainRegion = defineSlot<Region>("main", { shows: "first" });

/** Buttons in the sidebar's head beside its search: add project and new chat are its defaults. `onPick` closes the drawer on narrow screens. */
export const SidebarActions = defineSlot<Region<{ readonly onPick: () => void }>>("sidebar.actions");

/** Items at the foot of the sidebar: the settings button, the connection badge. `onPick` closes the drawer on narrow screens. */
export const SidebarFooter = defineSlot<Region<{ readonly onPick: () => void }>>("sidebar.footer");

/** An item in a menu about one thing: a session, a project. */
export interface MenuAction<Subject, Control = undefined> {
  readonly label: (subject: Subject) => string;
  readonly icon?: Component;
  /** Shown in red: it destroys something. */
  readonly danger?: boolean;
  /** When it returns text, the first pick shows that and only a second pick runs the action. */
  readonly confirm?: (subject: Subject) => string | undefined;
  readonly when?: (subject: Subject) => boolean;
  /** Starts a group: a separator comes before it. */
  readonly section?: boolean;
  readonly run: (subject: Subject, control: Control) => void;
}
