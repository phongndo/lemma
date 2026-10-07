import { For, Index, Match, Show, Switch, createEffect, createMemo, createSignal, on, onCleanup, onMount, untrack } from "solid-js";
import type { Component, JSX } from "solid-js";
import { formatDuration, formatTokens, parseModelRef } from "@lemma/contracts";
import type { TextContent } from "@lemma/contracts";
import { formatElapsed, summarizeUsage } from "../../model/format.ts";
import { answerText, entryKey, foldRunning, foldTurn } from "../../model/fold.ts";
import type { TurnEntry } from "../../model/fold.ts";
import { draftEntries, parseDraftArgs } from "../../model/live.ts";
import type { DraftBlock, StepDraft } from "../../model/live.ts";
import { errorView } from "../../model/error.ts";
import { thoughtHeadline } from "../../model/thought.ts";
import { workEntries } from "../../model/work.ts";
import type { WorkEntry, WorkRow } from "../../model/work.ts";
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
  ChatWorkGroupPart,
  ChatWorkPart,
  Client,
  Router,
  Threads,
  Slots,
  Views,
} from "../../ui/contracts.ts";
import type { ChatThinkingProps, ChatTurnFooterProps, ChatUserProps, ChatWorkGroupProps, ChatWorkingProps, ChatWorkProps } from "../../ui/contracts.ts";
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
  ChatWorkGroup,
  ChatWorking,
  ChevronDownIcon,
  ChevronIcon,
  BrainIcon,
  Icon,
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

/** The default `chat.thinking` part: one line, the thought's title (the latest while it is written), that opens to the thought as markdown. */
function ThinkingView(props: ChatThinkingProps) {
  const open = () => props.open;
  const headline = createMemo(() => thoughtHeadline(props.text, props.live === true));
  const empty = () => props.text.trim() === "";
  const label = () => headline() || (props.redacted ? "Reasoning hidden" : props.live ? "Thinking" : "Thought");
  return (
    <div class="thinking" classList={{ open: open(), live: props.live === true }}>
      <button class="row-head thinking-head" aria-expanded={open()} disabled={empty()} onClick={() => props.onToggle()}>
        <span class="row-icon">
          <BrainIcon />
        </span>
        <span class="row-label thinking-preview">{label()}</span>
        <Show when={!empty()}>
          <ChevronIcon class="chevron row-chevron" />
        </Show>
      </button>
      <Show when={open() && !empty()}>
        <Markdown text={props.text} class="thinking-body" streaming={props.live === true} />
      </Show>
    </div>
  );
}

/**
 * One block of a message. `scope` names its step (the attempt's own id for a
 * failed attempt), so a thought opened while it streamed stays open once
 * the message is logged.
 */
function BlockView(props: { chat: Chat; block: Block; scope: string; turnEnded: boolean }) {
  return (
    <Switch>
      <Match when={props.block.kind === "text" && props.block}>{(b) => <Markdown text={b().text} />}</Match>
      <Match when={props.block.kind === "thinking" && props.block}>
        {(b) => (
          <Show when={b().text.trim() || b().redacted}>
            <Thinking chat={props.chat} id={`${props.scope}:${b().index}`} text={b().text} redacted={b().redacted} />
          </Show>
        )}
      </Match>
      <Match when={props.block.kind === "tool" && props.block}>
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
  );
}

/** A message's blocks; see `BlockView`. */
function Blocks(props: { chat: Chat; blocks: readonly Block[]; scope: string; turnEnded: boolean }) {
  return <For each={props.blocks}>{(block) => <BlockView chat={props.chat} block={block} scope={props.scope} turnEnded={props.turnEnded} />}</For>;
}

/** An error in the transcript, read for a person (see `errorView`), with a button that copies what it shows. */
function ErrorNote(props: { message: string }) {
  const view = createMemo(() => errorView(props.message));
  return (
    <div class="callout callout-error chat-error">
      <AlertIcon />
      <div class="chat-error-text">
        <p class="chat-error-summary">{view().summary}</p>
        <Show when={view().description}>{(description) => <p>{description()}</p>}</Show>
        <Show when={view().hint}>{(hint) => <p>{hint()}</p>}</Show>
      </div>
      <CopyButton text={[view().summary, view().description, view().hint].filter((line) => line !== undefined).join("\n")} label="Copy error" />
    </div>
  );
}

function StopNote(props: { item: AssistantItem }) {
  return (
    <Switch>
      <Match when={props.item.message.stopReason === "error"}>
        <ErrorNote message={props.item.message.errorMessage ?? "The model request failed."} />
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
          <Blocks chat={props.chat} blocks={props.item.blocks} scope={props.item.id} turnEnded={true} />
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
            <Blocks chat={props.chat} blocks={item().blocks} scope={item().stepId ?? item().id} turnEnded={props.turnEnded} />
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
    <footer class="turn-footer">
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
      {/* Focusable, so the tokens in its tooltip reach a keyboard too; read out whole, and shown where nothing hovers. */}
      <span class="turn-usage" tabIndex={0} data-tip={usage().title}>
        <Show when={model()}>
          <span>{model()}</span>
        </Show>
        <Show when={props.turn.usage.totalTokens > 0}>
          <span class="turn-tokens" aria-hidden="true">
            ↑{usage().input} ↓{usage().output}
          </span>
        </Show>
        <Show when={usage().cost}>
          <span>{usage().cost}</span>
        </Show>
        <Show when={duration() !== undefined}>
          <span>{formatDuration(duration()!)}</span>
        </Show>
        <span class="sr-only">{usage().title}</span>
      </span>
    </footer>
  );
}

/** A row of folded work: a block on its own, or an item whole. */
function WorkRowView(props: { chat: Chat; row: WorkRow; turnEnded: boolean }) {
  return (
    <Show
      when={props.row.kind === "block" && props.row}
      fallback={<ItemView chat={props.chat} item={(props.row as Extract<WorkRow, { kind: "item" }>).item} turnEnded={props.turnEnded} note={false} />}
    >
      {(row) => <BlockView chat={props.chat} block={row().block} scope={row().scope} turnEnded={props.turnEnded} />}
    </Show>
  );
}

/** Entries keyed by their key, so what stays in view keeps its DOM as the turn runs on and the entries are made again. */
function Keyed<T extends { readonly key: string }>(props: { each: readonly T[]; children: (entry: () => T) => JSX.Element }) {
  const byKey = createMemo(() => new Map(props.each.map((entry) => [entry.key, entry])));
  return <For each={[...byKey().keys()]}>{(key) => <Show when={byKey().get(key)}>{(entry) => props.children(entry)}</Show>}</For>;
}

/**
 * Folded work, through the `chat.work` part: its rows, with calls made one
 * after another gathered under a `chat.work-group` line, and while the turn
 * runs, its streaming step at the end.
 */
function WorkFold(props: { chat: Chat; work: Extract<TurnEntry, { kind: "work" }>; drafts: readonly StepDraft[]; startedAt: number }) {
  const live = () => props.work.live === true;
  const entries = createMemo(() => workEntries(props.work.items));
  const duration = () => (live() ? Math.max(0, props.chat.now() - props.startedAt) : props.work.duration);
  return (
    <ChatWork
      steps={props.work.items.filter((item) => item.kind !== "user" && item.kind !== "compaction").length}
      tools={props.work.tools}
      failed={props.work.failed}
      duration={duration()}
      live={live()}
      open={props.chat.isOpen(props.work.key, live())}
      onToggle={() => props.chat.toggle(props.work.key, live())}
    >
      <Keyed each={entries()}>
        {(entry) => (
          <Show
            when={entry().kind === "group" && (entry() as Extract<WorkEntry, { kind: "group" }>)}
            fallback={<WorkRowView chat={props.chat} row={entry() as WorkRow} turnEnded={!live()} />}
          >
            {(group) => (
              <ChatWorkGroup
                summary={group().summary}
                tools={group().tools}
                failed={group().failed}
                at={group().at}
                open={props.chat.isOpen(group().key, props.chat.config.expandTools)}
                onToggle={() => props.chat.toggle(group().key, props.chat.config.expandTools)}
              >
                <Keyed each={group().rows}>{(row) => <WorkRowView chat={props.chat} row={row()} turnEnded={!live()} />}</Keyed>
              </ChatWorkGroup>
            )}
          </Show>
        )}
      </Keyed>
      <Index each={props.drafts}>{(draft) => <Draft chat={props.chat} draft={draft()} />}</Index>
    </ChatWork>
  );
}

/** The default `chat.work` part: a turn's work as one quiet line, "Working for 12s" while it runs and "Worked for 35s" after, that opens to the steps. */
function WorkView(props: ChatWorkProps) {
  const label = () => {
    const verb = props.live ? "Working" : "Worked";
    return props.duration === undefined ? verb : `${verb} for ${props.live ? formatElapsed(props.duration) : formatDuration(props.duration)}`;
  };
  return (
    <div class="work" classList={{ open: props.open, live: props.live === true }}>
      <button class="work-head" aria-expanded={props.open} onClick={() => props.onToggle()}>
        <span class="work-label">{label()}</span>
        <Show when={props.failed > 0}>
          <span class="work-failed">{props.failed} failed</span>
        </Show>
        <ChevronIcon class="chevron" />
      </button>
      <Show when={props.open}>
        <div class="work-body">{props.children}</div>
      </Show>
    </div>
  );
}

/** The default `chat.work-group` part: calls made one after another as one line, what they did, that opens to them. */
function WorkGroupView(props: ChatWorkGroupProps) {
  const commands = () => props.tools.every((name) => name === "bash");
  return (
    <div class="work-group" classList={{ open: props.open }}>
      <button class="row-head work-group-head" aria-expanded={props.open} onClick={() => props.onToggle()}>
        <span class="row-icon">
          <Icon name={commands() ? "terminal" : "hammer"} />
        </span>
        <span class="row-label">{props.summary}</span>
        <Show when={props.failed > 0}>
          <span class="work-failed">{props.failed} failed</span>
        </Show>
        <span class="row-time">{new Date(props.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
        <ChevronIcon class="chevron row-chevron" />
      </button>
      <Show when={props.open}>
        <div class="work-group-body">{props.children}</div>
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

/** A turn; `running` when it is the one the session is running now, whose live fold shows its streaming steps (`drafts`). */
function Turn(props: { chat: Chat; turn: TurnView; running: boolean; drafts: readonly StepDraft[] }) {
  const ended = () => props.turn.end !== undefined;
  /** The last model call's error, which its stop note already shows. */
  const lastError = () => {
    const last = [...props.turn.items].reverse().find((item): item is AssistantItem => item.kind === "assistant");
    return last?.message.stopReason === "error" ? last.message.errorMessage : undefined;
  };
  const folded = createMemo(() => (props.chat.config.foldWork ? (foldTurn(props.turn) ?? (props.running ? foldRunning(props.turn) : undefined)) : undefined));
  // A fold makes new entries each time the turn changes: keyed by entry key, what stays in view stays mounted.
  const keyed = createMemo(() => (folded() ?? []).map((entry) => ({ key: entryKey(entry), entry })));
  return (
    <section class="turn" data-turn={props.turn.key}>
      <Show when={folded()} fallback={<For each={props.turn.items}>{(item) => <ItemView chat={props.chat} item={item} turnEnded={ended()} />}</For>}>
        <Keyed each={keyed()}>
          {(keyedEntry) => {
            const entry = () => keyedEntry().entry;
            return entry().kind === "work" ? (
              <WorkFold chat={props.chat} work={entry() as Extract<TurnEntry, { kind: "work" }>} drafts={props.drafts} startedAt={props.turn.startedAt} />
            ) : (
              <ItemView
                chat={props.chat}
                item={(entry() as Extract<TurnEntry, { kind: "item" }>).item}
                turnEnded={ended()}
                note={(entry() as Extract<TurnEntry, { kind: "item" }>).note}
              />
            );
          }}
        </Keyed>
      </Show>
      <Show when={props.turn.end?.reason === "error" && props.turn.end.error !== lastError() && props.turn.end.error}>
        {(error) => <ErrorNote message={error()} />}
      </Show>
      <Show when={ended()}>
        <ChatTurnFooter turn={props.turn} answer={answerText(props.turn)} />
      </Show>
    </section>
  );
}

function DraftBlockView(props: { chat: Chat; block: DraftBlock; stepId: string; index: number; live: boolean }) {
  return (
    <Switch>
      <Match when={props.block.kind === "text" && props.block}>{(b) => <Markdown text={b().text} streaming />}</Match>
      <Match when={props.block.kind === "thinking" && props.block}>
        {(b) => <Thinking chat={props.chat} id={`${props.stepId}:${props.index}`} text={b().text} live={props.live} />}
      </Match>
      <Match when={props.block.kind === "tool" && props.block}>
        {(b) => (
          <ToolCard
            chat={props.chat}
            id={b().id || `${props.stepId}:${props.index}`}
            before={`${props.stepId}:${props.index}`}
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
      <Index each={draftEntries(props.draft)}>
        {(entry) => <DraftBlockView chat={props.chat} block={entry().block} stepId={props.draft.stepId} index={entry().index} live={entry().live} />}
      </Index>
      <Show when={props.draft.error}>{(error) => <ErrorNote message={error()} />}</Show>
    </div>
  );
}

/** The chat transcript for the active session. */
function Transcript(props: { chat: Chat; turns: readonly TurnView[] }) {
  const { threads } = props.chat;
  const drafts = () => threads.live().drafts;
  /** The turn the session is running now: the last, while the session is busy and the turn has not ended. */
  const running = () => {
    const last = props.turns.at(-1);
    return threads.busy() && last !== undefined && last.end === undefined ? last : undefined;
  };
  /** The running turn's id, when its live fold shows its streaming steps and how long it has run. */
  const folding = () => (props.chat.config.foldWork ? running()?.turnId : undefined);
  const draftsOf = (turn: TurnView) => (turn.turnId === undefined || turn.turnId !== folding() ? [] : drafts().filter((draft) => draft.turnId === turn.turnId));
  const loose = () => drafts().filter((draft) => draft.turnId !== folding());
  // Shown for the whole turn, not only between steps (a line that came and went with each step made the transcript jump), unless its live fold says it.
  const working = () => threads.busy() && folding() === undefined;
  const turnStarted = () => {
    const last = props.turns.at(-1);
    return last !== undefined && last.end === undefined ? last.startedAt : undefined;
  };
  return (
    <div class="transcript">
      <Index each={props.turns}>{(turn) => <Turn chat={props.chat} turn={turn()} running={turn() === running()} drafts={draftsOf(turn())} />}</Index>
      <Index each={loose()}>{(draft) => <Draft chat={props.chat} draft={draft()} />}</Index>
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
    // A call's start, kept across its streamed and logged rows so its timer does not restart when the message lands.
    const firstSeen = new Map<string, number>();
    const chat: Chat = {
      threads,
      router,
      config: plugin.config,
      isOpen: (key, fallback) => expanded().get(key) ?? fallback,
      toggle: (key, fallback) => setExpanded((map) => new Map(map).set(key, !(map.get(key) ?? fallback))),
      pending,
      seen: (id, before) => {
        let at = firstSeen.get(id) ?? (before === undefined ? undefined : firstSeen.get(before));
        if (at === undefined) at = Date.now();
        firstSeen.set(id, at);
        return at;
      },
      now,
    };
    // Its own parts' defaults; any plugin replaces one by adding with a lower order.
    const part = <P extends Record<string, any>>(slot: Part<P>, component: Component<P>) =>
      slots.add(slot, { id: `chat.${slot.name.slice("part.chat.".length)}`, order: DEFAULT_PART_ORDER, component });
    part(ChatUserPart, UserView);
    part(ChatThinkingPart, ThinkingView);
    part(ChatToolPart, toolView({ client, threads, slots }));
    part(ChatWorkPart, WorkView);
    part(ChatWorkGroupPart, WorkGroupView);
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
