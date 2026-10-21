import type { RouterService, SlotItem, SlotsService } from "@lemma/web";
import type { DevtoolsPanel, DevtoolsService } from "@lemma/devtools/web";
import { viewOf } from "./lazy.ts";

const Routes = viewOf("Routes");
const Navigation = viewOf("Navigation");

/** The router's panels: why an address shows what it does, who shows each route, and what navigation did. */
export const routePanels = (router: RouterService, slots: SlotsService, devtools: DevtoolsService): readonly SlotItem<DevtoolsPanel>[] => [
  {
    id: "devtools.routes",
    order: 0,
    title: "Routes",
    component: () => <Routes router={router} slots={slots} devtools={devtools} />,
    snapshot: () => router.inspect(),
  },
  {
    id: "devtools.navigation",
    order: 10,
    title: "Navigation",
    component: () => <Navigation router={router} />,
    snapshot: () => ({ journal: router.journal(), entryStates: router.entryStates() }),
  },
];
