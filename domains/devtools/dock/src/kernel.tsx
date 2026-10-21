import { createResource } from "solid-js";
import type { Accessor } from "solid-js";
import { kernelOf } from "@lemma/contracts";
import type { InspectorInfo, KernelKind as Kind, PluginStatus } from "@lemma/contracts";
import { PLUGIN_PANEL } from "@lemma/devtools/web";
import type { ClientService, RouterService, Slot, SlotItem, SlotsService } from "@lemma/web";
import type { DevtoolsPanel, DevtoolsService } from "@lemma/devtools/web";
import { definedSlots } from "@lemma/web";
import { viewOf } from "./lazy.ts";

export const INSPECTORS_PANEL = "devtools.inspectors";

/** What the kernel's panels read. */
export interface Deps {
  readonly slots: SlotsService;
  readonly router: RouterService;
  readonly devtools: DevtoolsService;
  readonly client: ClientService;
  /** Every plugin of each kernel, with what it provides, requires, intercepts, observes, and contributes. */
  readonly lists: Readonly<Record<Kind, Accessor<readonly PluginStatus[]>>>;
  /** What each kernel's app provides itself, its runtime (`PluginsService.runtime`). */
  readonly runtime: Readonly<Record<Kind, Accessor<readonly string[]>>>;
  /** Every contract a web half receives, by the module it is imported from (`WebPluginsService.contracts`). */
  readonly contracts: Readonly<Record<string, object>>;
}

/** The kernel view of `kind`, its runtime marked (`kernelOf`). */
export const kernelFor = (deps: Deps, kind: Kind) => kernelOf(deps.lists[kind](), deps.runtime[kind]());

/** Where each contract slot is exported (`MainRegion` from `@lemma/frame`), for the snippet that adds to it. */
const exportNamesOf = (contracts: Readonly<Record<string, object>>) =>
  new Map<unknown, { readonly name: string; readonly from: string }>(
    Object.entries(contracts).flatMap(([from, module]) => Object.entries(module).map(([name, value]) => [value, { name, from }] as const)),
  );

export interface SlotView {
  readonly name: string;
  readonly contract: { readonly name: string; readonly from: string } | undefined;
  readonly shows: "first" | "all";
  /** Its phases, first first, and the one an item naming none goes in, when it declares them. */
  readonly phases?: readonly string[];
  readonly defaultPhase?: string;
  readonly items: readonly { readonly id: string; readonly plugin: string; readonly phase?: string; readonly order: number }[];
}
export const slotViews = (deps: Deps): SlotView[] => {
  const exportNames = exportNamesOf(deps.contracts);
  return definedSlots()
    .map(({ slot, shows }: { slot: Slot<unknown>; shows: "first" | "all" }) => ({
      name: slot.name,
      contract: exportNames.get(slot),
      shows,
      ...(slot.options.phases === undefined ? {} : { phases: slot.options.phases, defaultPhase: slot.options.defaultPhase! }),
      items: deps.slots
        .contributions(slot)
        .map(({ item, pluginId, phase, order }) => ({ id: item.id, plugin: pluginId, ...(phase === undefined ? {} : { phase }), order })),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
};

const PluginsPanel = viewOf("PluginsPanel");
const HooksPanel = viewOf("HooksPanel");
const RegistriesPanel = viewOf("RegistriesPanel");
const InspectorsPanel = viewOf("InspectorsPanel");

/**
 * The kernel's panels, for the web app and the host alike (both run the
 * core): every plugin and everything it does, each hook's chain, every
 * registry, and what host plugins let you look into. A plugin's name anywhere
 * in the devtools opens it here.
 */
export function kernelPanels(deps: Deps): readonly SlotItem<DevtoolsPanel>[] {
  // Read again whenever the host's plugins change: inspectors come and go with them.
  const [inspectors] = createResource(
    () => deps.lists.host(),
    () => deps.client.inspectors().catch(() => [] as readonly InspectorInfo[]),
    { initialValue: [] },
  );
  return [
    {
      id: PLUGIN_PANEL,
      order: 20,
      title: "Plugins",
      component: () => <PluginsPanel deps={deps} inspectors={inspectors} />,
      snapshot: () => ({ web: deps.lists.web(), host: deps.lists.host() }),
    },
    {
      id: "devtools.hooks",
      order: 30,
      title: "Hooks",
      component: () => <HooksPanel deps={deps} />,
      snapshot: () => ({ web: kernelFor(deps, "web"), host: kernelFor(deps, "host") }),
    },
    {
      id: "devtools.registries",
      order: 40,
      title: "Registries",
      component: () => <RegistriesPanel deps={deps} />,
      snapshot: () => ({ web: slotViews(deps), host: kernelOf(deps.lists.host(), deps.runtime.host()).registries }),
    },
    {
      id: INSPECTORS_PANEL,
      order: 50,
      title: "Inspectors",
      component: () => <InspectorsPanel deps={deps} inspectors={inspectors} />,
      snapshot: () => inspectors(),
    },
  ];
}
