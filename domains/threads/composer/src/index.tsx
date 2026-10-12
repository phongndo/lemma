import { For, Show, batch, createEffect, createMemo, createSignal, createUniqueId, on, onCleanup, onMount, untrack } from "solid-js";
import type { Accessor } from "solid-js";
import { Effect, Schema } from "effect";
import { newRequestId } from "@lemma/agent/prompt";
import { IMAGE_TYPES, MAX_IMAGE_BYTES } from "@lemma/llm";
import type { PromptContent, QueuedPrompt } from "@lemma/agent";
import type { ImageContent } from "@lemma/llm";
import { formatKeys, listKey, modKey, quickKey } from "@lemma/web/keys";
import { createQuickHold } from "@lemma/web/quick-pick";
import {
  applySuggestion,
  findTrigger,
  ComposerActions,
  ComposerCompletions,
  ComposerControls,
  ComposerFooter,
  ComposerNotices,
  ComposerQueuedPart,
  ComposerRegion,
  ComposerSuggestionPart,
  Threads,
  ThreadsActionIds,
  ComposerQueued,
  ComposerSuggestionView,
  queuePlaces,
} from "@lemma/threads";
import type {
  TriggerMatch,
  ComposerActionProps,
  ComposerCompletion,
  ComposerCompletionAnswer,
  ComposerQueuedProps,
  ComposerSuggestion,
  ComposerSuggestionProps,
  ThreadsService,
} from "@lemma/threads";
import { Actions } from "@lemma/actions";
import { Models } from "@lemma/llm/web";
import { SectionIds, SettingsGroups } from "@lemma/settings";
import { Client, Notify, Router, Slots, WebPlugins, defineWebPlugin, Each, Highlighted, Isolated, usePlugin } from "@lemma/web";
import { Workspace } from "@lemma/workspace/web";
import type { ModelsService } from "@lemma/llm/web";
import type { ClientService, NotifyService, SlotItem, SlotsService } from "@lemma/web";
import type { WorkspaceService } from "@lemma/workspace/web";
import { ChatIcon, ChevronDownIcon, ImageIcon, LogIcon, Segmented, SendIcon, SettingRow, StopIcon, XIcon } from "@lemma/look";
import { recallStep, sentPrompts } from "./history.ts";
import type { SentPrompt } from "./history.ts";
import styles from "./composer.css?inline";

const readImage = (file: File): Promise<ImageContent> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve({ type: "image", mimeType: file.type, data: url.slice(url.indexOf(",") + 1) });
    };
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the image"));
    reader.readAsDataURL(file);
  });

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

/** What each setting is when its row leaves it out. */
const CONFIG_DEFAULTS = Schema.decodeUnknownSync(ComposerConfig)({});

type Send = typeof ComposerConfig.Type.send;
type WhenBusy = typeof ComposerConfig.Type.whenBusy;
type Stop = typeof ComposerConfig.Type.stop;

/** How long a first Escape waits for the second that stops the turn (`stop: "escape-twice"`). */
const STOP_WINDOW_MS = 1000;

/** A prompt being written. */
interface Draft {
  readonly text: string;
  readonly images: readonly ImageContent[];
  /** Kept from a send that did not get through, so sending it again unchanged cannot place it twice; an edit drops it. */
  readonly requestId?: string;
}

/** A queued prompt in a line: its text, whitespace collapsed, or what it attaches. */
const preview = (content: QueuedPrompt["content"]): string => {
  const text = content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const images = content.filter((part) => part.type === "image").length;
  return text || (images === 1 ? "An image" : `${images} images`);
};
const unsent = (draft: Draft) => draft.text.trim() !== "" || draft.images.length > 0;

interface Deps {
  readonly config: typeof ComposerConfig.Type;
  readonly client: ClientService;
  readonly threads: ThreadsService;
  readonly models: ModelsService;
  readonly workspace: WorkspaceService;
  readonly notify: NotifyService;
  readonly slots: SlotsService;
  /**
   * Unsent prompts per thread (and for a new thread): they survive switching threads and the composer leaving the
   * page, as it does while settings show.
   */
  readonly drafts: Map<string, Draft>;
  /** Prompts on their way to the host, not yet taken: the composer has cleared, so they are in no draft. */
  readonly outgoing: Set<Draft>;
  readonly setFocus: (focus: (() => void) | undefined) => void;
  /** The queue above the box shows its prompts, or only its header: one choice for every thread, while the plugin runs. */
  readonly queueOpen: Accessor<boolean>;
  readonly setQueueOpen: (open: boolean) => void;
}

/** What one completion source has for the word: its suggestions and note, or why it has none. */
interface CompletionGroup {
  readonly source: SlotItem<ComposerCompletion>;
  readonly suggestions: readonly ComposerSuggestion[];
  readonly loading: boolean;
  readonly note?: string | undefined;
  readonly error?: string;
}

/** A suggestion in the menu: its group, its place across all groups, and a key that stays with it as answers arrive. */
interface CompletionItem {
  readonly group: CompletionGroup;
  readonly suggestion: ComposerSuggestion;
  readonly index: number;
  readonly key: string;
}

const sameWord = (a: TriggerMatch | undefined, b: TriggerMatch | undefined) =>
  a?.trigger === b?.trigger && a?.query === b?.query && a?.start === b?.start && a?.end === b?.end;

const settled = (answer: ComposerCompletionAnswer): Omit<CompletionGroup, "source"> =>
  "suggestions" in answer ? { suggestions: answer.suggestions, note: answer.note, loading: false } : { suggestions: answer, loading: false };
const failed = (error: unknown): Omit<CompletionGroup, "source"> => ({
  suggestions: [],
  loading: false,
  error: error instanceof Error ? error.message : String(error),
});

/**
 * The completion menu's state: the trigger word at the cursor, what every
 * source with that trigger suggests for it, and which suggestion is active.
 * Escape dismisses the word until the cursor leaves it. It looks for a word only while `asking`.
 */
function createCompletion(slots: SlotsService, text: () => string, cursor: () => number, asking: () => boolean) {
  const sources = () => slots.list(ComposerCompletions);
  const [dismissed, setDismissed] = createSignal<number>();
  const word = createMemo(() => (asking() ? findTrigger(text(), cursor(), [...new Set(sources().map((source) => source.trigger))]) : undefined), undefined, {
    equals: sameWord,
  });
  createEffect(() => {
    if (dismissed() !== undefined && word()?.start !== dismissed()) setDismissed(undefined);
  });
  const match = createMemo(() => {
    const current = word();
    return current === undefined || current.start === dismissed() ? undefined : current;
  });

  const [groups, setGroups] = createSignal<readonly CompletionGroup[]>([]);
  let shown: TriggerMatch | undefined;
  createEffect(() => {
    const current = match();
    const answering = current === undefined ? [] : sources().filter((source) => source.trigger === current.trigger);
    // Typing on in a word keeps what shows until the next answers arrive. Another word starts empty, and so does the
    // same word asked again because what a source read changed (another project): its old answer is not this one.
    const kept =
      current !== undefined && shown !== undefined && !sameWord(current, shown) && shown.trigger === current.trigger && shown.start === current.start;
    shown = current;
    if (current === undefined) return void setGroups([]);
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    const before = untrack(groups);
    setGroups(
      answering.map((source) => ({
        source,
        suggestions: kept ? (before.find((group) => group.source.id === source.id)?.suggestions ?? []) : [],
        loading: true,
      })),
    );
    const settle = (id: string, group: Omit<CompletionGroup, "source">) => {
      if (!controller.signal.aborted) setGroups((all) => all.map((existing) => (existing.source.id === id ? { source: existing.source, ...group } : existing)));
    };
    for (const source of answering) {
      // Asked here, inside the effect, so the reactive values it reads before its first await are tracked.
      let answer: ReturnType<ComposerCompletion["suggest"]>;
      try {
        answer = source.suggest(current.query, { signal: controller.signal });
      } catch (error) {
        settle(source.id, failed(error));
        continue;
      }
      Promise.resolve(answer).then(
        (result) => settle(source.id, settled(result)),
        (error: unknown) => settle(source.id, failed(error)),
      );
    }
  });

  const items = createMemo(() => {
    let index = 0;
    return groups().flatMap((group) =>
      group.suggestions.map((suggestion): CompletionItem => ({ group, suggestion, index: index++, key: `${group.source.id}\u0000${suggestion.key}` })),
    );
  });
  /** The groups with suggestions, each with its items: what the listbox shows. */
  const sections = createMemo(() =>
    groups()
      .filter((group) => group.suggestions.length > 0)
      .map((group) => ({ group, items: items().filter((item) => item.group.source.id === group.source.id) })),
  );
  // The active suggestion by its key, so it stays put while answers arrive; a new word starts at the first.
  const [chosen, setChosen] = createSignal<string>();
  createEffect(on(match, () => setChosen(undefined)));
  const active = () => {
    const key = chosen();
    return Math.max(0, key === undefined ? 0 : items().findIndex((item) => item.key === key));
  };
  return {
    match,
    groups,
    items,
    sections,
    active,
    /** Some source has yet to answer this word. */
    loading: () => groups().some((group) => group.loading),
    setActive: (index: number) => setChosen(items()[index]?.key),
    open: () => match() !== undefined && groups().length > 0,
    move: (by: number) => {
      const all = items();
      if (all.length > 0) setChosen(all[(active() + by + all.length) % all.length]!.key);
    },
    dismiss: () => setDismissed(match()?.start),
  };
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
  const syncCursor = () => setCursor(input.selectionStart ?? text().length);
  /**
   * The prompt sent in this thread that Up or Down brought back (its place, oldest first), while the composer holds it
   * unchanged: an edit (`edited`), a send, or another thread forgets it. Until then it is history being read, not a
   * draft, and opens no completion menu for a word in it.
   */
  const [recalled, setRecalled] = createSignal<SentPrompt & { readonly at: number }>();
  const completion = createCompletion(slots, text, cursor, () => focused() && recalled() === undefined);
  const listId = createUniqueId();
  const optionId = (index: number) => `${listId}-${index}`;
  createEffect(() => {
    const id = optionId(completion.active());
    if (completion.open()) suggestionList?.querySelector(`#${CSS.escape(id)}`)?.scrollIntoView({ block: "nearest" });
  });

  createEffect(
    on(
      threads.activeId,
      () => {
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
  createEffect(
    on(
      [text, images],
      ([text, images]) => {
        if (recalled() !== undefined) return void drafts.delete(draftKey());
        const requestId = drafts.get(draftKey())?.requestId;
        drafts.set(draftKey(), { text, images, ...(requestId === undefined ? {} : { requestId }) });
      },
      { defer: true },
    ),
  );
  /** The person changed the prompt: sending it is a new submission, not a retry of the last one, and no prompt brought back. */
  const edited = () => {
    setRecalled(undefined);
    const draft = drafts.get(draftKey());
    if (draft?.requestId !== undefined) drafts.set(draftKey(), { text: draft.text, images: draft.images });
  };

  const resize = () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
  };

  onMount(() => {
    props.deps.setFocus(() => input.focus());
    input.focus();
    resize();
  });
  onCleanup(() => props.deps.setFocus(undefined));

  /**
   * The prompts waiting for a turn of their own, shown over the box (`queuePlaces`' `next`): a steer for the running
   * turn has no row, as the conversation shows it where it will join, but with no turn running, what a stopped one left
   * waits here for the next prompt, steers too.
   */
  const places = createMemo(() => queuePlaces(threads));
  const queued = () => places().next;
  const { queueOpen, setQueueOpen } = props.deps;
  const queueId = createUniqueId();

  const canSend = () => client.connected() && !sending() && (text().trim() !== "" || images().length > 0);
  const acceptsImages = () => models.selected()?.input.includes("image") ?? true;
  /** What sending does while a turn runs: what `whenBusy` says, or with Alt (`other`) the other. */
  const busyMode = (other = false): "steer" | "follow-up" => ((props.deps.config.whenBusy === "steer") !== other ? "steer" : "follow-up");

  /**
   * A send asked for while another was still going out, with what the composer held then: it goes once that one is
   * accepted, if the composer holds the same still. What was typed after the Enter waits for one of its own.
   */
  let next: { readonly whenBusy: "steer" | "follow-up"; readonly text: string; readonly images: readonly ImageContent[] } | undefined;
  const submit = async (whenBusy: "steer" | "follow-up" = busyMode()) => {
    if (sending()) {
      if (unsent({ text: text(), images: images() })) next = { whenBusy, text: text(), images: images() };
      return;
    }
    if (!canSend()) return;
    setRecalled(undefined);
    const content: PromptContent = [...(text().trim() === "" ? [] : [{ type: "text" as const, text: text() }]), ...images()];
    // Sending a new chat creates a session and switches to it, so remember which draft this was.
    const key = draftKey();
    const sent: Draft = { text: text(), images: images(), requestId: drafts.get(key)?.requestId ?? newRequestId() };
    // The composer clears as the prompt goes out: what is typed meanwhile is the next prompt, never this one. Until the
    // host takes it, it is outgoing (closing the tab asks first), and if refused it comes back.
    outgoing.add(sent);
    drafts.delete(key);
    setText("");
    setImages([]);
    setSending(true);
    let ok = false;
    try {
      // A new chat may start in its own worktree, named from the prompt.
      const cwd = threads.activeId() === undefined ? await workspace.newChatDir(sent.text) : undefined;
      ok = await threads.send(content, { turn: models.turnOptions(), cwd, requestId: sent.requestId, whenBusy });
    } catch (error) {
      notify.report(error, "Could not create a session");
    }
    setSending(false);
    outgoing.delete(sent);
    if (!ok) {
      // Refused: back to the thread it was written in (a new chat's, to the session `send` created, which the composer
      // shows now), before whatever was typed there since, so nothing is lost. Unchanged, it keeps its request id.
      const home = key === "" ? draftKey() : key;
      const since = drafts.get(home);
      const back: Draft =
        since === undefined || !unsent(since)
          ? sent
          : { text: [sent.text, since.text].filter((part) => part.trim() !== "").join("\n\n"), images: [...sent.images, ...since.images] };
      drafts.set(home, back);
      if (home === draftKey()) {
        setText(back.text);
        setImages(back.images);
      }
    }
    queueMicrotask(resize);
    const queued = next;
    next = undefined;
    if (ok && queued !== undefined && text() === queued.text && images() === queued.images) void submit(queued.whenBusy);
  };
  const plugin = usePlugin();
  const send = plugin.action("send the prompt", (whenBusy?: "steer" | "follow-up") => submit(whenBusy));

  /**
   * Up or Down in an empty composer, or in one holding a sent prompt it brought back unchanged with the cursor at its
   * start or end: the next older or newer prompt sent in the thread, or past the newest an empty composer again.
   * False when the key is the field's (it moves the cursor).
   */
  const recall = (direction: "older" | "newer"): boolean => {
    const start = input.selectionStart ?? 0;
    const end = input.selectionEnd ?? 0;
    const from = recalled()?.at;
    if (from === undefined && (text() !== "" || images().length > 0)) return false;
    if (from !== undefined && (start !== end || (start !== 0 && start !== text().length))) return false;
    // Read from the branch when asked: the branch may have changed since the last (checked out further back, say).
    const history = sentPrompts(threads.branch());
    const at = recallStep(history.length, from, direction);
    if (at === from) return false;
    const prompt = at === undefined ? { text: "", images: [] } : history[at]!;
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

  /**
   * A first Escape that asked for a second to stop the turn (`stop: "escape-twice"`), until the window closes, another
   * thread shows, or the turn ends: a second Escape stops only the turn the first was pressed in.
   */
  const [stopping, setStopping] = createSignal(false);
  let closeWindow: (() => void) | undefined;
  const disarm = () => {
    closeWindow?.();
    closeWindow = undefined;
    setStopping(false);
  };
  const escapeStops = () => {
    const second = stopping();
    disarm();
    if (props.deps.config.stop === "escape" || second) return void threads.cancel();
    setStopping(true);
    closeWindow = plugin.after(STOP_WINDOW_MS, () => setStopping(false));
  };
  createEffect(on([threads.activeId, threads.busy], disarm, { defer: true }));
  onCleanup(disarm);

  const insert = (value: string) => {
    const start = input.selectionStart ?? text().length;
    const end = input.selectionEnd ?? start;
    const next = text().slice(0, start) + value + text().slice(end);
    batch(() => {
      edited();
      setText(next);
    });
    queueMicrotask(() => {
      input.focus();
      input.setSelectionRange(start + value.length, start + value.length);
      syncCursor();
      resize();
    });
  };
  /** Puts a suggestion in place of the word being completed. */
  const pick = (suggestion: ComposerSuggestion) => {
    const word = completion.match();
    if (word === undefined) return;
    const next = applySuggestion(text(), word, suggestion.insert, { space: suggestion.partial !== true });
    // Together, so completion never sees the new text with the old cursor (and asks for a word nobody typed).
    batch(() => {
      edited();
      setText(next.text);
      setCursor(next.cursor);
    });
    queueMicrotask(() => {
      input.focus();
      input.setSelectionRange(next.cursor, next.cursor);
      resize();
    });
  };
  const addFiles = async (files: Iterable<File>) => {
    const given = [...files];
    // A file of no type the browser knows (an image with an unusual extension, say) is told it is not a format taken,
    // not that it is no image.
    const others = given.filter((file) => file.type !== "" && !file.type.startsWith("image/")).length;
    const supported = given.filter((file) => IMAGE_TYPES.has(file.type));
    const accepted = supported.filter((file) => file.size <= MAX_IMAGE_BYTES);
    const unsupported = given.length - others - supported.length;
    const tooLarge = supported.length - accepted.length;
    if (others > 0) notify.toast({ level: "warning", message: `${others === 1 ? "A file was" : `${others} files were`} not attached: only images can be.` });
    if (unsupported > 0)
      notify.toast({
        level: "warning",
        message: `${unsupported === 1 ? "An image was" : `${unsupported} images were`} not attached: use PNG, JPEG, GIF, or WebP.`,
      });
    if (tooLarge > 0)
      notify.toast({
        level: "warning",
        message: `${tooLarge === 1 ? "An image was" : `${tooLarge} images were`} not attached: over the 3.75 MB limit providers accept.`,
      });
    if (accepted.length === 0) return;
    // One that cannot be read (gone from a network share, say) is told of; the rest attach.
    const read = await Promise.allSettled(accepted.map(readImage));
    const unread = read.filter((result) => result.status === "rejected").length;
    if (unread > 0)
      notify.toast({
        level: "warning",
        message: `${unread === 1 ? "An image" : `${unread} images`} could not be read, and ${unread === 1 ? "was" : "were"} not attached.`,
      });
    const attached = read.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
    if (attached.length === 0) return;
    edited();
    setImages((current) => [...current, ...attached]);
  };

  const hold = createQuickHold();
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
          pick(completion.items()[completion.active()]!.suggestion);
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
    const sends = props.deps.config.send === "mod+enter" ? modKey(event) : !modKey(event) && !event.ctrlKey && !event.metaKey;
    if (event.key === "Enter" && sends && !event.shiftKey && !event.isComposing) {
      // Alt does what `whenBusy` does not; with no turn running, Alt+Enter is left to the field.
      if (event.altKey && !threads.busy()) return;
      event.preventDefault();
      void submit(busyMode(event.altKey));
    } else if ((event.key === "ArrowUp" || event.key === "ArrowDown") && plain && !event.isComposing) {
      if (recall(event.key === "ArrowUp" ? "older" : "newer")) event.preventDefault();
    } else if (event.key === "Escape" && threads.busy()) {
      event.preventDefault();
      // One held down repeats: it stops nothing, or the two presses `escape-twice` asks for would be one.
      if (!event.repeat) escapeStops();
    }
  };

  // Files pasted or dropped attach, or are told why not (`addFiles`); text is the field's, pasted or dropped as it is.
  const onPaste = (event: ClipboardEvent) => {
    const files = [...(event.clipboardData?.files ?? [])];
    if (files.length === 0) return;
    event.preventDefault();
    void addFiles(files);
  };

  const onDrop = (event: DragEvent) => {
    setDragging(false);
    const files = [...(event.dataTransfer?.files ?? [])];
    if (files.length === 0) return;
    event.preventDefault();
    void addFiles(files);
  };

  const placeholder = () => {
    if (!client.connected()) return "Waiting for the host…";
    if (threads.busy()) {
      const other = formatKeys(props.deps.config.send === "mod+enter" ? "alt+mod+enter" : "alt+enter");
      return busyMode() === "steer" ? `Steer it, or ${other} to queue for after it` : `Queue for after it, or ${other} to steer it`;
    }
    return threads.activeId() === undefined ? "Ask anything, or describe a task" : "Reply…";
  };

  return (
    <div class="composer-wrap">
      <Each slot={ComposerNotices} />
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
      <form
        class="composer"
        classList={{ dragging: dragging(), busy: threads.busy() }}
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
        onDragOver={(event) => {
          if (event.dataTransfer?.types.includes("Files")) {
            event.preventDefault();
            setDragging(true);
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
              <Show when={completion.items().length === 0 && completion.groups().every((group) => group.error === undefined)}>
                <div class="completions-note">{completion.loading() ? "Searching…" : "No matches"}</div>
              </Show>
            </div>
          </div>
        </Show>
        <Show when={images().length > 0}>
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
        <textarea
          ref={input}
          rows={1}
          value={text()}
          placeholder={placeholder()}
          aria-label="Message"
          aria-autocomplete="list"
          aria-controls={completion.open() && completion.items().length > 0 ? listId : undefined}
          aria-activedescendant={completion.open() && completion.items().length > 0 ? optionId(completion.active()) : undefined}
          spellcheck={true}
          onInput={(event) => {
            const value = event.currentTarget.value;
            // Text and cursor together: completion asks for the word once, not for each half of the change.
            batch(() => {
              edited();
              setText(value);
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
        <div class="composer-bar">
          <div class="composer-controls">
            <Each slot={ComposerControls} />
          </div>
          <div class="composer-actions">
            <Each slot={ComposerActions} props={{ addFiles, insert }} />
            <Show
              when={threads.busy()}
              fallback={
                <button type="submit" class="send" disabled={!canSend()} aria-label="Send" data-tip="Send">
                  <SendIcon />
                </button>
              }
            >
              <Show when={canSend()}>
                {/* With Alt, the other of steering and queueing, as with the send key. */}
                <button
                  type="submit"
                  class="send"
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
              <Show when={stopping()}>
                <span class="composer-hint" role="status">
                  {formatKeys("escape")} again to stop
                </span>
              </Show>
              <button type="button" class="send stop" aria-label="Stop" data-tip="Stop" onClick={() => threads.cancel()}>
                <StopIcon />
              </button>
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
      <span class="queued-text">{preview(props.prompt.content)}</span>
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

/** Which keys send, on the Keyboard page. */
function SendSetting(props: { send: Send; onChange: (send: Send) => void }) {
  return (
    <SettingRow title="Send a message" description="The other one starts a new line, as does Shift+Enter.">
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

/** What sending does while a turn runs, on the Keyboard page. */
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

/** Which Escape stops a running turn, on the Keyboard page. */
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

/** Where prompts are written: text, pasted or dropped images, completions, send and stop. Its notices, controls, completions, and footer are slots. */
export default defineWebPlugin({
  id: "threads.composer",
  styles,
  config: ComposerConfig,
  requires: { client: Client, threads: Threads, models: Models, workspace: Workspace, notify: Notify, slots: Slots, router: Router, webPlugins: WebPlugins },
  setup: (use, plugin) => {
    const [focus, setFocus] = createSignal<() => void>();
    const [queueOpen, setQueueOpen] = createSignal(true);
    const drafts = new Map<string, Draft>();
    const outgoing = new Set<Draft>();
    const deps: Deps = { ...use, config: plugin.config, drafts, outgoing, setFocus: (next) => setFocus(() => next), queueOpen, setQueueOpen };
    // An unsent prompt in any thread, shown or not, or one still going out: closing or reloading the tab asks first.
    // Switching threads keeps drafts, so only an unload does.
    plugin.onCleanup(
      use.router.block((transition) => transition.action !== "unload" || (outgoing.size === 0 && ![...drafts.values()].some(unsent)), {
        label: "composer: an unsent prompt asks before the tab closes",
      }),
    );
    use.slots.add(ComposerRegion, { id: "composer", phase: "default", component: () => <Composer deps={deps} /> });
    use.slots.add(ComposerNotices, { id: "composer.answer", order: 50, component: () => <PromptAnswerNotice threads={use.threads} /> });
    // Its own button goes through the slot other plugins add theirs to, and its queue rows through a part others replace.
    use.slots.add(ComposerActions, { id: "composer.attach", order: 100, component: AttachImages });
    use.slots.add(ComposerQueuedPart, { id: "composer.queued", phase: "default", component: QueuedRow });
    use.slots.add(ComposerSuggestionPart, { id: "composer.suggestion", phase: "default", component: SuggestionRow });
    // How it sends and stops belongs with the keys, so it offers those settings on the Keyboard page. A default is
    // written as unset, so the file keeps only what was changed.
    const setOption = <K extends keyof typeof ComposerConfig.Type>(key: K, value: (typeof ComposerConfig.Type)[K]) => {
      const self = use.webPlugins.list().find((candidate) => candidate.id === plugin.id);
      if (self === undefined) return;
      void use.webPlugins
        .setConfig(self, { [key]: value === CONFIG_DEFAULTS[key] ? null : value })
        .catch((error) => use.notify.report(error, "Could not change the composer's setting"));
    };
    use.slots.add(SettingsGroups, {
      id: "composer.send",
      order: 0,
      section: SectionIds.keyboard,
      title: "Composer",
      entries: () => [
        {
          text: "Composer: send a message with Enter or Mod+Enter; the other one, or Shift+Enter, starts a new line",
          view: () => <SendSetting send={plugin.config.send} onChange={(send) => setOption("send", send)} />,
        },
        {
          text: "Composer: while a turn runs, sending steers it or queues the message for after it; Alt does the other",
          view: () => <WhenBusySetting whenBusy={plugin.config.whenBusy} onChange={(whenBusy) => setOption("whenBusy", whenBusy)} />,
        },
        {
          text: "Composer: stop a running turn with Escape twice, or once",
          view: () => <StopSetting stop={plugin.config.stop} onChange={(stop) => setOption("stop", stop)} />,
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
