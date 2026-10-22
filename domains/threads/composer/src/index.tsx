import { For, Show, batch, createEffect, createMemo, createSignal, createUniqueId, on, onCleanup, onMount } from "solid-js";
import type { Accessor } from "solid-js";
import { Effect, Schema } from "effect";
import { newRequestId } from "@lemma/agent/prompt";
import { IMAGE_TYPES } from "@lemma/llm";
import type { QueuedPrompt } from "@lemma/agent";
import type { ImageContent } from "@lemma/llm";
import { formatKeys, listKey, matchesKeys, modKey, quickKey } from "@lemma/web/keys";
import { createQuickHold } from "@lemma/web/quick-pick";
import {
  applySuggestion,
  ComposerActions,
  ComposerControls,
  ComposerFooter,
  ComposerNotices,
  ComposerQueuedPart,
  ComposerRegion,
  ComposerSuggestionPart,
  ComposerTakeovers,
  PromptActions,
  PromptCommands,
  Threads,
  ThreadsActionIds,
  ComposerQueued,
  ComposerSuggestionView,
  promptBases,
  queuePlaces,
  TurnOptionSources,
} from "@lemma/threads";
import type { ComposerActionProps, ComposerQueuedProps, ComposerSuggestion, ComposerSuggestionProps, PromptActionProps, ThreadsService } from "@lemma/threads";
import { Actions } from "@lemma/actions";
import { Models } from "@lemma/llm/web";
import { SectionIds, SettingsGroups, configSetting } from "@lemma/settings";
import { Client, Notify, Router, Slots, WebPlugins, defineWebPlugin, Contained, Each, Highlighted, Isolated, usePlugin } from "@lemma/web";
import { Workspace } from "@lemma/workspace/web";
import type { ModelsService } from "@lemma/llm/web";
import type { ClientService, NotifyService, SlotsService } from "@lemma/web";
import type { WorkspaceService } from "@lemma/workspace/web";
import { ChatIcon, ChevronDownIcon, ImageIcon, LogIcon, Segmented, SendIcon, SettingRow, StopIcon, UndoIcon, XIcon } from "@lemma/look";
import { commandTurn } from "./command.ts";
import { createCompletion, ghostText } from "./completion.ts";
import { SharedDrafts, dropRetry, keepDraft, lostOnReload, returned, unsent } from "./drafts.ts";
import type { Draft, Drafts } from "./drafts.ts";
import { promptOf, recallTarget, sentPrompts } from "./history.ts";
import type { SentPrompt } from "./history.ts";
import { leftOutWarnings, readImage, sortFiles, unreadWarning } from "./images.ts";
import { createSender } from "./sender.ts";
import type { WhenBusy as SendWhenBusy } from "./sender.ts";
import { createStopKey } from "./stop.ts";
import { holds, noChoices, release as releasing, take as taking } from "./takeover.ts";
import styles from "./composer.css?inline";

const ComposerConfig = Schema.Struct({
  send: Schema.Literals(["enter", "mod+enter"])
    .pipe(Schema.withDecodingDefaultType(Effect.sync(() => "enter" as const)))
    .annotate({
      title: "Send with",
      description: "enter: Enter sends and Shift+Enter starts a new line. mod+enter: ⌘Enter (Ctrl+Enter) sends and Enter starts a new line.",
    }),
  whenBusy: Schema.Literals(["steer", "queue"])
    .pipe(Schema.withDecodingDefaultType(Effect.sync(() => "steer" as const)))
    .annotate({
      title: "While a turn runs",
      description:
        "steer: sending joins the running turn after its current step. queue: sending waits for the running turn to end, and goes as the next turn. Alt with the send key does the other.",
    }),
  stop: Schema.Literals(["escape-twice", "escape"])
    .pipe(Schema.withDecodingDefaultType(Effect.sync(() => "escape-twice" as const)))
    .annotate({
      title: "Stop with",
      description: "escape-twice: Escape twice within a second stops the running turn. escape: Escape once does.",
    }),
});

const noPrompt = { text: "", images: [] } as const;

type Send = typeof ComposerConfig.Type.send;
type WhenBusy = typeof ComposerConfig.Type.whenBusy;
type Stop = typeof ComposerConfig.Type.stop;

/**
 * A queued prompt in a line: its text, whitespace collapsed, or what it attaches. A plugin's notice, held for the next
 * prompt, is its plugin's, then what it shows (`QueuedPrompt.display`).
 */
const preview = (prompt: QueuedPrompt): string => {
  const text = prompt.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (prompt.source !== undefined) return `${prompt.source} · ${prompt.display ?? text}`;
  const images = prompt.content.filter((part) => part.type === "image").length;
  return text || (images === 1 ? "An image" : `${images} images`);
};

interface Deps {
  readonly config: typeof ComposerConfig.Type;
  readonly client: ClientService;
  readonly threads: ThreadsService;
  readonly models: ModelsService;
  readonly workspace: WorkspaceService;
  readonly notify: NotifyService;
  readonly slots: SlotsService;
  readonly drafts: Drafts;
  /** Prompts on their way to the host, not yet taken: the composer has cleared, so they are in no draft. */
  readonly outgoing: Set<Draft>;
  readonly setFocus: (focus: (() => void) | undefined) => void;
  /** The queue above the box shows its prompts, or only its header: one choice for every thread, while the plugin runs. */
  readonly queueOpen: Accessor<boolean>;
  readonly setQueueOpen: (open: boolean) => void;
  /** The last prompt "Edit from here" put back in a thread's draft, and where the cursor goes: after it (`EditFromHere`). */
  readonly editing: Accessor<{ readonly sessionId: string; readonly cursor: number } | undefined>;
}

function Composer(props: { deps: Deps }) {
  const { client, threads, models, workspace, notify, slots, drafts, outgoing } = props.deps;
  const draftKey = () => threads.activeId() ?? "";
  const saved = drafts.get(draftKey());
  const [text, setText] = createSignal(saved?.text ?? "");
  const [images, setImages] = createSignal<readonly ImageContent[]>(saved?.images ?? []);
  const [dragging, setDragging] = createSignal(false);
  const [sending, setSending] = createSignal(false);
  let input!: HTMLTextAreaElement;
  let suggestionList: HTMLDivElement | undefined;
  const [cursor, setCursor] = createSignal(0);
  const [focused, setFocused] = createSignal(false);
  const plugin = usePlugin();
  /** The takeover holding the open thread (`ComposerTakeovers`), whether or not the person keeps the box for now. */
  const holder = createMemo(() => {
    const id = threads.activeId();
    return id === undefined ? undefined : slots.list(ComposerTakeovers).find((item) => item.sessionId() === id);
  });
  const [choices, setChoices] = createSignal(noChoices);
  /** The takeover the text box and the send button are given to (`holds`). */
  const taken = createMemo(() => {
    const item = holder();
    return item !== undefined && holds(choices(), item.key(), unsent({ text: text(), images: images() }) || sending()) ? item : undefined;
  });
  const release = () => {
    const item = holder();
    if (item !== undefined) setChoices((current) => releasing(current, item.key()));
  };
  const take = () => {
    const item = holder();
    if (item !== undefined) setChoices((current) => taking(current, item.key()));
  };
  /** What the text box shows: the takeover's text while there is one, else the thread's draft. */
  const boxText = () => taken()?.text() ?? text();
  const syncCursor = () => setCursor(input.selectionStart ?? boxText().length);
  /**
   * The prompt sent in this thread that Up or Down brought back (its place, oldest first), while the composer holds it
   * unchanged: an edit (`edited`), a send, or another thread forgets it. Until then it is history being read, not a
   * draft, and opens no completion menu for a word in it.
   */
  const [recalled, setRecalled] = createSignal<SentPrompt & { readonly at: number }>();
  const completion = createCompletion(slots, boxText, cursor, () => focused() && recalled() === undefined && taken()?.readOnly?.() !== true);
  /** The box is at its tallest and scrolls: the ghost, drawn over it unscrolled, would be out of place, so none shows. */
  const [scrolls, setScrolls] = createSignal(false);
  /** Muted after the cursor while it ends the prompt (`ghostText`); Tab takes the suggestion. */
  const ghost = createMemo(() => {
    const word = completion.match();
    if (word === undefined || taken() !== undefined || scrolls()) return "";
    const active = completion.open() ? completion.items()[completion.active()]?.suggestion : undefined;
    return ghostText(boxText(), word, cursor(), active, completion.groups());
  });
  const listId = createUniqueId();
  const optionId = (index: number) => `${listId}-${index}`;
  createEffect(() => {
    const id = optionId(completion.active());
    if (completion.open()) suggestionList?.querySelector(`#${CSS.escape(id)}`)?.scrollIntoView({ block: "nearest" });
  });

  createEffect(
    on(
      threads.activeId,
      (id, before) => {
        // Written on the new-thread page before its thread was there (the list loading, the thread being made): the
        // blank thread it lands on takes it.
        const early = drafts.get("");
        if (before === undefined && id !== undefined && early !== undefined && unsent(early) && threads.blank() && !unsent(drafts.get(id) ?? noPrompt)) {
          drafts.set(id, early);
          drafts.delete("");
        }
        const draft = drafts.get(draftKey());
        setRecalled(undefined);
        setText(draft?.text ?? "");
        setImages(draft?.images ?? []);
        queueMicrotask(() => {
          resize();
          input.focus();
          syncCursor();
        });
      },
      { defer: true },
    ),
  );
  // Every change is kept with its thread, for when the composer shows it again; a retry id stays until the person edits.
  createEffect(on([text, images], ([text, images]) => keepDraft(drafts, draftKey(), { text, images }, recalled() !== undefined), { defer: true }));
  // Taken or let go, or the takeover's text changed (another of its questions): the box fits what it now shows.
  createEffect(on([taken, boxText], () => queueMicrotask(resize), { defer: true }));
  /** The person changed the prompt: sending it is a new submission, not a retry of the last one, and no prompt brought back. */
  const edited = () => {
    setRecalled(undefined);
    dropRetry(drafts, draftKey());
  };

  const resize = () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
    setScrolls(input.scrollHeight > input.clientHeight + 1);
  };

  onMount(() => {
    props.deps.setFocus(() => input.focus());
    input.focus();
    resize();
  });
  onCleanup(() => props.deps.setFocus(undefined));
  // A prompt put back to edit ("Edit from here") went into the thread's draft: the box shows it, the cursor after the prompt.
  createEffect(
    on(
      props.deps.editing,
      (edit) => {
        if (edit === undefined || edit.sessionId !== draftKey()) return;
        const draft = drafts.get(edit.sessionId);
        batch(() => {
          setRecalled(undefined);
          setText(draft?.text ?? "");
          setImages(draft?.images ?? []);
        });
        queueMicrotask(() => {
          resize();
          input.focus();
          input.setSelectionRange(edit.cursor, edit.cursor);
          syncCursor();
        });
      },
      { defer: true },
    ),
  );

  /**
   * The prompts waiting for a turn of their own, shown over the box (`queuePlaces`' `next`): a steer for the running
   * turn has no row, as the conversation shows it where it will join, but with no turn running, what a stopped one left
   * waits here for the next prompt, steers too.
   */
  const places = createMemo(() => queuePlaces(threads));
  const queued = () => places().next;
  const { queueOpen, setQueueOpen } = props.deps;
  const queueId = createUniqueId();

  const acceptsImages = () => models.selected()?.input.includes("image") ?? true;
  /** What sending does while a turn runs: what `whenBusy` says, or with Alt (`other`) the other. */
  const busyMode = (other = false): SendWhenBusy => ((props.deps.config.whenBusy === "steer") !== other ? "steer" : "follow-up");

  const sender = createSender({
    drafts,
    outgoing,
    key: draftKey,
    home: (key) => (key === "" ? draftKey() : key),
    read: () => ({ text: text(), images: images() }),
    // A refused prompt comes back with the cursor at its end and its completions dismissed, as Escape does, so they do
    // not cover the notice saying why; when the Enter that sent it comes up no longer decides.
    write: (prompt) => {
      batch(() => {
        setText(prompt.text);
        setImages(prompt.images);
        setCursor(prompt.text.length);
      });
      completion.dismiss();
      queueMicrotask(() => {
        input.setSelectionRange(prompt.text.length, prompt.text.length);
        resize();
      });
    },
    sending,
    setSending,
    connected: client.connected,
    newRequestId,
    starting: () => {
      setRecalled(undefined);
      // Sent while a takeover waits, the person's own prompt answers in its place: it lets the takeover go.
      const waiting = holder();
      if (waiting !== undefined) setChoices((current) => releasing(current, waiting.key()));
    },
    place: async (sent, content, whenBusy, background) => {
      // A new chat may start in its own worktree, named from the prompt: one in the background, as one sent from here would.
      const cwd = threads.blank() ? await workspace.newChatDir(sent.text) : undefined;
      // Each plugin's choice for the turn (`TurnOptionSources`), for the thread it goes to: none for a new one.
      const goingTo = background === true || threads.blank() ? undefined : threads.activeId();
      const chosen = slots.list(TurnOptionSources).flatMap((source) => {
        const value = source.value(goingTo);
        return value === undefined ? [] : [[source.id, value] as const];
      });
      const turn = chosen.length === 0 ? models.turnOptions() : { ...models.turnOptions(), plugins: Object.fromEntries(chosen) };
      return threads.send(content, { turn, cwd, requestId: sent.requestId, whenBusy, background });
    },
    report: (error) => notify.report(error, "Could not create a session"),
    settled: () => queueMicrotask(resize),
  });
  const canSend = sender.canSend;
  /** The person has a prompt of their own in the box: while a turn runs, its steer or queue button takes the stop button's place. */
  const written = () => unsent({ text: text(), images: images() });
  /** Enter, or the send button: the takeover's, while the box is given to one, else the person's prompt goes. */
  const submit = async (whenBusy: SendWhenBusy = busyMode()) => {
    const item = taken();
    if (item === undefined) return (await runCommand()) ? undefined : sender.send(whenBusy);
    if (item.canSubmit?.() !== false) item.submit();
  };
  /** The prompt goes to a new thread in the background, as a link opened in a new tab, and this one stays shown. */
  const runElsewhere = async () => {
    if (taken() === undefined) return (await runCommand()) ? undefined : sender.send(busyMode(), true);
  };
  /** What runs the prompt elsewhere: mod with Enter, or with Shift too while mod+Enter sends. */
  const elsewhereKeys = () => (props.deps.config.send === "mod+enter" ? "mod+shift+enter" : "mod+enter");
  /**
   * A prompt that is a command running here runs instead of going out (`commandTurn`): the box clears first, as the
   * command may go to another thread, and gets the prompt back if it fails. True when the prompt was a command.
   */
  const runCommand = async (): Promise<boolean> => {
    const turn = commandTurn(text(), slots.list(PromptCommands), images().length);
    if (turn.kind === "send") return false;
    if (turn.kind === "refuse") {
      notify.toast({ level: "warning", message: turn.problem });
      return true;
    }
    const before = text();
    const key = draftKey();
    edited();
    setText("");
    queueMicrotask(resize);
    const { command } = turn;
    try {
      await command.node.run!({ path: command.path, args: command.args, text: command.text });
    } catch (error) {
      notify.report(error, `${turn.name} did not run`);
      if (draftKey() === key && text() === "") {
        setText(before);
        queueMicrotask(resize);
      }
    }
    return true;
  };
  const send = plugin.action("send the prompt", (whenBusy?: SendWhenBusy) => submit(whenBusy));

  /** Up or Down (`recallTarget`): false when the key is the field's (it moves the cursor). */
  const recall = (direction: "older" | "newer"): boolean => {
    const target = recallTarget(
      // Read from the branch when asked: the branch may have changed since the last (checked out further back, say).
      () => sentPrompts(threads.branch()),
      { text: text(), images: images(), recalledAt: recalled()?.at, selectionStart: input.selectionStart ?? 0, selectionEnd: input.selectionEnd ?? 0 },
      direction,
    );
    if (target === undefined) return false;
    const { at, prompt } = target;
    batch(() => {
      setRecalled(at === undefined ? undefined : { ...prompt, at });
      setText(prompt.text);
      setImages(prompt.images);
      setCursor(prompt.text.length);
    });
    queueMicrotask(() => {
      input.setSelectionRange(prompt.text.length, prompt.text.length);
      resize();
    });
    return true;
  };

  /** A first Escape waiting for its second (`createStopKey`): another thread showing, or the turn ending, forgets it. */
  const [stopping, setStopping] = createSignal(false);
  const stopKey = createStopKey({
    mode: () => props.deps.config.stop,
    cancel: () => void threads.cancel(),
    after: (ms, fn) => plugin.after(ms, fn),
    armed: stopping,
    setArmed: setStopping,
  });
  createEffect(on([threads.activeId, threads.busy], stopKey.disarm, { defer: true }));
  onCleanup(stopKey.disarm);

  /** Writes what the box shows: the takeover's text, or the thread's draft. */
  const write = (next: string) => {
    const item = taken();
    if (item !== undefined) return item.setText(next);
    edited();
    setText(next);
  };
  const insert = (value: string) => {
    const start = input.selectionStart ?? boxText().length;
    const end = input.selectionEnd ?? start;
    const next = boxText().slice(0, start) + value + boxText().slice(end);
    batch(() => write(next));
    queueMicrotask(() => {
      input.focus();
      input.setSelectionRange(start + value.length, start + value.length);
      syncCursor();
      resize();
    });
  };
  /** Puts a suggestion in place of the word being completed. */
  /** Puts a suggestion in place of the word being completed; with `complete`, Tab's, only that, never sending. */
  const pick = (suggestion: ComposerSuggestion, how: "pick" | "complete" = "pick") => {
    const word = completion.match();
    if (word === undefined) return;
    const next = applySuggestion(boxText(), word, suggestion.insert, { space: suggestion.partial !== true });
    // Together, so completion never sees the new text with the old cursor (and asks for a word nobody typed).
    batch(() => {
      write(next.text);
      setCursor(next.cursor);
    });
    queueMicrotask(() => {
      input.focus();
      input.setSelectionRange(next.cursor, next.cursor);
      resize();
    });
    // A command needing nothing more goes as Enter would send it.
    if (suggestion.submit === true && how === "pick") void submit();
  };
  const addFiles = async (files: Iterable<File>) => {
    const sorted = sortFiles([...files]);
    for (const message of leftOutWarnings(sorted)) notify.toast({ level: "warning", message });
    const accepted = sorted.accepted;
    if (accepted.length === 0) return;
    // One that cannot be read (gone from a network share, say) is told of; the rest attach.
    const read = await Promise.allSettled(accepted.map(readImage));
    const unread = read.filter((result) => result.status === "rejected").length;
    if (unread > 0) notify.toast({ level: "warning", message: unreadWarning(unread) });
    const attached = read.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
    if (attached.length === 0) return;
    edited();
    setImages((current) => [...current, ...attached]);
  };

  // ⌘ is the completions' while they show, which ⌘1 … ⌘9 pick from.
  const hold = createQuickHold(() => completion.open() && completion.items().length > 0);
  const onKeyDown = (event: KeyboardEvent) => {
    hold.track(event);
    // The completion menu, while open, takes the keys that move through it, pick, and close it: a search
    // list's (`listKey`), then plain ones. Other keys with a modifier stay the app's (mod+alt+arrows switch threads, mod+enter sends).
    const list = completion.open() && !event.isComposing ? listKey(event) : undefined;
    if (list !== undefined && completion.items().length > 0) {
      event.preventDefault();
      if (!("pick" in list)) completion.move(list.move);
      else {
        const item = completion.items()[list.pick];
        if (item !== undefined) pick(item.suggestion);
      }
      return;
    }
    const plain = !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
    if (completion.open() && plain && !event.isComposing) {
      const count = completion.items().length;
      if (event.key === "Tab" || event.key === "Enter") {
        if (count > 0) {
          event.preventDefault();
          pick(completion.items()[completion.active()]!.suggestion, event.key === "Tab" ? "complete" : "pick");
          return;
        }
        // An answer is on its way: the key waits for it rather than sending a half-typed mention.
        if (completion.loading()) {
          event.preventDefault();
          return;
        }
      }
      if (event.key === "Escape") {
        event.preventDefault();
        completion.dismiss();
        return;
      }
    }
    if (!event.isComposing && taken()?.keyDown?.(event) === true) {
      event.preventDefault();
      return;
    }
    const sends = props.deps.config.send === "mod+enter" ? modKey(event) : !modKey(event) && !event.ctrlKey && !event.metaKey;
    if (!event.isComposing && taken() === undefined && matchesKeys(elsewhereKeys(), event)) {
      event.preventDefault();
      void runElsewhere();
    } else if (event.key === "Enter" && sends && !event.shiftKey && !event.isComposing) {
      // Alt does what `whenBusy` does not; with no turn running, Alt+Enter is left to the field.
      if (event.altKey && !threads.busy()) return;
      event.preventDefault();
      void submit(busyMode(event.altKey));
    } else if ((event.key === "ArrowUp" || event.key === "ArrowDown") && plain && !event.isComposing && taken() === undefined) {
      if (recall(event.key === "ArrowUp" ? "older" : "newer")) event.preventDefault();
    } else if (event.key === "Escape" && taken() !== undefined) {
      // While taken, Escape gives the box back to the person; the stop button still stops the turn.
      event.preventDefault();
      release();
    } else if (event.key === "Escape" && threads.busy()) {
      event.preventDefault();
      stopKey.press(event.repeat);
    }
  };

  /** A takeover's text box takes text only: images go with a prompt of the person's own. */
  const refuseFiles = () => notify.toast({ level: "warning", message: "Only text goes here now: let the box go (Escape) to attach images to a prompt." });
  // Files pasted or dropped attach, or are told why not (`addFiles`); text is the field's, pasted or dropped as it is.
  const onPaste = (event: ClipboardEvent) => {
    const files = [...(event.clipboardData?.files ?? [])];
    if (files.length === 0) return;
    event.preventDefault();
    if (taken() !== undefined) return refuseFiles();
    void addFiles(files);
  };

  const onDrop = (event: DragEvent) => {
    setDragging(false);
    const files = [...(event.dataTransfer?.files ?? [])];
    if (files.length === 0) return;
    // Taken too, or the browser would open the file in place of the app.
    event.preventDefault();
    if (taken() !== undefined) return refuseFiles();
    void addFiles(files);
  };

  const placeholder = () => {
    if (!client.connected()) return "Waiting for the host…";
    if (threads.busy()) {
      const other = formatKeys(props.deps.config.send === "mod+enter" ? "alt+mod+enter" : "alt+enter");
      return busyMode() === "steer" ? `Steer it, or ${other} to queue for after it` : `Queue for after it, or ${other} to steer it`;
    }
    return threads.blank() ? "Ask anything, or describe a task" : "Reply…";
  };

  return (
    <div class="composer-wrap">
      {/* Each notice a bubble above the box, as the queue and a taker's banner are. */}
      <For each={slots.list(ComposerNotices)}>
        {(item) => (
          <div class="composer-notice">
            <Contained slot={ComposerNotices} item={item} component={item.component} />
          </div>
        )}
      </For>
      {/* Above the box, in the page's flow so it covers nothing: what is queued, which the completion menu covers while open. */}
      <Show when={queued().length > 0}>
        <div class="composer-queue">
          {/* A thin header that opens and closes the list; pressing it leaves the focus, and the cursor, in the prompt. */}
          <button
            type="button"
            class="queue-head"
            aria-expanded={queueOpen()}
            aria-controls={queueId}
            aria-label={`${queueOpen() ? "Hide" : "Show"} ${queued().length} queued ${queued().length === 1 ? "prompt" : "prompts"}`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setQueueOpen(!queueOpen())}
          >
            <LogIcon />
            <span class="queue-title">Queued</span>
            <span class="queue-count">{queued().length}</span>
            <ChevronDownIcon />
          </button>
          {/* Closed, it stays, hidden, for the header to name. */}
          <ul id={queueId} aria-label="Queued prompts" hidden={!queueOpen()}>
            <For each={queued()}>
              {(prompt) => (
                <ComposerQueued
                  prompt={prompt}
                  withdraw={() => void threads.withdraw(prompt.requestId)}
                  promote={places().running ? () => void threads.promote(prompt.requestId) : undefined}
                />
              )}
            </For>
          </ul>
        </div>
      </Show>
      <Show when={taken() === undefined ? holder() : undefined} keyed>
        {(item) => <Contained slot={ComposerTakeovers} item={item} component={item.waiting} props={{ take }} />}
      </Show>
      {/* A taker's banner, in the completion menu's look and the page's flow, as the queue; the menu covers it while open. */}
      <Show when={taken()} keyed>
        {(item) => (
          <div class="composer-takeover">
            <Contained slot={ComposerTakeovers} item={item} component={item.banner} props={{ release }} />
          </div>
        )}
      </Show>
      <form
        class="composer"
        classList={{ dragging: dragging(), busy: threads.busy(), taken: taken() !== undefined }}
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
        onDragOver={(event) => {
          if (event.dataTransfer?.types.includes("Files")) {
            event.preventDefault();
            if (taken() === undefined) setDragging(true);
          }
        }}
        onDragLeave={(event) => {
          if (event.currentTarget === event.target) setDragging(false);
        }}
        onDrop={onDrop}
      >
        <Show when={completion.open()}>
          {/* A press anywhere in it keeps the focus, and so the cursor and the menu, in the prompt. */}
          <div class="completions" ref={suggestionList} onMouseDown={(event) => event.preventDefault()}>
            <Show when={completion.items().length > 0}>
              {/* Busy while it still shows the last word's suggestions, until this one's arrive. */}
              <div id={listId} role="listbox" aria-label="Suggestions" aria-busy={completion.loading()}>
                <For each={completion.sections()}>
                  {(section) => (
                    <div role="group" aria-label={section.group.source.label}>
                      <Show when={completion.sections().length > 1}>
                        <div class="menu-section" aria-hidden="true">
                          {section.group.source.label}
                        </div>
                      </Show>
                      <For each={section.items}>
                        {(item) => (
                          <div
                            id={optionId(item.index)}
                            role="option"
                            class="menu-item completion"
                            aria-selected={item.index === completion.active()}
                            data-active={item.index === completion.active()}
                            data-quick-key={hold.held() ? quickKey(item.index) : undefined}
                            onMouseMove={() => completion.setActive(item.index)}
                            onClick={() => pick(item.suggestion)}
                          >
                            <ComposerSuggestionView suggestion={item.suggestion} active={item.index === completion.active()} />
                          </div>
                        )}
                      </For>
                    </div>
                  )}
                </For>
              </div>
            </Show>
            <div class="completions-status" role="status" aria-live="polite">
              <For each={completion.groups().filter((group) => (group.error ?? group.note) !== undefined)}>
                {(group) => (
                  <div class="completions-note" classList={{ error: group.error !== undefined }}>
                    {completion.groups().length > 1 ? `${group.source.label}: ` : ""}
                    {group.error ?? group.note}
                  </div>
                )}
              </For>
              <Show when={completion.items().length === 0 && completion.groups().every((group) => (group.error ?? group.note) === undefined)}>
                <div class="completions-note">{completion.loading() ? "Searching…" : "No matches"}</div>
              </Show>
            </div>
          </div>
        </Show>
        <Show when={images().length > 0 && taken() === undefined}>
          <div class="attachments">
            <For each={images()}>
              {(image, index) => (
                <div class="attachment">
                  <img src={`data:${image.mimeType};base64,${image.data}`} alt="Attachment" />
                  <button
                    type="button"
                    class="attachment-remove"
                    aria-label="Remove image"
                    onClick={() => {
                      edited();
                      setImages((all) => all.filter((_, i) => i !== index()));
                    }}
                  >
                    <XIcon />
                  </button>
                </div>
              )}
            </For>
            <Show when={!acceptsImages()}>
              <span class="muted small">This model does not accept images.</span>
            </Show>
          </div>
        </Show>
        <div class="composer-input">
          <Show when={ghost() !== ""}>
            <div class="composer-ghost" aria-hidden="true">
              {boxText()}
              <span class="composer-ghost-text">{ghost()}</span>
            </div>
          </Show>
          <textarea
            ref={input}
            rows={1}
            value={boxText()}
            placeholder={taken()?.placeholder() ?? placeholder()}
            readOnly={taken()?.readOnly?.() === true}
            aria-label="Message"
            aria-autocomplete="list"
            aria-controls={completion.open() && completion.items().length > 0 ? listId : undefined}
            aria-activedescendant={completion.open() && completion.items().length > 0 ? optionId(completion.active()) : undefined}
            spellcheck={true}
            onInput={(event) => {
              const value = event.currentTarget.value;
              // Text and cursor together: completion asks for the word once, not for each half of the change.
              batch(() => {
                const item = taken();
                if (item !== undefined) item.setText(value);
                else {
                  edited();
                  setText(value);
                }
                syncCursor();
              });
              resize();
            }}
            onFocus={() =>
              batch(() => {
                setFocused(true);
                syncCursor();
              })
            }
            onBlur={(event) => {
              hold.track(event);
              setFocused(false);
            }}
            onKeyUp={(event) => {
              hold.track(event);
              syncCursor();
            }}
            onClick={syncCursor}
            onSelect={syncCursor}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
        </div>
        <div class="composer-bar">
          <div class="composer-controls">
            <Each slot={ComposerControls} />
          </div>
          <div class="composer-actions">
            <Show when={taken() === undefined}>
              <Each slot={ComposerActions} props={{ addFiles, insert }} />
            </Show>
            <Show when={taken()}>
              {(item) => (
                <button type="submit" class="send" disabled={item().canSubmit?.() === false} aria-label={item().submitLabel()} data-tip={item().submitLabel()}>
                  <SendIcon />
                </button>
              )}
            </Show>
            <Show
              when={threads.busy()}
              fallback={
                <Show when={taken() === undefined}>
                  <button
                    type="submit"
                    class="send"
                    disabled={!canSend()}
                    aria-label="Send"
                    data-tip={`Send (${formatKeys(elsewhereKeys())}: in a new thread, in the background)`}
                  >
                    <SendIcon />
                  </button>
                </Show>
              }
            >
              <Show when={stopping()}>
                <span class="composer-hint" role="status">
                  {formatKeys("escape")} again to stop
                </span>
              </Show>
              <Show
                when={written() && taken() === undefined}
                fallback={
                  <button type="button" class="send stop" aria-label="Stop" data-tip="Stop" onClick={() => threads.cancel()}>
                    <StopIcon />
                  </button>
                }
              >
                {/* With Alt, the other of steering and queueing, as with the send key. */}
                <button
                  type="submit"
                  class="send"
                  disabled={!canSend()}
                  aria-label={busyMode() === "steer" ? "Steer" : "Queue"}
                  data-tip={
                    busyMode() === "steer"
                      ? "Steer: joins the running turn after its current step (Alt: send after it)"
                      : "Queue: sent when the running turn ends (Alt: steer it)"
                  }
                  onClick={(event) => {
                    event.preventDefault();
                    send(busyMode(event.altKey));
                  }}
                >
                  <SendIcon />
                </button>
              </Show>
            </Show>
          </div>
        </div>
      </form>
      <Each slot={ComposerFooter} />
    </div>
  );
}

/** The default `composer.queued` part: the prompt on one line, as a menu item, and buttons to steer with it and to withdraw it. */
function QueuedRow(props: ComposerQueuedProps) {
  return (
    <li class="menu-item queued">
      <ChatIcon />
      <span class="queued-text">{preview(props.prompt)}</span>
      <Show when={props.promote}>
        {(promote) => (
          <button
            type="button"
            class="icon-button queued-promote"
            aria-label="Steer now"
            data-tip="Steer now: joins the running turn after its current step"
            onClick={() => promote()()}
          >
            <SendIcon />
          </button>
        )}
      </Show>
      <button type="button" class="icon-button queued-remove" aria-label="Withdraw" data-tip="Withdraw" onClick={() => props.withdraw()}>
        <XIcon />
      </button>
    </li>
  );
}

/** The default `composer.suggestion` part: icon, label with the matched letters marked, then the detail. */
function SuggestionRow(props: ComposerSuggestionProps) {
  return (
    <>
      <Show when={props.suggestion.icon}>{(icon) => <Isolated component={icon()} />}</Show>
      <span class="menu-label">
        <Highlighted text={props.suggestion.label} matches={props.suggestion.matches ?? []} />
      </span>
      <Show when={props.suggestion.hint}>{(hint) => <span class="completion-usage">{hint()}</span>}</Show>
      <Show when={props.suggestion.detail}>
        {(detail) => (
          <span class="menu-hint completion-detail">
            <Highlighted text={detail()} matches={props.suggestion.detailMatches ?? []} />
          </span>
        )}
      </Show>
    </>
  );
}

/** Which keys send, in General › Composer. */
function SendSetting(props: { send: Send; onChange: (send: Send) => void }) {
  return (
    <SettingRow
      title="Send a message"
      description={`The other one starts a new line, as does Shift+Enter. ${formatKeys("mod+enter")}, or ${formatKeys("mod+shift+enter")} while it sends, runs it in a new thread in the background.`}
    >
      <Segmented
        label="Send a message with"
        value={props.send}
        options={[
          { value: "enter", label: formatKeys("enter") },
          { value: "mod+enter", label: formatKeys("mod+enter") },
        ]}
        onChange={props.onChange}
      />
    </SettingRow>
  );
}

/** What sending does while a turn runs, in General › Composer. */
function WhenBusySetting(props: { whenBusy: WhenBusy; onChange: (whenBusy: WhenBusy) => void }) {
  return (
    <SettingRow
      title="While a turn runs"
      description="Steer: join it after its current step. Queue: send after the turn ends. Alt with the send key does the other."
    >
      <Segmented
        label="Sending while a turn runs"
        value={props.whenBusy}
        options={[
          { value: "steer", label: "Steer" },
          { value: "queue", label: "Queue" },
        ]}
        onChange={props.onChange}
      />
    </SettingRow>
  );
}

/** Which Escape stops a running turn, in General › Composer. */
function StopSetting(props: { stop: Stop; onChange: (stop: Stop) => void }) {
  return (
    <SettingRow
      title="Stop a turn"
      description="In the prompt, while a turn runs. Twice: a second Escape within a second, so one meant for a menu cannot stop it."
    >
      <Segmented
        label="Stop a turn with"
        value={props.stop}
        options={[
          { value: "escape-twice", label: `${formatKeys("escape")} ${formatKeys("escape")}` },
          { value: "escape", label: formatKeys("escape") },
        ]}
        onChange={props.onChange}
      />
    </SettingRow>
  );
}

/** The default composer action: pick images to attach. */
function AttachImages(props: ComposerActionProps) {
  const attach = usePlugin().action("attach images", (files: File[]) => props.addFiles(files));
  let picker!: HTMLInputElement;
  return (
    <>
      <button type="button" class="icon-button" data-tip="Attach images" aria-label="Attach images" onClick={() => picker.click()}>
        <ImageIcon />
      </button>
      <input
        ref={picker}
        type="file"
        accept={[...IMAGE_TYPES].join(",")}
        multiple
        hidden
        onChange={(event) => {
          attach([...(event.currentTarget.files ?? [])]);
          event.currentTarget.value = "";
        }}
      />
    </>
  );
}

/** A prompt a plugin answered instead of placing it: who, and what it did or why it refused. */
function PromptAnswerNotice(props: { threads: ThreadsService }) {
  return (
    <Show when={props.threads.answer()}>
      {(answer) => (
        <div
          class="callout composer-callout"
          classList={{ "callout-warn": answer().kind === "refused" }}
          role="status"
          aria-label="Prompt answered by a plugin"
        >
          <div class="callout-text">
            <span>
              <code>{answer().by}</code> {answer().kind === "handled" ? "handled the prompt" : "refused the prompt"}
              {answer().message === "" ? "." : `: ${answer().message}`}
            </span>
          </div>
          <button class="icon-button" aria-label="Dismiss" data-tip="Dismiss" onClick={() => props.threads.dismissAnswer()}>
            <XIcon />
          </button>
        </div>
      )}
    </Show>
  );
}

/**
 * The composer's `PromptActions` item, "Edit from here": the thread goes back to before the prompt's turn
 * (`promptBases`, `Threads.checkout`), and the prompt comes back to be written again, before what is written in the
 * thread's draft. Files stay as they are. None for a steer, a prompt placed with another, or the thread's first; not
 * while a turn runs.
 */
function EditFromHere(
  props: PromptActionProps & {
    readonly deps: Deps;
    readonly bases: Accessor<ReadonlyMap<string, string>>;
    readonly edited: (sessionId: string, cursor: number) => void;
  },
) {
  const { threads, drafts } = props.deps;
  const base = () => props.bases().get(props.prompt.eventId);
  const busy = () => threads.busy();
  const edit = usePlugin().action("edit a prompt from where it was sent", async () => {
    const to = base();
    const { sessionId, content } = props.prompt;
    if (to === undefined || busy() || threads.activeId() !== sessionId || !(await threads.checkout(to))) return;
    const prompt = promptOf(content);
    drafts.set(sessionId, returned(prompt, drafts.get(sessionId)));
    props.edited(sessionId, prompt.text.length);
  });
  return (
    <Show when={base()}>
      {/* Not `disabled` while a turn runs: its tooltip says why it does nothing. */}
      <button
        type="button"
        class="icon-button"
        aria-label="Edit from here"
        aria-disabled={busy()}
        data-tip={
          busy()
            ? "Stop the turn to edit from here"
            : "Edit from here: the thread goes back to before this prompt, which returns to the composer. Files stay as they are."
        }
        onClick={() => edit()}
      >
        <UndoIcon />
      </button>
    </Show>
  );
}

/** Where prompts are written: text, pasted or dropped images, completions, send and stop. Its notices, controls, completions, and footer are slots. */
export default defineWebPlugin({
  id: "threads.composer",
  styles,
  config: ComposerConfig,
  requires: { client: Client, threads: Threads, models: Models, workspace: Workspace, notify: Notify, slots: Slots, router: Router, webPlugins: WebPlugins },
  setup: (use, plugin) => {
    const [focus, setFocus] = createSignal<() => void>();
    const [queueOpen, setQueueOpen] = createSignal(true);
    const drafts = new SharedDrafts(use.threads.drafts(), use.threads.setDraft);
    const outgoing = new Set<Draft>();
    const [editing, setEditing] = createSignal<{ readonly sessionId: string; readonly cursor: number }>();
    // A deleted thread (a blank tab closed) takes its draft with it, so closing the app does not ask about it.
    createEffect(() => {
      if (!use.threads.loaded()) return;
      const known = new Set(use.threads.list().map((session) => session.id));
      for (const key of drafts.keys()) if (key !== "" && !known.has(key)) drafts.delete(key);
    });
    const deps: Deps = {
      ...use,
      config: plugin.config,
      drafts,
      outgoing,
      setFocus: (next) => setFocus(() => next),
      queueOpen,
      setQueueOpen,
      editing,
    };
    // An unsent prompt a reload would lose (its images, a send that did not get through), in any thread, or one still
    // going out: closing or reloading the tab asks first. Drafts' text comes back (`Threads.drafts`), so it does not ask.
    plugin.onCleanup(
      use.router.block(
        (transition) => transition.action !== "unload" || (outgoing.size === 0 && ![...drafts].some(([key, draft]) => lostOnReload(key, draft))),
        { label: "composer: an unsent prompt a reload would lose asks before the tab closes" },
      ),
    );
    use.slots.add(ComposerRegion, { id: "composer", phase: "default", component: () => <Composer deps={deps} /> });
    use.slots.add(ComposerNotices, { id: "composer.answer", order: 50, component: () => <PromptAnswerNotice threads={use.threads} /> });
    // Its own button goes through the slot other plugins add theirs to, and its queue rows through a part others replace.
    use.slots.add(ComposerActions, { id: "composer.attach", order: 100, component: AttachImages });
    // Under each prompt in the transcript, first: it owns the box the prompt comes back to.
    const bases = createMemo(() => promptBases(use.threads.branch()));
    use.slots.add(PromptActions, {
      id: "composer.edit",
      order: 10,
      component: (props) => <EditFromHere {...props} deps={deps} bases={bases} edited={(sessionId, cursor) => setEditing({ sessionId, cursor })} />,
    });
    use.slots.add(ComposerQueuedPart, { id: "composer.queued", phase: "default", component: QueuedRow });
    use.slots.add(ComposerSuggestionPart, { id: "composer.suggestion", phase: "default", component: SuggestionRow });
    // How it sends and stops, in General: its own config, written as the Plugins page would.
    const option = <K extends keyof typeof ComposerConfig.Type>(key: K) => {
      const setting = configSetting<(typeof ComposerConfig.Type)[K]>(use.webPlugins, use.notify, plugin.id, key);
      return { value: () => setting.value() ?? plugin.config[key], set: setting.set };
    };
    const send = option("send");
    const whenBusy = option("whenBusy");
    const stop = option("stop");
    use.slots.add(SettingsGroups, {
      id: "composer.send",
      order: 20,
      section: SectionIds.general,
      title: "Composer",
      entries: () => [
        {
          text: "Composer: send a message with Enter or Mod+Enter; the other one, or Shift+Enter, starts a new line; Mod+Enter (Mod+Shift+Enter while it sends) runs it in a new thread in the background",
          view: () => <SendSetting send={send.value()} onChange={send.set} />,
        },
        {
          text: "Composer: while a turn runs, sending steers it or queues the message for after it; Alt does the other",
          view: () => <WhenBusySetting whenBusy={whenBusy.value()} onChange={whenBusy.set} />,
        },
        {
          text: "Composer: stop a running turn with Escape twice, or once",
          view: () => <StopSetting stop={stop.value()} onChange={stop.set} />,
        },
      ],
    });
    use.slots.add(Actions, {
      id: ThreadsActionIds.focusComposer,
      order: 3,
      title: "Focus prompt",
      category: "Thread",
      icon: ChatIcon,
      keys: "/",
      when: () => focus() !== undefined,
      run: () => focus()?.(),
    });
  },
});
