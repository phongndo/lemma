import { Show, createMemo, createSignal, untrack } from "solid-js";
import { Actions } from "@lemma/actions";
import { ComposerTakeovers, Threads, ThreadsActionIds, ToolViews } from "@lemma/threads";
import { ChatIcon, ChevronDownIcon, XIcon } from "@lemma/look";
import { Client, Notify, Slots, defineWebPlugin } from "@lemma/web";
import { dropped, makeAsking } from "./asking.ts";
import type { Asking } from "./asking.ts";
import { QuestionCard } from "./card.tsx";
import { AskChannels } from "./channels.ts";
import type { OpenQuestions } from "./channels.ts";
import { askView } from "./view.tsx";
import styles from "./ask.css?inline";

/**
 * A call's questions as the person answers them: by session, id, and the questions, so a call asked again after a
 * restart finds what was written, and another call reusing an id (a provider that sends none) does not.
 */
const askingKey = (entry: OpenQuestions) => JSON.stringify([entry.sessionId, entry.toolCallId, entry.questions]);

/**
 * The web half of `tools.ask`: the open thread's questions, inside the composer, whose text box takes the person's own
 * answers (`ComposerTakeovers`), and how `ask_user` calls show in the chat. Following `ask.open` is what tells the host
 * a client can answer. It runs while the tool does.
 */
export default defineWebPlugin({
  id: "tools.ask",
  styles,
  requires: { slots: Slots, client: Client, threads: Threads, notify: Notify },
  setup: ({ slots, client, threads, notify }, plugin) => {
    const focusComposer = () => slots.get(Actions, ThreadsActionIds.focusComposer)?.run();

    const askings = new Map<string, Asking>();
    const askingOf = (entry: OpenQuestions) => {
      const key = askingKey(entry);
      let asking = askings.get(key);
      if (asking === undefined) {
        asking = makeAsking(entry, {
          submit: async (answers) => {
            try {
              await client.channel.call(AskChannels.answer, { sessionId: entry.sessionId, toolCallId: entry.toolCallId, answers });
            } catch (error) {
              notify.report(error, "Could not send your answers");
              throw error;
            }
            focusComposer();
          },
        });
        askings.set(key, asking);
      }
      return asking;
    };

    const [open, setOpen] = createSignal<readonly OpenQuestions[]>([]);
    /** When each call was last in a list. */
    const seen = new Map<string, number>();
    /** The next list is the first since the stream opened again (`dropped`). */
    let fresh = true;
    const listed = (list: readonly OpenQuestions[]) => {
      const now = Date.now();
      const keys = new Set(list.map(askingKey));
      for (const key of keys) seen.set(key, now);
      for (const key of dropped(askings.keys(), keys, seen, fresh, now)) {
        askings.delete(key);
        seen.delete(key);
      }
      fresh = false;
      setOpen(list);
    };
    plugin.onCleanup(
      client.follow(AskChannels.open, undefined, listed, () => {
        fresh = true;
      }),
    );

    // The open thread's call, kept while it stays open: a list sent anew (another thread's question came or went) keeps it.
    const currentKey = createMemo(() => {
      const entry = open().find((candidate) => candidate.sessionId === threads.activeId());
      return entry === undefined ? undefined : askingKey(entry);
    });
    const asking = createMemo(() => {
      const key = currentKey();
      const entry = key === undefined ? undefined : untrack(open).find((candidate) => askingKey(candidate) === key);
      return entry === undefined ? undefined : askingOf(entry);
    });

    slots.add(ComposerTakeovers, {
      id: "tools.ask",
      sessionId: () => asking()?.open.sessionId,
      key: () => currentKey() ?? "",
      banner: (props) => (
        <Show when={asking()} keyed>
          {(current) => <QuestionCard asking={current} release={props.release} focusComposer={focusComposer} />}
        </Show>
      ),
      // The person keeps the box: they let the questions go, or have a prompt of their own unsent. What they send answers.
      waiting: (props) => (
        <Show when={asking()}>
          {(current) => (
            <div class="ask-hidden" role="status">
              <ChatIcon />
              <span>
                {current().open.questions.length > 1
                  ? `The agent is waiting on ${current().open.questions.length} questions`
                  : "The agent is waiting on a question"}
                <span class="muted"> · a message you send answers it as a reply</span>
              </span>
              <span class="spacer" />
              <button
                type="button"
                class="icon-button ask-head-button ask-show"
                aria-label="Show the questions"
                data-tip="Show the questions"
                onClick={() => props.take()}
              >
                <ChevronDownIcon />
              </button>
              <button
                type="button"
                class="icon-button ask-head-button"
                aria-label="Dismiss the questions"
                data-tip="Dismiss: answer none, leave them all to the agent"
                disabled={current().closed()}
                onClick={() => current().dismiss()}
              >
                <XIcon />
              </button>
            </div>
          )}
        </Show>
      ),
      text: () => {
        const current = asking();
        return current?.question() === undefined ? "" : current.draft().text;
      },
      setText: (text) => asking()?.setText(text),
      keyDown: (event) => !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && asking()?.boxKey(event.key) === true,
      placeholder: () => asking()?.placeholder() ?? "",
      readOnly: () => asking()?.question() === undefined,
      submit: () => asking()?.next(),
      submitLabel: () => asking()?.submitLabel() ?? "Submit",
      canSubmit: () => asking()?.canSubmit() === true,
    });
    slots.add(ToolViews, { id: "ask_user", ...askView });
  },
});
