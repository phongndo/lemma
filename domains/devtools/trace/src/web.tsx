import { createComputed, createMemo, createSignal, lazy, on } from "solid-js";
import type { Accessor } from "solid-js";
import { Devtools, DevtoolsPanels, TRACE_PANEL } from "@lemma/devtools/web";
import type { DevtoolsService } from "@lemma/devtools/web";
import type { LedgerRecord } from "@lemma/sessions";
import { TrajectoryActions } from "@lemma/threads";
import { Client, defineWebPlugin, HostPlugins, PageTrace, Router, Slots, WebPlugins } from "@lemma/web";
import type { ClientService, PageTraceService, PluginsService, RouterService } from "@lemma/web";
import styles from "./trace.css?inline";

export type Which = "host" | "page";
export type Mode = "spans" | "plugins" | "changes" | "faults";

/** What the panel shows: kept by the plugin, so the panel drawn again (another tab, then this one) shows it still. */
export interface PanelState {
  readonly which: Accessor<Which>;
  readonly setWhich: (which: Which) => void;
  readonly mode: Accessor<Mode>;
  readonly setMode: (mode: Mode) => void;
  readonly query: Accessor<string>;
  readonly setQuery: (query: string) => void;
}

export interface Deps {
  readonly state: PanelState;
  readonly client: ClientService;
  readonly page: PageTraceService;
  readonly devtools: DevtoolsService;
  readonly router: RouterService;
  readonly host: PluginsService;
  readonly web: PluginsService;
}

/** The panel (`panel.tsx`), its code loaded the first time the devtools show it; a load that fails throws there, as the plugin's fault. */
const TracePanel = lazy(() => import("./panel.tsx").then((panel) => ({ default: panel.TracePanel })));

/** The trace a trajectory record's work left: its tool call's, or its step's. */
const subjectOf = (record: LedgerRecord): string | undefined =>
  record.kind === "tool" ? `tool:${record.run.call.id}` : record.kind === "assistant" ? `step:${record.step.stepId}` : undefined;

/**
 * The web half of `devtools.trace`: the host's trace, and the page's, as a devtools panel, and a way there from a
 * trajectory's records. It runs while the host half does.
 */
export default defineWebPlugin({
  id: "devtools.trace",
  styles,
  requires: {
    slots: Slots,
    client: Client,
    page: PageTrace,
    devtools: Devtools,
    router: Router,
    host: HostPlugins,
    web: WebPlugins,
  },
  setup: ({ slots, client, page, devtools, router, host, web }) => {
    const [which, setWhich] = createSignal<Which>("host");
    const [mode, setMode] = createSignal<Mode>("spans");
    const [query, setQuery] = createSignal("");
    const state: PanelState = { which, setWhich, mode, setMode, query, setQuery };
    /** A subject: `trace:page` picks the page's trace (the host's otherwise), and the rest is the filter. */
    const take = (asked: string) => {
      const words = asked.split(/\s+/);
      setWhich(words.includes("trace:page") ? "page" : "host");
      setMode("spans");
      setQuery(words.filter((word) => !word.startsWith("trace:")).join(" "));
    };
    // One the devtools are shown with is taken when it changes, before the panel draws: drawn again, it keeps its state.
    const subject = createMemo(() => devtools.subject(TRACE_PANEL));
    createComputed(on(subject, (asked) => asked !== undefined && take(asked)));
    const deps: Deps = { state, client, page, devtools, router, host, web };
    // After the dock's own panels (the inspectors are at 50).
    slots.add(DevtoolsPanels, { id: TRACE_PANEL, order: 60, title: "Trace", component: () => <TracePanel deps={deps} /> });
    slots.add(TrajectoryActions, {
      id: "devtools.trace.show",
      label: "Show in trace",
      when: (record) => subjectOf(record) !== undefined,
      // Taken here too: the same record asked again, after the filter changed, shows it again.
      run: (record) => {
        take(subjectOf(record)!);
        devtools.show(TRACE_PANEL, subjectOf(record)!);
      },
    });
  },
});
