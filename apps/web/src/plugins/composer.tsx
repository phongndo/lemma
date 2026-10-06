import { For, Show, batch, createEffect, createMemo, createSignal, createUniqueId, on, onCleanup, onMount, untrack } from "solid-js";
import { Schema } from "effect";
import { newRequestId } from "@lemma/client";
import { IMAGE_TYPES, MAX_IMAGE_BYTES } from "@lemma/contracts";
import type { ImageContent, PromptContent, QueuedPrompt } from "@lemma/contracts";
import { formatKeys, modKey } from "../lib/keys.ts";
import { applySuggestion, findTrigger } from "../model/completion.ts";
import type { TriggerMatch } from "../model/completion.ts";
import {
  ActionIds,
  Actions,
  Client,
  ComposerActions,
  ComposerCompletions,
  ComposerControls,
  ComposerFooter,
  ComposerNotices,
  ComposerQueuedPart,
  ComposerRegion,
  ComposerSuggestionPart,
  Models,
  Notify,
  Router,
  SectionIds,
  SettingsGroups,
  Threads,
  Slots,
  UiPlugins,
  Workspace,
} from "../ui/contracts.ts";
import type {
  ClientService,
  ComposerActionProps,
  ComposerCompletion,
  ComposerCompletionAnswer,
  ComposerQueuedProps,
  ComposerSuggestion,
  ComposerSuggestionProps,
  ModelsService,
  NotifyService,
  ThreadsService,
  WorkspaceService,
} from "../ui/contracts.ts";
import { defineUiPlugin } from "../ui/define.ts";
import { DEFAULT_PART_ORDER } from "../ui/slots.ts";
import type { SlotItem, SlotsService } from "../ui/slots.ts";
import {
  ChatIcon,
  ComposerQueued,
  ComposerSuggestionView,
  Each,
  Highlighted,
  ImageIcon,
  Isolated,
  Segmented,
  SendIcon,
  SettingRow,
  StopIcon,
  XIcon,
} from "../ui/parts.tsx";
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
  send: Schema.optionalWith(Schema.Literal("enter", "mod+enter"), { default: () => "enter" as const }).annotations({
    title: "Send with",
    description: "enter: Enter sends and Shift+Enter starts a new line. mod+enter: ⌘Enter (Ctrl+Enter) sends and Enter starts a new line.",
  }),
});

type Send = typeof ComposerConfig.Type.send;

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
  readonly setFocus: (focus: (() => void) | undefined) => void;
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
 * Escape dismisses the word until the cursor leaves it.
 */
function createCompletion(slots: SlotsService, text: () => string, cursor: () => number, focused: () => boolean) {
  const sources = () => slots.list(ComposerCompletions);
  const [dismissed, setDismissed] = createSignal<number>();
  const word = createMemo(() => (focused() ? findTrigger(text(), cursor(), [...new Set(sources().map((source) => source.trigger))]) : undefined), undefined, {
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
  const { client, threads, models, workspace, notify, slots, drafts } = props.deps;
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
  const completion = createCompletion(slots, text, cursor, focused);
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
        const requestId = drafts.get(draftKey())?.requestId;
        drafts.set(draftKey(), { text, images, ...(requestId === undefined ? {} : { requestId }) });
      },
      { defer: true },
    ),
  );
  /** The person changed the prompt: sending it is a new submission, not a retry of the last one. */
  const edited = () => {
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

  // While a turn runs, sending steers it (or, with Alt, queues the prompt for after it).
  const canSend = () => client.connected() && !sending() && (text().trim() !== "" || images().length > 0);
  const acceptsImages = () => models.selected()?.input.includes("image") ?? true;

  const submit = async (whenBusy: "steer" | "follow-up" = "steer") => {
    if (!canSend()) return;
    const content: PromptContent = [...(text().trim() === "" ? [] : [{ type: "text" as const, text: text() }]), ...images()];
    // Sending a new chat creates a session and switches to it, so remember which draft this was.
    const key = draftKey();
    const sent: Draft = { text: text(), images: images(), requestId: drafts.get(key)?.requestId ?? newRequestId() };
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
    drafts.delete(key);
    if (ok) {
      setText("");
      setImages([]);
    } else {
      // Refused: the prompt returns to the composer, which may now show the session `send` created.
      drafts.set(draftKey(), sent);
      setText(sent.text);
      setImages(sent.images);
    }
    queueMicrotask(resize);
  };

  const insert = (value: string) => {
    const start = input.selectionStart ?? text().length;
    const end = input.selectionEnd ?? start;
    const next = text().slice(0, start) + value + text().slice(end);
    edited();
    setText(next);
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
    edited();
    // Together, so completion never sees the new text with the old cursor (and asks for a word nobody typed).
    batch(() => {
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
    const images = [...files].filter((file) => file.type.startsWith("image/"));
    const supported = images.filter((file) => IMAGE_TYPES.has(file.type));
    const accepted = supported.filter((file) => file.size <= MAX_IMAGE_BYTES);
    const unsupported = images.length - supported.length;
    const tooLarge = supported.length - accepted.length;
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
    const read = await Promise.all(accepted.map(readImage));
    edited();
    setImages((current) => [...current, ...read]);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    // The completion menu, while open, takes the keys that move through it, pick, and close it.
    // Only plain keys: with a modifier they stay the app's (mod+alt+arrows switch threads, mod+enter sends).
    const plain = !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
    if (completion.open() && plain && !event.isComposing) {
      const count = completion.items().length;
      if ((event.key === "ArrowDown" || event.key === "ArrowUp") && count > 0) {
        event.preventDefault();
        completion.move(event.key === "ArrowDown" ? 1 : -1);
        return;
      }
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
      // Alt queues it for after the running turn; with none running, Alt+Enter is left to the field.
      if (event.altKey && !threads.busy()) return;
      event.preventDefault();
      void submit(event.altKey ? "follow-up" : "steer");
    } else if (event.key === "Escape" && threads.busy()) {
      event.preventDefault();
      threads.cancel();
    }
  };

  const onPaste = (event: ClipboardEvent) => {
    const files = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith("image/"));
    if (files.length === 0) return;
    event.preventDefault();
    void addFiles(files);
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer !== null) void addFiles(event.dataTransfer.files);
  };

  const placeholder = () => {
    if (!client.connected()) return "Waiting for the host…";
    if (threads.busy()) return `Steer it, or ${formatKeys(props.deps.config.send === "mod+enter" ? "alt+mod+enter" : "alt+enter")} to send after it`;
    return threads.activeId() === undefined ? "Ask anything, or describe a task" : "Reply…";
  };

  return (
    <div class="composer-wrap">
      <Each slot={ComposerNotices} />
      <form
        class="composer"
        classList={{ dragging: dragging(), busy: threads.busy() }}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
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
        <Show when={threads.queue().length > 0}>
          <ul class="composer-queue" aria-label="Queued prompts">
            <For each={threads.queue()}>{(queued) => <ComposerQueued prompt={queued} withdraw={() => void threads.withdraw(queued.requestId)} />}</For>
          </ul>
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
            edited();
            const value = event.currentTarget.value;
            // Text and cursor together: completion asks for the word once, not for each half of the change.
            batch(() => {
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
          onBlur={() => setFocused(false)}
          onKeyUp={syncCursor}
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
                <button type="submit" class="send" aria-label="Steer" data-tip="Steer: joins the running turn after its current step">
                  <SendIcon />
                </button>
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

/** The default `composer.queued` part: the prompt's mode and text on one line, and a button to withdraw it. */
function QueuedRow(props: ComposerQueuedProps) {
  return (
    <li class="queued">
      <span class="queued-mode">{props.prompt.mode === "steer" ? "Steer" : "Next"}</span>
      <span class="queued-text">{preview(props.prompt.content)}</span>
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

/** The default composer action: pick images to attach. */
function AttachImages(props: ComposerActionProps) {
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
          void props.addFiles([...(event.currentTarget.files ?? [])]);
          event.currentTarget.value = "";
        }}
      />
    </>
  );
}

/** Where prompts are written: text, pasted or dropped images, completions, send and stop. Its notices, controls, completions, and footer are slots. */
export default defineUiPlugin({
  id: "composer",
  styles,
  config: ComposerConfig,
  requires: { client: Client, threads: Threads, models: Models, workspace: Workspace, notify: Notify, slots: Slots, router: Router, uiPlugins: UiPlugins },
  setup: (use, plugin) => {
    const [focus, setFocus] = createSignal<() => void>();
    const drafts = new Map<string, Draft>();
    const deps: Deps = { ...use, config: plugin.config, drafts, setFocus: (next) => setFocus(() => next) };
    // An unsent prompt in any thread, shown or not: closing or reloading the tab asks first. Switching threads keeps drafts, so only an unload does.
    plugin.onCleanup(
      use.router.block((transition) => transition.action !== "unload" || ![...drafts.values()].some(unsent), {
        label: "composer: an unsent prompt asks before the tab closes",
      }),
    );
    use.slots.add(ComposerRegion, { id: "composer", component: () => <Composer deps={deps} /> });
    // Its own button goes through the slot other plugins add theirs to, and its queue rows through a part others replace.
    use.slots.add(ComposerActions, { id: "composer.attach", order: 100, component: AttachImages });
    use.slots.add(ComposerQueuedPart, { id: "composer.queued", order: DEFAULT_PART_ORDER, component: QueuedRow });
    use.slots.add(ComposerSuggestionPart, { id: "composer.suggestion", order: DEFAULT_PART_ORDER, component: SuggestionRow });
    // How it sends belongs with the keys, so it offers the setting on the Keyboard page.
    const setSend = (send: Send) => {
      const self = use.uiPlugins.list().find((candidate) => candidate.id === plugin.id);
      if (self === undefined) return;
      void use.uiPlugins.setConfig(self, { send: send === "enter" ? null : send }).catch((error) => use.notify.report(error, "Could not change the send key"));
    };
    use.slots.add(SettingsGroups, {
      id: "composer.send",
      section: SectionIds.keyboard,
      title: "Composer",
      entries: () => [
        {
          text: "Composer: send a message with Enter or Mod+Enter; the other one, or Shift+Enter, starts a new line",
          view: () => <SendSetting send={plugin.config.send} onChange={setSend} />,
        },
      ],
    });
    use.slots.add(Actions, {
      id: ActionIds.focusComposer,
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
