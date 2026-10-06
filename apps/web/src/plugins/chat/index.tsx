import { For, Index, Match, Show, Switch, createEffect, createMemo, createSignal, on, onCleanup, onMount, untrack } from "solid-js";
import type { Component, JSX } from "solid-js";
import { formatDuration, formatTokens, parseModelRef } from "@lemma/contracts";
import type { TextContent } from "@lemma/contracts";
import { formatElapsed, summarizeUsage } from "../../model/format.ts";
import { answerText, entryKey, foldRunning, foldTurn } from "../../model/fold.ts";
import type { TurnEntry } from "../../model/fold.ts";
import { parseDraftArgs } from "../../model/live.ts";
import type { DraftBlock, StepDraft } from "../../model/live.ts";
import { createProjector, pendingToolCalls, promptMarks } from "../../model/transcript.ts";
import type { AssistantItem, AttemptItem, Block, Item, TurnView } from "../../model/transcript.ts";
import { JUMP_MARGIN, jumpOver, locate as locatePrompts } from "../../model/prompt-rail.ts";
import { createNow } from "../../lib/now.ts";
import {
  ChatThinkingPart,
  ChatToolPart,
  ChatTurnFooterPart,
  ChatUserPart,
  ChatWorkingPart,
  ChatWorkPart,
  Client,
  Router,
  Threads,
  Slots,
  Views,
} from "../../ui/contracts.ts";
import type { ChatThinkingProps, ChatTurnFooterProps, ChatUserProps, ChatWorkingProps, ChatWorkProps } from "../../ui/contracts.ts";
import { defineUiPlugin } from "../../ui/define.ts";
import { DEFAULT_PART_ORDER } from "../../ui/slots.ts";
import type { Part } from "../../ui/slots.ts";
import {
  AlertIcon,
  ChatIcon,
  ChatThinking,
  ChatTurnFooter,
  ChatUser,
  ChatWork,
  ChatWorking,
  ChevronDownIcon,
  ChevronIcon,
  Markdown,
  Spinner,
  CopyButton,
} from "../../ui/parts.tsx";
import styles from "./chat.css?inline";
import { ChatConfig } from "./config.ts";
import type { Chat } from "./config.ts";
import { PromptRail } from "./rail.tsx";
import { Images, ToolCard, toolView } from "./tools.tsx";
import type { ToolState } from "./tools.tsx";

/** The chat's scroll position, kept with each history entry. */
const SCROLL_STATE = "chat.scroll";

/** The default `chat.user` part. */
function UserView(props: ChatUserProps) {
  const text = () =>
    props.content
      .filter((part): part is TextContent => part.type === "text")
      .map((part) => part.text)
      .join("\n\n");
  return (
    <div class="user-message">
      <Show when={text()}>
        <div class="user-text">{text()}</div>
      </Show>
      <Images content={props.content} />
    </div>
  );
}

/** A thought, through the `chat.thinking` part, opened and closed with the chat's other disclosures. */
function Thinking(props: { chat: Chat; id: string; text: string; redacted?: boolean; live?: boolean }) {
  return (
    <ChatThinking
      text={props.text}
      redacted={props.redacted}
      live={props.live}
      open={props.chat.isOpen(props.id, false)}
      onToggle={() => props.chat.toggle(props.id, false)}
    />
  );
}

/** The default `chat.thinking` part. */
function ThinkingView(props: ChatThinkingProps) {
  const open = () => props.open;
  const preview = () =>
    props.text
      .trim()
      .split("\n")
      .filter(Boolean)
      .at(props.live ? -1 : 0) ?? "";
  return (
    <div class="thinking" classList={{ open: open(), live: props.live === true }}>
      <button class="thinking-head" aria-expanded={open()} onClick={() => props.onToggle()}>
        <ChevronIcon class="chevron" />
        <span class="thinking-label">{props.live ? "Thinking" : props.redacted ? "Thinking (redacted)" : "Thought"}</span>
        <Show when={!open() && preview()}>
          <span class="thinking-preview">{preview()}</span>
        </Show>
      </button>
      <Show when={open()}>
        <div class="thinking-body">{props.text}</div>
      </Show>
    </div>
  );
}

function Blocks(props: { chat: Chat; blocks: readonly Block[]; turnEnded: boolean }) {
  return (
    <For each={props.blocks}>
      {(block) => (
        <Switch>
          <Match when={block.kind === "text" && block}>{(b) => <Markdown text={b().text} />}</Match>
          <Match when={block.kind === "thinking" && block}>
            {(b) => (
              <Show when={b().text.trim() || b().redacted}>
                <Thinking chat={props.chat} id={b().key} text={b().text} redacted={b().redacted} />
              </Show>
            )}
          </Match>
          <Match when={block.kind === "tool" && block}>
            {(b) => {
              const toolState = (): ToolState => {
                const result = b().result;
                if (result !== undefined) return result.isError ? "error" : "ok";
                return props.turnEnded || !props.chat.threads.busy() ? "interrupted" : "running";
              };
              return <ToolCard chat={props.chat} id={b().call.id} name={b().call.name} args={b().call.arguments} result={b().result} state={toolState()} />;
            }}
          </Match>
        </Switch>
      )}
    </For>
  );
}

function StopNote(props: { item: AssistantItem }) {
  return (
    <Switch>
      <Match when={props.item.message.stopReason === "error"}>
        <div class="callout callout-error">
          <AlertIcon />
          <span>{props.item.message.errorMessage ?? "The model request failed."}</span>
        </div>
      </Match>
      <Match when={props.item.message.stopReason === "aborted"}>
        <p class="note">Stopped</p>
      </Match>
      <Match when={props.item.message.stopReason === "length"}>
        <p class="note">Output hit the model's token limit</p>
      </Match>
    </Switch>
  );
}

function Attempt(props: { chat: Chat; item: AttemptItem }) {
  const { isOpen, toggle } = props.chat;
  const open = () => isOpen(props.item.id, false);
  const hasContent = () => props.item.blocks.some((block) => block.kind !== "text" || block.text.trim() !== "");
  const label = () => (props.item.message.stopReason === "aborted" ? "Attempt cancelled" : "Attempt failed");
  return (
    <div class="attempt" classList={{ open: open() }}>
      <button class="attempt-head" aria-expanded={open()} disabled={!hasContent()} onClick={() => toggle(props.item.id, false)}>
        <AlertIcon />
        <span class="attempt-label">{label()}</span>
        <span class="attempt-error">{props.item.message.errorMessage ?? ""}</span>
        <span class="muted">{formatDuration(props.item.timing.endedAt - props.item.timing.startedAt)}</span>
      </button>
      <Show when={open() && hasContent()}>
        <div class="attempt-body">
          <Blocks chat={props.chat} blocks={props.item.blocks} turnEnded={true} />
        </div>
      </Show>
    </div>
  );
}

function ItemView(props: { chat: Chat; item: Item; turnEnded: boolean; note?: boolean }): JSX.Element {
  return (
    <Switch>
      <Match when={props.item.kind === "user" && props.item}>{(item) => <ChatUser content={item().content} />}</Match>
      <Match when={props.item.kind === "assistant" && props.item}>
        {(item) => (
          <div class="assistant">
            <Blocks chat={props.chat} blocks={item().blocks} turnEnded={props.turnEnded} />
            <Show when={props.note !== false}>
              <StopNote item={item()} />
            </Show>
          </div>
        )}
      </Match>
      <Match when={props.item.kind === "attempt" && props.item}>{(item) => <Attempt chat={props.chat} item={item()} />}</Match>
      <Match when={props.item.kind === "compaction" && props.item}>
        {(item) => (
          <div class="divider" data-tip={item().summary}>
            <span>Context compacted · {formatTokens(item().tokensBefore)} tokens summarized</span>
          </div>
        )}
      </Match>
      <Match when={props.item.kind === "orphan-result" && props.item}>
        {(item) => (
          <ToolCard
            chat={props.chat}
            id={item().id}
            name={item().message.toolName}
            args={undefined}
            result={{ eventId: item().id, content: item().message.content, isError: item().message.isError }}
            state={item().message.isError ? "error" : "ok"}
          />
        )}
      </Match>
    </Switch>
  );
}

/** The default `chat.turn-footer` part. */
function TurnFooter(props: ChatTurnFooterProps) {
  const usage = createMemo(() => summarizeUsage(props.turn.usage));
  const duration = () => (props.turn.endedAt === undefined ? undefined : props.turn.endedAt - props.turn.startedAt);
  const model = () => props.turn.models.map((ref) => parseModelRef(ref)?.model ?? ref).join(", ");
  const reason = () => props.turn.end?.reason;
  const answer = () => props.answer;
  return (
    <footer class="turn-footer" data-tip={usage().title}>
      <Show when={answer()}>{(text) => <CopyButton text={text()} label="Copy response" class="turn-copy" />}</Show>
      <Show when={reason() === "cancelled"}>
        <span class="badge">cancelled</span>
      </Show>
      <Show when={reason() === "max-steps"}>
        <span class="badge badge-warn">step limit</span>
      </Show>
      <Show when={reason() === "error"}>
        <span class="badge badge-error">error</span>
      </Show>
      <Show when={model()}>
        <span>{model()}</span>
      </Show>
      <Show when={props.turn.usage.totalTokens > 0}>
        <span>
          ↑{usage().input} ↓{usage().output}
        </span>
        <Show when={usage().cache}>
          <span>cache {usage().cache}</span>
        </Show>
      </Show>
      <Show when={usage().cost}>
        <span>{usage().cost}</span>
      </Show>
      <Show when={duration() !== undefined}>
        <span>{formatDuration(duration()!)}</span>
      </Show>
    </footer>
  );
}

/** Folded work, through the `chat.work` part; the chat renders the steps inside it. */
function WorkFold(props: { chat: Chat; work: Extract<TurnEntry, { kind: "work" }> }) {
  return (
    <ChatWork
      steps={props.work.items.length}
      tools={props.work.tools}
      failed={props.work.failed}
      duration={props.work.duration}
      live={props.work.live}
      open={props.chat.isOpen(props.work.key, false)}
      onToggle={() => props.chat.toggle(props.work.key, false)}
    >
      <For each={props.work.items}>{(item) => <ItemView chat={props.chat} item={item} turnEnded={!props.work.live} note={false} />}</For>
    </ChatWork>
  );
}

/** The default `chat.work` part: a turn's work behind its answer as one quiet line (how long it took, how many tool calls) that opens to the steps. */
function WorkView(props: ChatWorkProps) {
  return (
    <div class="work" classList={{ open: props.open }}>
      <button class="work-head" aria-expanded={props.open} onClick={() => props.onToggle()}>
        <ChevronIcon class="chevron" />
        <span class="work-label">
          {props.live
            ? props.steps === 1
              ? "1 earlier step"
              : `${props.steps} earlier steps`
            : props.duration === undefined
              ? "Worked"
              : `Worked for ${formatDuration(props.duration)}`}
        </span>
        <span class="work-meta">
          {props.tools === 1 ? "1 tool call" : `${props.tools} tool calls`}
          <Show when={props.failed > 0}>
            <span class="work-failed"> · {props.failed} failed</span>
          </Show>
        </span>
      </button>
      <Show when={props.open}>
        <div class="work-body">{props.children}</div>
      </Show>
    </div>
  );
}

/** The default `chat.working` part. */
function WorkingView(props: ChatWorkingProps) {
  return (
    <div class="working">
      <span class="pulse" />
      Working
      <Show when={props.startedAt}>{(started) => <span class="working-time">{formatElapsed(props.now - started())}</span>}</Show>
    </div>
  );
}

function Turn(props: { chat: Chat; turn: TurnView }) {
  const ended = () => props.turn.end !== undefined;
  const folded = createMemo(() => (props.chat.config.foldWork ? (foldTurn(props.turn) ?? foldRunning(props.turn)) : undefined));
  // A fold makes new entries each time the turn changes: keyed by entry key, what stays in view stays mounted.
  const byKey = createMemo(() => new Map((folded() ?? []).map((entry) => [entryKey(entry), entry])));
  return (
    <section class="turn" data-turn={props.turn.key}>
      <Show when={folded()} fallback={<For each={props.turn.items}>{(item) => <ItemView chat={props.chat} item={item} turnEnded={ended()} />}</For>}>
        <For each={[...byKey().keys()]}>
          {(key) => (
            <Show when={byKey().get(key)}>
              {(entry) =>
                entry().kind === "work" ? (
                  <WorkFold chat={props.chat} work={entry() as Extract<TurnEntry, { kind: "work" }>} />
                ) : (
                  <ItemView
                    chat={props.chat}
                    item={(entry() as Extract<TurnEntry, { kind: "item" }>).item}
                    turnEnded={ended()}
                    note={(entry() as Extract<TurnEntry, { kind: "item" }>).note}
                  />
                )
              }
            </Show>
          )}
        </For>
      </Show>
      <Show when={props.turn.end?.reason === "error" && props.turn.end.error}>
        <div class="callout callout-error">
          <AlertIcon />
          <span>{props.turn.end!.error}</span>
        </div>
      </Show>
      <Show when={ended()}>
        <ChatTurnFooter turn={props.turn} answer={answerText(props.turn)} />
      </Show>
    </section>
  );
}

function DraftBlockView(props: { chat: Chat; block: DraftBlock; stepId: string; index: number }) {
  return (
    <Switch>
      <Match when={props.block.kind === "text" && props.block}>{(b) => <Markdown text={b().text} class="streaming" streaming />}</Match>
      <Match when={props.block.kind === "thinking" && props.block}>
        {(b) => <Thinking chat={props.chat} id={`${props.stepId}:${props.index}`} text={b().text} live />}
      </Match>
      <Match when={props.block.kind === "tool" && props.block}>
        {(b) => (
          <ToolCard
            chat={props.chat}
            id={b().id || `${props.stepId}:${props.index}`}
            name={b().name}
            args={parseDraftArgs(b())}
            partial={b().args}
            state="queued"
          />
        )}
      </Match>
    </Switch>
  );
}

function Draft(props: { chat: Chat; draft: StepDraft }) {
  return (
    <div class="assistant draft" aria-live="polite" aria-busy="true">
      <Index each={props.draft.blocks}>
        {(block, index) => <Show when={block()}>{(b) => <DraftBlockView chat={props.chat} block={b()} stepId={props.draft.stepId} index={index} />}</Show>}
      </Index>
      <Show when={props.draft.error}>
        <div class="callout callout-error">
          <AlertIcon />
          <span>{props.draft.error}</span>
        </div>
      </Show>
    </div>
  );
}

/** The chat transcript for the active session. */
function Transcript(props: { chat: Chat; turns: readonly TurnView[] }) {
  const { threads, pending } = props.chat;
  const drafts = () => threads.live().drafts;
  const working = () => threads.busy() && drafts().every((draft) => draft.finished) && pending().size === 0;
  const turnStarted = () => {
    const last = props.turns.at(-1);
    return last !== undefined && last.end === undefined ? last.startedAt : undefined;
  };
  return (
    <div class="transcript">
      <Index each={props.turns}>{(turn) => <Turn chat={props.chat} turn={turn()} />}</Index>
      <Index each={drafts()}>{(draft) => <Draft chat={props.chat} draft={draft()} />}</Index>
      <Show when={working()}>
        <ChatWorking startedAt={turnStarted()} now={props.chat.now()} />
      </Show>
    </div>
  );
}

function ChatView(props: { chat: Chat; turns: () => readonly TurnView[] }) {
  const threads = props.chat.threads;
  let view!: HTMLDivElement;
  let scroller!: HTMLDivElement;
  let content!: HTMLDivElement;
  const [stuck, setStuck] = createSignal(true);
  const marks = createMemo(() => promptMarks(props.turns()));
  const [current, setCurrent] = createSignal(0);
  const [steps, setSteps] = createSignal<{ previous: number | undefined; next: number | undefined }>(
    { previous: undefined, next: undefined },
    { equals: (a, b) => a.previous === b.previous && a.next === b.next },
  );
  const [seen, setSeen] = createSignal<{ first: number; last: number } | undefined>(undefined, {
    equals: (a, b) => a?.first === b?.first && a?.last === b?.last,
  });
  /** The space beside the transcript's text, where the prompt rail goes. */
  const [room, setRoom] = createSignal(0);
  /** How far the pane reaches below the chat view (the composer), so the prompt rail can center on the whole pane. */
  const [below, setBelow] = createSignal(0);
  const turnElement = (key: string) => content.querySelector<HTMLElement>(`[data-turn="${CSS.escape(key)}"]`);
  /** Where a jump is taking the view, until the scroll gets there or the reader takes it elsewhere. */
  let heading: number | undefined;
  /**
   * Which prompts' turns are in view (a turn runs to the next prompt, the last
   * to the end); the one being read: the last whose turn starts above the top
   * third of the view, or the last one at the bottom; and the nearest turns
   * starting above and below where the view is (or is going), for stepping.
   */
  const locate = () => {
    const turns = new Map<string | undefined, number>();
    for (const element of content.querySelectorAll<HTMLElement>("[data-turn]")) turns.set(element.dataset.turn, element.offsetTop);
    const found = locatePrompts(
      marks().map((mark) => turns.get(mark.key)),
      { top: scroller.scrollTop, height: scroller.clientHeight, scrollHeight: scroller.scrollHeight },
      heading,
    );
    setCurrent(found.current);
    setSeen(found.seen);
    setSteps({ previous: found.previous, next: found.next });
  };
  let locating = 0;
  const locateSoon = () => {
    cancelAnimationFrame(locating);
    locating = requestAnimationFrame(locate);
  };
  const jump = (key: string) => {
    const element = turnElement(key);
    if (element === null) return;
    const target = Math.min(Math.max(0, element.offsetTop - JUMP_MARGIN), scroller.scrollHeight - scroller.clientHeight);
    heading = Math.abs(target - scroller.scrollTop) < 2 ? undefined : target;
    scroller.scrollTo({ top: target, behavior: "smooth" });
    locate();
  };
  const toBottom = (smooth = false) => scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  let lastTop = 0;
  /** Where the reader was in this history entry (back or forward returns there), or undefined at the bottom. */
  const remembered = () => props.chat.router.entry<number | undefined>(SCROLL_STATE);
  /** A position to return to once the transcript is tall enough to hold it. */
  let restoring: number | undefined;
  /** `settled`: the log is loaded and drawn, so a position still out of reach (a taller or wider window) is as near as it gets. */
  const restore = (settled = false) => {
    const reach = scroller.scrollHeight - scroller.clientHeight;
    if (restoring === undefined || (!settled && reach < restoring)) return;
    scroller.scrollTop = lastTop = Math.min(restoring, reach);
    restoring = undefined;
    setStuck(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80);
  };
  let saving = 0;
  const onScroll = () => {
    // Stop following only when the reader scrolls up: output that grows faster than it is followed moves the bottom away too.
    const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
    if (nearBottom) setStuck(true);
    else if (scroller.scrollTop < lastTop) setStuck(false);
    if (heading !== undefined && jumpOver(heading, scroller.scrollTop, lastTop)) heading = undefined;
    lastTop = scroller.scrollTop;
    locateSoon();
    if (restoring !== undefined) return;
    cancelAnimationFrame(saving);
    saving = requestAnimationFrame(() => remembered().set(stuck() ? undefined : scroller.scrollTop));
  };

  /** A disclosure the reader just opened or closed: it stays where it was on screen rather than the view jumping to the bottom. */
  let anchor: { readonly element: Element; readonly top: number } | undefined;
  const noteToggle = (event: MouseEvent) => {
    const button = (event.target as Element | null)?.closest?.("button[aria-expanded]");
    if (button === null || button === undefined) return;
    anchor = { element: button, top: button.getBoundingClientRect().top };
    // A toggle that changes no size leaves nothing to hold.
    requestAnimationFrame(() => requestAnimationFrame(() => (anchor = undefined)));
  };

  onMount(() => {
    // The text moves with the view's width and with the content's (the width setting, the narrow layout's padding).
    const measure = new ResizeObserver(() => setRoom(content.offsetLeft + parseFloat(getComputedStyle(content).paddingLeft)));
    measure.observe(scroller);
    measure.observe(content);
    onCleanup(() => measure.disconnect());
    // The pane is the box the view is laid out in; the composer below it grows as the reader types.
    const pane = view.offsetParent as HTMLElement | null;
    if (pane !== null) {
      const height = new ResizeObserver(() => setBelow(Math.max(0, pane.clientHeight - view.offsetTop - view.offsetHeight)));
      height.observe(view);
      height.observe(pane);
      onCleanup(() => height.disconnect());
    }
    // Follow new output while the reader is at the bottom; leave them alone once they scroll up.
    const observer = new ResizeObserver(() => {
      const held = anchor;
      anchor = undefined;
      if (held !== undefined && held.element.isConnected) {
        scroller.scrollTop += held.element.getBoundingClientRect().top - held.top;
        lastTop = scroller.scrollTop;
        setStuck(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80);
      } else if (restoring !== undefined) restore();
      else if (stuck()) toBottom();
      locateSoon();
    });
    observer.observe(content);
    // Capture: the toggle's own handler changes the DOM before a bubbling listener would see the click.
    content.addEventListener("click", noteToggle, true);
    onCleanup(() => {
      observer.disconnect();
      content.removeEventListener("click", noteToggle, true);
      cancelAnimationFrame(locating);
      cancelAnimationFrame(saving);
    });
  });
  createEffect(
    on(threads.activeId, () => {
      heading = undefined;
      restoring = untrack(() => remembered().get());
      setStuck(restoring === undefined);
      queueMicrotask(() => (restoring === undefined ? toBottom() : restore()));
    }),
  );
  let settling = 0;
  createEffect(() => {
    cancelAnimationFrame(settling);
    if (!threads.log().loaded) return;
    // Two frames: the loaded transcript is laid out (and the resize observer has had its turn) before the wait ends.
    settling = requestAnimationFrame(() => (settling = requestAnimationFrame(() => restore(true))));
  });
  onCleanup(() => cancelAnimationFrame(settling));

  const empty = () => props.turns().length === 0;
  return (
    <div class="chat-view" ref={view}>
      <div class="scroller" ref={scroller} onScroll={onScroll}>
        <div class="content" ref={content}>
          <Switch>
            <Match when={threads.activeId() !== undefined && !threads.log().loaded}>
              <div class="loading">
                <Spinner /> Loading session…
              </div>
            </Match>
            <Match when={empty() && !threads.busy()}>
              <div class="empty-state">
                <h2>{threads.activeId() === undefined ? "What are we working on?" : "This session is empty"}</h2>
                <p class="muted">The agent can read, edit, and run commands in the project below.</p>
              </div>
            </Match>
          </Switch>
          <Transcript chat={props.chat} turns={props.turns()} />
          <Show when={threads.log().error}>
            <div class="callout callout-error">Could not load the full session: {threads.log().error}</div>
          </Show>
        </div>
        <Show when={!stuck()}>
          <button
            class="jump"
            aria-label="Jump to latest"
            onClick={() => {
              setStuck(true);
              toBottom(true);
            }}
          >
            <ChevronDownIcon />
          </button>
        </Show>
      </div>
      <Show when={props.chat.config.promptRail && marks().length > 1}>
        <PromptRail
          marks={marks()}
          current={current()}
          previous={steps().previous}
          next={steps().next}
          seen={seen()}
          room={room()}
          below={below()}
          onJump={jump}
        />
      </Show>
    </div>
  );
}

/**
 * The session as a conversation, projected from its log. Tool calls render
 * through the `chat.tools` slot when a plugin fills it for that tool.
 */
export default defineUiPlugin({
  id: "chat",
  styles,
  config: ChatConfig,
  requires: { client: Client, threads: Threads, router: Router, slots: Slots },
  setup: ({ client, threads, router, slots }, plugin) => {
    // Expanded/collapsed choices survive re-renders and session switches while the plugin runs.
    const [expanded, setExpanded] = createSignal<ReadonlyMap<string, boolean>>(new Map());
    let projector = createProjector();
    let projectedFor: string | undefined;
    const transcript = createMemo(() => {
      if (projectedFor !== threads.activeId()) {
        projector = createProjector();
        projectedFor = threads.activeId();
      }
      return projector(threads.branch());
    });
    const pending = createMemo(() => pendingToolCalls(transcript()));
    const now = createNow(1000, threads.busy);
    const chat: Chat = {
      threads,
      router,
      config: plugin.config,
      isOpen: (key, fallback) => expanded().get(key) ?? fallback,
      toggle: (key, fallback) => setExpanded((map) => new Map(map).set(key, !(map.get(key) ?? fallback))),
      pending,
      now,
    };
    // Its own parts' defaults; any plugin replaces one by adding with a lower order.
    const part = <P extends Record<string, any>>(slot: Part<P>, component: Component<P>) =>
      slots.add(slot, { id: `chat.${slot.name.slice("part.chat.".length)}`, order: DEFAULT_PART_ORDER, component });
    part(ChatUserPart, UserView);
    part(ChatThinkingPart, ThinkingView);
    part(ChatToolPart, toolView({ client, threads, slots }));
    part(ChatWorkPart, WorkView);
    part(ChatWorkingPart, WorkingView);
    part(ChatTurnFooterPart, TurnFooter);
    slots.add(Views, {
      id: "chat",
      title: "Chat",
      icon: ChatIcon,
      composer: true,
      component: () => <ChatView chat={chat} turns={() => transcript().turns} />,
    });
  },
});
