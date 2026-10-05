import { createMemo, createSignal } from "solid-js";
import { lastHarness } from "@lemma/contracts";
import type { HarnessInfo, TurnOptions } from "@lemma/contracts";
import { load, save } from "../lib/storage.ts";
import { activePick, nextHarness, resolveHarness, withHarness } from "../model/harnesses.ts";
import type { HarnessPick } from "../model/harnesses.ts";
import { Client, Harnesses, Notify, Threads } from "../ui/contracts.ts";
import { defineUiPlugin } from "../ui/define.ts";

const HARNESS_KEY = "lemma.harness";

/**
 * Harnesses as the host reports them, and this browser's choices: the harness
 * new threads start on, and one picked for a thread's next prompt.
 */
export default defineUiPlugin({
  id: "harnesses",
  requires: { client: Client, threads: Threads, notify: Notify },
  provides: { harnesses: Harnesses },
  setup: ({ client, threads, notify }, plugin) => {
    const host = client.host;
    const [list, setList] = createSignal<readonly HarnessInfo[]>([]);
    const [stored, setStored] = createSignal(load(HARNESS_KEY));
    /** Picks for threads' next prompts, by thread; kept while this page is. */
    const [picks, setPicks] = createSignal<Readonly<Record<string, HarnessPick>>>({});

    const preferred = createMemo(() => resolveHarness(list(), stored()));
    const current = createMemo(() => (threads.activeId() === undefined ? undefined : lastHarness(threads.branch())));
    const next = createMemo(() => {
      const thread = threads.activeId();
      return nextHarness({
        current: current(),
        picked: thread === undefined ? undefined : activePick(picks()[thread], current()),
        preferred: preferred(),
        loading: !threads.log().loaded,
      });
    });
    const selected = createMemo(() => list().find((harness) => harness.id === next().id));

    const sync = async () => setList(await host.harness.list());
    plugin.onCleanup(client.onConnect(() => void sync().catch((error) => notify.report(error, "Sync failed"))));
    plugin.onCleanup(
      client.onEvent((event) => {
        // Harness plugins may come or go; a harness's status changes (installed, say).
        if (event.type === "harnesses-changed") setList(event.harnesses);
        else if (event.type === "plugins-changed") void sync().catch(() => {});
      }),
    );

    return {
      harnesses: {
        list,
        preferred,
        current,
        selectedId: () => next().id,
        selected,
        choose: (id: string) => {
          const thread = threads.activeId();
          if (thread === undefined) {
            save(HARNESS_KEY, id);
            setStored(id);
            return;
          }
          const { [thread]: _old, ...rest } = picks();
          setPicks(id === current() ? rest : { ...rest, [thread]: { harness: id, over: current() } });
        },
        turnOptions: (options: TurnOptions | undefined) => withHarness(options, next().name, selected()),
        refresh: async () => {
          try {
            setList(await host.harness.refresh());
          } catch (error) {
            notify.report(error, "Could not check the harnesses");
          }
        },
      },
    };
  },
});
