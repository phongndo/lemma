import { For, Show, createEffect, createSignal, on, onCleanup, onMount } from "solid-js";
import { Dynamic } from "solid-js/web";
import { Schema } from "effect";
import type { ImageContent, PromptContent, QueuedPrompt } from "@lemma/contracts";
import { randomId } from "../lib/id.ts";
import { formatKeys, modKey } from "../lib/keys.ts";
import {
  ActionIds,
  Actions,
  Client,
  ComposerActions,
  ComposerControls,
  ComposerFooter,
  ComposerNotices,
  ComposerQueuedPart,
  ComposerRegion,
  Models,
  Notify,
  Router,
  Threads,
  Slots,
  Workspace,
} from "../ui/contracts.ts";
import type {
  ClientService,
  ComposerActionProps,
  ComposerQueuedProps,
  ModelsService,
  NotifyService,
  ThreadsService,
  WorkspaceService,
} from "../ui/contracts.ts";
import { defineUiPlugin } from "../ui/define.ts";
import { DEFAULT_PART_ORDER } from "../ui/slots.ts";
import type { SlotsService } from "../ui/slots.ts";
import { ChatIcon, ComposerQueued, ImageIcon, SendIcon, StopIcon, XIcon } from "../ui/parts.tsx";
import styles from "./composer.css?inline";

/** The formats every provider accepts; others (SVG, HEIC, TIFF…) would fail every later request in the session. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** Providers reject larger images (5 MB of base64), and a rejected image would be resent with every later prompt. Matches the read tool. */
const MAX_IMAGE_BYTES = 3.75 * 1024 * 1024;

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

export const ComposerConfig = Schema.Struct({
  send: Schema.optionalWith(Schema.Literal("enter", "mod+enter"), { default: () => "enter" as const }).annotations({
    title: "Send with",
    description: "enter: Enter sends and Shift+Enter starts a new line. mod+enter: ⌘Enter (Ctrl+Enter) sends and Enter starts a new line.",
  }),
});

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

function Composer(props: { deps: Deps }) {
  const { client, threads, models, workspace, notify, slots, drafts } = props.deps;
  const draftKey = () => threads.activeId() ?? "";
  const saved = drafts.get(draftKey());
  const [text, setText] = createSignal(saved?.text ?? "");
  const [images, setImages] = createSignal<readonly ImageContent[]>(saved?.images ?? []);
  const [dragging, setDragging] = createSignal(false);
  const [sending, setSending] = createSignal(false);
  let input!: HTMLTextAreaElement;

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
    const sent: Draft = { text: text(), images: images(), requestId: drafts.get(key)?.requestId ?? randomId() };
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
      <For each={slots.list(ComposerNotices)}>{(notice) => <Dynamic component={notice.component} />}</For>
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
          spellcheck={true}
          onInput={(event) => {
            edited();
            setText(event.currentTarget.value);
            resize();
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        <div class="composer-bar">
          <div class="composer-controls">
            <For each={slots.list(ComposerControls)}>{(control) => <Dynamic component={control.component} />}</For>
          </div>
          <div class="composer-actions">
            <For each={slots.list(ComposerActions)}>{(action) => <Dynamic component={action.component} addFiles={addFiles} insert={insert} />}</For>
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
      <For each={slots.list(ComposerFooter)}>{(item) => <Dynamic component={item.component} />}</For>
    </div>
  );
}

/** Where prompts are written: text, pasted or dropped images, send and stop. Its notices, controls, and footer are slots. */
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
        accept="image/png,image/jpeg,image/gif,image/webp"
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

export default defineUiPlugin({
  id: "composer",
  styles,
  config: ComposerConfig,
  requires: { client: Client, threads: Threads, models: Models, workspace: Workspace, notify: Notify, slots: Slots, router: Router },
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
    plugin.onCleanup(use.slots.add(ComposerRegion, { id: "composer", component: () => <Composer deps={deps} /> }));
    // Its own button goes through the slot other plugins add theirs to, and its queue rows through a part others replace.
    plugin.onCleanup(use.slots.add(ComposerActions, { id: "composer.attach", order: 100, component: AttachImages }));
    plugin.onCleanup(use.slots.add(ComposerQueuedPart, { id: "composer.queued", order: DEFAULT_PART_ORDER, component: QueuedRow }));
    plugin.onCleanup(
      use.slots.add(Actions, {
        id: ActionIds.focusComposer,
        order: 3,
        title: "Focus prompt",
        category: "Thread",
        icon: ChatIcon,
        keys: "/",
        when: () => focus() !== undefined,
        run: () => focus()?.(),
      }),
    );
  },
});
