import { ComposerCompletions, PromptCommands, Threads, commandNodes } from "@lemma/threads";
import type { ThreadsService } from "@lemma/threads";
import { Notify, Slots, defineWebPlugin } from "@lemma/web";
import { copyText } from "@lemma/web/clipboard";
import { CopyIcon, PenSquareIcon, PencilIcon } from "@lemma/look";
import { commandSuggestions } from "./commands.ts";

/** The text of the open thread's last reply, if any. */
const lastReply = (threads: ThreadsService): string | undefined => {
  for (const event of [...threads.branch()].reverse()) {
    if (event.data.type !== "message" || event.data.message.role !== "assistant") continue;
    const text = event.data.message.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("")
      .trim();
    if (text !== "") return text;
  }
  return undefined;
};

/**
 * Commands typed at the start of the prompt (`PromptCommands`): the `/` menu offers each word of one in turn, as a
 * `ComposerCompletions` source of the whole line. Adds the thread's own: `/new`, `/rename`, `/copy`.
 */
export default defineWebPlugin({
  id: "threads.prompt-commands",
  requires: { slots: Slots, threads: Threads, notify: Notify },
  setup: ({ slots, threads, notify }) => {
    slots.add(ComposerCompletions, {
      id: "prompt-commands",
      trigger: "/",
      span: "line",
      label: "Commands",
      // The commands are read before any await, so one coming or going asks again.
      suggest: (query, { signal }) => commandSuggestions(commandNodes(slots.list(PromptCommands)), query, signal),
    });
    slots.add(PromptCommands, {
      id: "new",
      order: 10,
      aliases: ["clear"],
      description: "Start a new thread here",
      icon: PenSquareIcon,
      // Here: in this thread's folder (its worktree, too), where a new thread would otherwise start in its project. A
      // blank thread is new already.
      run: () => threads.newThread(threads.active()?.cwd, { inPlace: true }),
    });
    slots.add(PromptCommands, {
      id: "rename",
      order: 11,
      description: "Rename this thread",
      icon: PencilIcon,
      args: [{ name: "title", rest: true }],
      run: async ({ text }) => {
        const id = threads.activeId();
        if (id === undefined) throw new Error("A new thread has no title yet: send its first prompt");
        await threads.rename(id, text);
      },
    });
    slots.add(PromptCommands, {
      id: "copy",
      order: 12,
      description: "Copy the last reply",
      icon: CopyIcon,
      run: async () => {
        const reply = lastReply(threads);
        if (reply === undefined) throw new Error("There is no reply to copy yet");
        if (!(await copyText(reply))) throw new Error("The clipboard refused it");
        notify.toast({ level: "info", message: "Copied the last reply" });
      },
    });
  },
});
