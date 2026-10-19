import { defineSlot } from "@lemma/web";
import { Context } from "effect";
import type { Accessor, Component } from "solid-js";

/**
 * A panel in the devtools (`mod+shift+d`): the router, slots, and
 * capabilities are the bundled ones, and any plugin adds its own.
 */
export interface DevtoolsPanel {
  readonly title: string;
  readonly component: Component;
  /** What the panel shows, as plain JSON: for reading the app without a screen (a log, a test, an agent). */
  readonly snapshot?: () => unknown;
}

export const DevtoolsPanels = defineSlot<DevtoolsPanel>("devtools.panels");

/** The devtools panel showing one plugin: everything it does, and what depends on it. */
export const PLUGIN_PANEL = "devtools.plugins";

/**
 * The devtools panel showing a trace (`devtools.trace`'s, when it runs): its subject is a filter (`plugin:tools.bash`,
 * `turn:<id>`, `tool:<call id>`; see its README). A panel links to it only while `DevtoolsPanels` holds it.
 */
export const TRACE_PANEL = "devtools.trace";

export interface DevtoolsService {
  readonly open: Accessor<boolean>;
  /** Opens or closes them; without `open`, toggles. */
  readonly toggle: (open?: boolean) => void;
  /**
   * Opens them at a panel, by its `DevtoolsPanels` item id, and at `subject` in it when given: what the panel selects
   * (`devtools.plugins` takes `web:<id>` or `host:<id>`). Any panel naming a plugin links to it this way.
   */
  readonly show: (panel: string, subject?: string) => void;
  /** The subject last asked of `panel` (see `show`), for it to select. Reactive. */
  readonly subject: (panel: string) => string | undefined;
  /** Every panel's `snapshot`, by panel id. */
  readonly snapshot: () => Readonly<Record<string, unknown>>;
}

export class Devtools extends Context.Service<Devtools, DevtoolsService>()("lemma-web/Devtools") {}

/** Actions other plugins run by id (`slots.get(Actions, id)?.run()`), so a replacement keeps the id and what calls it keeps working. */
export const DevtoolsActionIds = { eventLog: "event-log.open" } as const;
export { DEVTOOLS_CONTRACT } from "../version.ts";
