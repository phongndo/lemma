import { lazy } from "solid-js";
import type { Component } from "solid-js";

type Views = typeof import("./views.ts");

/**
 * A panel's view (`views.ts`), its code loaded the first time the devtools draw one of their own panels: the views are
 * most of the devtools' code, and most pages never open them. What a panel records while the devtools are shut (the
 * host's events, the channels) and its `snapshot` stay with the page. A load that fails throws where the panel is
 * drawn, as the plugin's fault.
 */
export const viewOf = <K extends keyof Views>(name: K): Views[K] =>
  lazy(() => import("./views.ts").then((views) => ({ default: views[name] as Component<any> }))) as unknown as Views[K];
