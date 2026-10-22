import { CommandChannels } from "@lemma/commands";
import { RefreshIcon } from "@lemma/look";
import { ThreadActions } from "@lemma/threads";
import { Client, Notify, Slots, defineWebPlugin } from "@lemma/web";
import { REGENERATE } from "./command.ts";

/** `agent.titles`' web half: Regenerate title in a thread's menu, after Rename, which runs its host half's command for that thread. */
export default defineWebPlugin({
  id: "agent.titles",
  requires: { client: Client, notify: Notify, slots: Slots },
  setup: ({ client, notify, slots }, plugin) => {
    plugin.onCleanup(
      slots.add(ThreadActions, {
        id: "titles.regenerate",
        order: 15,
        label: () => "Regenerate title",
        icon: RefreshIcon,
        // A thread with something to name: prompted, which titled it, and taking writes.
        when: (session) => session.title !== undefined && session.damaged === undefined,
        // The new title shows as the thread's own; only a failure has anything to say.
        run: (session) =>
          void client.channel
            .call(CommandChannels.run, { id: REGENERATE, cwd: session.cwd, sessionId: session.id })
            .catch((error: unknown) => notify.report(error, "Regenerate title")),
      }),
    );
  },
});
