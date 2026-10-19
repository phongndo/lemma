import { createSignal } from "solid-js";
import { HostError } from "@lemma/contracts";
import { CommandChannels } from "@lemma/commands";
import type { CommandInfo } from "@lemma/commands";
import { Commands, COMMANDS_CONTRACT } from "@lemma/commands/web";
import { Threads } from "@lemma/threads";
import { Client, Notify, defineWebPlugin } from "@lemma/web";
import { Workspace } from "@lemma/workspace/web";

/** What host plugins offer to run: the palette's host commands, `lemma commands run`. */
export default defineWebPlugin({
  id: "commands.client",
  implements: [COMMANDS_CONTRACT],
  requires: { client: Client, notify: Notify, threads: Threads, workspace: Workspace },
  provides: { commands: Commands },
  setup: ({ client, notify, threads, workspace }, plugin) => {
    const [list, setList] = createSignal<readonly CommandInfo[]>([]);
    // Every command now, then the whole list again after each change: the last one is current.
    plugin.onCleanup(client.follow(CommandChannels.changes, undefined, setList));
    return {
      commands: {
        list,
        /** Runs in the working directory; its questions arrive as interactions. Dismissing one of them cancels it quietly. */
        run: async (command: CommandInfo) => {
          const cwd = workspace.workingDir();
          const sessionId = threads.activeId();
          try {
            const result = await client.channel.call(CommandChannels.run, {
              id: command.id,
              ...(cwd === undefined ? {} : { cwd }),
              ...(sessionId === undefined ? {} : { sessionId }),
            });
            notify.toast({ level: "info", message: result.message ?? `${command.title.replace(/…$/, "")}: done` });
            return true;
          } catch (error) {
            if (!(error instanceof HostError && error.code === "Cancelled")) notify.report(error, command.title.replace(/…$/, ""));
            return false;
          } finally {
            // A command may have committed or switched branches.
            void workspace.refresh();
          }
        },
      },
    };
  },
});
