import { createEffect, createRoot, getOwner, lazy, runWithOwner } from "solid-js";
import type { JSX } from "solid-js";
import { Pane, Threads, Views } from "@lemma/threads";
import type { ThreadViewProps } from "@lemma/threads";
import { Notify, Slots, defineWebPlugin } from "@lemma/web";
import { TrajectoryIcon } from "@lemma/look";
import styles from "./trajectory.css?inline";
import { addCosts } from "./costs.tsx";

type CreateTrajectory = typeof import("./view.tsx").createTrajectory;

/** The trace of the thread's first view, when it is one: not in a tab. */
const MAIN = "trajectory";

/**
 * The session as the requests and tool runs behind it, like DevTools' Network panel. Each tab of it has its own
 * (filter, selection, scroll), kept while another tab shows, until the tab closes. Its code (`view.tsx`) loads the
 * first time a trace shows, not with the page.
 */
export default defineWebPlugin({
  id: "threads.trajectory",
  styles,
  requires: { threads: Threads, notify: Notify, slots: Slots, pane: Pane },
  setup: ({ threads, notify, slots, pane }) => {
    const owner = getOwner();
    const kept = new Map<string, { readonly draw: () => JSX.Element; readonly dispose: () => void }>();
    /** The tab's trace, made when it first shows; the plugin's, so it outlives being drawn. */
    const traceFor = (createTrajectory: CreateTrajectory, tab: string) => {
      const known = kept.get(tab);
      if (known !== undefined) return known.draw;
      const made = runWithOwner(owner, () => createRoot((dispose) => ({ draw: createTrajectory({ threads, notify, slots }), dispose })))!;
      kept.set(tab, made);
      return made.draw;
    };
    // A load that fails throws where the trace is drawn, as the plugin's fault.
    const Trace = lazy(async () => {
      const { createTrajectory } = await import("./view.tsx");
      return { default: (props: { readonly tab: string }) => traceFor(createTrajectory, props.tab)() };
    });
    createEffect(() => {
      const tabs = new Set([MAIN, ...pane.tabs().map((tab) => tab.id)]);
      for (const [tab, trace] of kept)
        if (!tabs.has(tab)) {
          trace.dispose();
          kept.delete(tab);
        }
    });
    slots.add(Views, {
      id: "trajectory",
      order: 10,
      title: "Trace",
      icon: TrajectoryIcon,
      letter: "t",
      component: (props: ThreadViewProps) => <Trace tab={props.tab ?? MAIN} />,
    });
    addCosts(threads, slots);
  },
});
