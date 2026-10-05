import { For, Index, Match, Show, Switch, createEffect, createMemo, createSignal, on, onCleanup, onMount, untrack } from "solid-js";
import type { Component, JSX } from "solid-js";
import { Dynamic } from "solid-js/web";
import { Schema } from "effect";
import type { ImageContent, TextContent } from "@lemma/contracts";
import { diffStats, parseDiff, readDetails } from "../model/details.ts";
import { formatDuration, formatTokens, summarizeToolArgs, summarizePartialArgs, summarizeUsage, truncateLines } from "../model/format.ts";
import { answerText, entryKey, foldRunning, foldTurn } from "../model/fold.ts";
import type { TurnEntry } from "../model/fold.ts";
import { parseDraftArgs } from "../model/live.ts";
import type { DraftBlock, StepDraft } from "../model/live.ts";
import { createProjector, pendingToolCalls, promptMarks } from "../model/transcript.ts";
import type { AssistantItem, AttemptItem, Block, Item, PromptMark, ToolResultView, TurnView } from "../model/transcript.ts";
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
  ToolViews,
  Views,
} from "../ui/contracts.ts";
import type {
  ChatThinkingProps,
  ChatToolProps,
  ChatTurnFooterProps,
  ChatUserProps,
  ChatWorkingProps,
  ChatWorkProps,
  ClientService,
  RouterService,
  ThreadsService,
} from "../ui/contracts.ts";
import { defineUiPlugin } from "../ui/define.ts";
import { DEFAULT_PART_ORDER } from "../ui/slots.ts";
import type { Part, SlotsService } from "../ui/slots.ts";
import {
  AlertIcon,
  ChatIcon,
  ChatThinking,
  ChatTool,
  ChatTurnFooter,
  ChatUser,
  ChatWork,
  ChatWorking,
  CheckIcon,
  ChevronDownIcon,
  ChevronIcon,
  CopyIcon,
  FileTypeIcon,
  Markdown,
  Spinner,
  XIcon,
} from "../ui/parts.tsx";
import { copyText } from "../lib/clipboard.ts";
import { markdownText } from "../lib/markdown.ts";
import styles from "./chat.css?inline";

export const ChatConfig = Schema.Struct({
  expandTools: Schema.optionalWith(Schema.Boolean, { default: () => false }).annotations({
    title: "Open tool calls",
    description: "Show every tool call's arguments and output instead of one quiet line.",
  }),
  foldWork: Schema.optionalWith(Schema.Boolean, { default: () => true }).annotations({
    title: "Fold finished work",
    description: "Once a turn ends, fold its thinking and tool calls into one line above the answer.",
  }),
  promptRail: Schema.optionalWith(Schema.Boolean, { default: () => true }).annotations({
    title: "Prompt rail",
    description:
      "Mark each of your prompts beside the chat, when there is room for them and a mouse or trackpad: point at one to preview it, click to go to it.",
  }),
});

interface Chat {
  readonly client: ClientService;
  readonly threads: ThreadsService;
  readonly router: RouterService;
  readonly slots: SlotsService;
  readonly config: typeof ChatConfig.Type;
  readonly isOpen: (key: string, fallback: boolean) => boolean;
  readonly toggle: (key: string, fallback: boolean) => void;
  readonly pending: () => ReadonlySet<string>;
  /** The time, ticking each second while a turn runs, for elapsed-time labels. */
  readonly now: () => number;
}

/** The chat's scroll position, kept with each history entry. */
const SCROLL_STATE = "chat.scroll";

const imageSrc = (image: ImageContent) => `data:${image.mimeType};base64,${image.data}`;

function Images(props: { content: readonly (TextContent | ImageContent)[] }) {
  const images = () => props.content.filter((part): part is ImageContent => part.type === "image");
  return (
    <Show when={images().length > 0}>
      <div class="images">
        <For each={images()}>{(image) => <img src={imageSrc(image)} alt="Attached image" loading="lazy" />}</For>
      </div>
    </Show>
  );
}

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

function Output(props: { id: string; text: string; error?: boolean; lines?: number }) {
  const max = () => props.lines ?? 14;
  const [all, setAll] = createSignal(false);
  const cut = createMemo(() => truncateLines(props.text.replace(/\n+$/, ""), max()));
  return (
    <div class="output" classList={{ error: props.error === true }}>
      <pre>{all() ? props.text.replace(/\n+$/, "") : cut().text}</pre>
      <Show when={cut().hidden > 0}>
        <button class="link-button output-more" aria-expanded={all()} onClick={() => setAll(!all())}>
          <ChevronDownIcon />
          {all() ? "Fewer lines" : `${cut().hidden} more lines`}
        </button>
      </Show>
    </div>
  );
}

function Diff(props: { diff: string }) {
  const lines = createMemo(() => parseDiff(props.diff));
  return (
    <pre class="diff">
      <For each={lines()}>
        {(line) => (
          <span class={`diff-${line.kind}`}>
            {line.text}
            {"\n"}
          </span>
        )}
      </For>
    </pre>
  );
}

/** Whole seconds, then minutes: a label that ticks without jumping in width every tenth. */
const formatElapsed = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
};

/** Lines of a running tool's output shown under it. */
const LIVE_LINES = 6;

type ToolState = "running" | "queued" | "ok" | "error" | "interrupted";

/** A tool call, through the `chat.tool` part, with the chat's open state, its live output, and how long it has run. */
function ToolCard(props: {
  chat: Chat;
  id: string;
  name: string;
  args: Record<string, unknown> | undefined;
  partial?: string;
  result?: ToolResultView | undefined;
  state: ToolState;
}) {
  // Every call starts as one quiet line unless configured otherwise.
  const defaultOpen = () => props.chat.config.expandTools;
  /** The last lines a running tool printed; its result replaces them. */
  const output = createMemo(() => {
    const text = props.chat.threads.live().output.get(props.id)?.replace(/\n+$/, "");
    return text === undefined || text === "" ? undefined : text.split("\n").slice(-LIVE_LINES).join("\n");
  });
  // Measured from when the call appeared here: close enough to show that a slow command is still going.
  const shownAt = Date.now();
  const running = () => props.state === "running";
  return (
    <ChatTool
      id={props.id}
      name={props.name}
      args={props.args}
      partial={props.partial}
      result={props.result}
      state={props.state}
      output={running() ? output() : undefined}
      elapsed={running() ? props.chat.now() - shownAt : undefined}
      open={props.chat.isOpen(props.id, defaultOpen())}
      onToggle={() => props.chat.toggle(props.id, defaultOpen())}
    />
  );
}

/**
 * The default `chat.tool` part: one quiet line (status, name, summary,
 * diffstat, time) that opens to the tool's `ToolViews` body, else the chat's.
 */
const toolView = (deps: { readonly client: ClientService; readonly threads: ThreadsService; readonly slots: SlotsService }) =>
  function ToolView(props: ChatToolProps) {
    const { client, threads, slots } = deps;
    const context = () => {
      const info = client.info();
      return info === undefined ? {} : { cwd: threads.active()?.cwd ?? info.cwd, home: info.home };
    };
    /** A plugin's view of this tool, when one fills the slot for it. */
    const custom = () => slots.get(ToolViews, props.name);
    const details = createMemo(() => readDetails(props.result?.details));
    const summary = createMemo(() => custom()?.summary?.(props.args, context()) ?? summarizeToolArgs(props.name, props.args, context()));
    const primary = () => summary().primary ?? (props.partial === undefined ? undefined : summarizePartialArgs(props.name, props.partial));
    const outputText = () =>
      props.result?.content
        .filter((part): part is TextContent => part.type === "text")
        .map((part) => part.text)
        .join("\n") ?? "";
    const diff = () => details().diff;
    const stats = createMemo(() => {
      const d = diff();
      return d === undefined ? undefined : diffStats(parseDiff(d));
    });
    const open = () => props.open;
    const argsShown = () => summary().primary === undefined && props.args !== undefined && Object.keys(props.args).length > 0;
    const duration = () => {
      const t = props.result?.timing;
      return t === undefined ? undefined : t.endedAt - t.startedAt;
    };
    return (
      <div class={`tool tool-${props.state}`} classList={{ open: open() }}>
        <button class="tool-head" aria-expanded={open()} onClick={() => props.onToggle()}>
          <ChevronIcon class="chevron" />
          <span class="tool-status">
            <Switch>
              <Match when={props.state === "running"}>
                <Spinner />
              </Match>
              <Match when={props.state === "queued"}>
                <span class="dot-muted" />
              </Match>
              <Match when={props.state === "ok"}>
                <CheckIcon />
              </Match>
              <Match when={props.state === "error"}>
                <XIcon />
              </Match>
              <Match when={props.state === "interrupted"}>
                <span class="dot-muted" />
              </Match>
            </Switch>
          </span>
          <span class="tool-name" classList={{ titled: summary().title !== undefined }} data-tip={summary().title === undefined ? undefined : props.name}>
            {summary().title ?? (props.name || "tool")}
          </span>
          <Show when={summary().file}>{(file) => <FileTypeIcon path={file().path} kind={file().kind} class="tool-file" />}</Show>
          <Show when={primary()}>
            <span class="tool-primary" classList={{ shell: summary().shell === true || props.name === "bash" }}>
              {primary()}
            </span>
          </Show>
          <Show when={summary().secondary}>
            <span class="tool-secondary">{summary().secondary}</span>
          </Show>
          <span class="tool-meta">
            <Show when={stats()}>
              {(s) => (
                <span class="diffstat">
                  <span class="add">+{s().added}</span> <span class="del">−{s().removed}</span>
                </span>
              )}
            </Show>
            <Show when={details().exitCode !== undefined && details().exitCode !== 0}>
              <span class="badge badge-error">exit {details().exitCode}</span>
            </Show>
            <Show when={props.state === "interrupted"}>
              <span class="badge">no result</span>
            </Show>
            <Show when={duration() !== undefined && duration()! >= 1000}>
              <span class="muted">{formatDuration(duration()!)}</span>
            </Show>
            <Show when={props.elapsed !== undefined && props.elapsed >= 1000}>
              <span class="muted">{formatElapsed(props.elapsed!)}</span>
            </Show>
          </span>
        </button>
        <Show when={props.output}>{(text) => <pre class="tool-live">{text()}</pre>}</Show>
        <Show when={open()}>
          <Show
            when={custom()?.body}
            keyed
            fallback={
              <DefaultBody
                id={props.id}
                args={props.args}
                result={props.result}
                state={props.state}
                argsShown={argsShown()}
                diff={diff()}
                outputText={outputText()}
                details={details()}
              />
            }
          >
            {(body) => (
              <Dynamic component={body} id={props.id} name={props.name} args={props.args} result={props.result} state={props.state} output={props.output} />
            )}
          </Show>
        </Show>
      </div>
    );
  };

function DefaultBody(props: {
  id: string;
  args: Record<string, unknown> | undefined;
  result?: ToolResultView | undefined;
  state: ToolState;
  argsShown: boolean;
  diff: string | undefined;
  outputText: string;
  details: ReturnType<typeof readDetails>;
}) {
  const argsShown = () => props.argsShown;
  const diff = () => props.diff;
  const outputText = () => props.outputText;
  const details = () => props.details;
  return (
    <div class="tool-body">
      <Show when={argsShown()}>
        <pre class="tool-args">{JSON.stringify(props.args, null, 2)}</pre>
      </Show>
      <Show when={diff()}>{(d) => <Diff diff={d()} />}</Show>
      <Show when={outputText() && !(diff() !== undefined && props.state === "ok")}>
        <Output id={props.id} text={outputText()} error={props.state === "error"} />
      </Show>
      <Show when={props.result}>{(result) => <Images content={result().content} />}</Show>
      <Show when={details().truncated}>
        <p class="muted small">Output truncated{details().fullOutputPath ? ` — full output in ${details().fullOutputPath}` : ""}</p>
      </Show>
      <Show when={props.state === "ok" && !outputText() && diff() === undefined && !props.result?.content.some((part) => part.type === "image")}>
        <p class="muted small">No output</p>
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
  const model = () => props.turn.models.map((ref) => ref.slice(ref.indexOf("/") + 1)).join(", ");
  const reason = () => props.turn.end?.reason;
  const answer = () => props.answer;
  const [copied, setCopied] = createSignal<boolean>();
  const copy = () =>
    void copyText(answer()).then((ok) => {
      setCopied(ok);
      setTimeout(() => setCopied(undefined), 1500);
    });
  return (
    <footer class="turn-footer" data-tip={usage().title}>
      <Show when={answer()}>
        <button
          class="icon-button turn-copy"
          aria-label="Copy response"
          data-tip={copied() === undefined ? "Copy response" : copied() ? "Copied" : "Copy failed"}
          onClick={copy}
        >
          {copied() === undefined ? <CopyIcon /> : copied() ? <CheckIcon /> : <XIcon />}
        </button>
      </Show>
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

/** A finished turn's work behind its answer, as one line: how long it took and how many tool calls; opening it shows them. */
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

/** The default `chat.work` part: one quiet line that opens to the steps. */
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

/** With less space than this beside the transcript's text, the prompt rail shows only while pointed at or focused. */
const RAIL_ROOM = 48;
/** A tick's length by how far it is from the one pointed at, then the length of the rest. */
const TICK_SCALES = [1, 0.667, 0.417];
const TICK_SCALE_REST = 0.333;
/** How much of an answer the card reads: more than its three lines hold. */
const PREVIEW_SOURCE = 2000;
/** The card keeps this far inside the chat view. */
const CARD_INSET = 8;
/** A jump to a turn stops this far above its start. */
const JUMP_MARGIN = 8;

/**
 * A tick per prompt along the chat's left edge, evenly spaced and squeezed
 * together when there are too many to fit. Pointing anywhere on the strip
 * picks the nearest tick and previews its prompt and answer in a card level
 * with it; clicking goes there. Each tick is also a button: one tab stop, the
 * arrow keys, Home, and End move between them. The ticks of the turns in view
 * are lit. The strip keeps to the space beside the transcript's text
 * (`--room`), so it never covers what the reader is selecting, and sits level
 * with the middle of the whole pane, the composer below the chat included
 * (`--below`), as far as the chat view leaves room.
 */
function PromptRail(props: {
  marks: readonly PromptMark[];
  /** The index of the prompt being read. */
  current: number;
  /** Where the previous and next buttons go. */
  previous: number | undefined;
  next: number | undefined;
  /** The indices of the first and last prompts whose turns are in view. */
  seen: { readonly first: number; readonly last: number } | undefined;
  /** The space between the chat's left edge and the transcript's text, in pixels. */
  room: number;
  /** How far the pane the chat is in reaches below the chat view (its composer), in pixels. */
  below: number;
  onJump: (key: string) => void;
}) {
  let rail!: HTMLElement;
  let strip!: HTMLDivElement;
  let card: HTMLDivElement | undefined;
  const ticks: HTMLButtonElement[] = [];
  const count = () => props.marks.length;
  const [hovered, setHovered] = createSignal<number>();
  const [focused, setFocused] = createSignal<number>();
  /** The prompt the card shows: the one pointed at, else the one focused. */
  const active = () => {
    const index = hovered() ?? focused();
    return index !== undefined && index < count() ? index : undefined;
  };
  const shown = createMemo(() => {
    const index = active();
    if (index === undefined) return undefined;
    const mark = props.marks[index]!;
    return { index, prompt: mark.prompt, reply: markdownText(mark.reply.slice(0, PREVIEW_SOURCE)) };
  });
  const at = (index: number) => (count() < 2 ? 0 : (index / (count() - 1)) * 100);
  const scale = (index: number) => {
    const pointer = active();
    return pointer === undefined ? TICK_SCALE_REST : (TICK_SCALES[Math.abs(index - pointer)] ?? TICK_SCALE_REST);
  };
  /** The tick nearest the pointer's height on the strip. */
  const fromPointer = (event: MouseEvent) => {
    const box = strip.getBoundingClientRect();
    const progress = box.height <= 0 ? 0 : Math.max(0, Math.min(1, (event.clientY - box.top) / box.height));
    return Math.round(progress * (count() - 1));
  };
  const jump = (index: number | undefined) => {
    const mark = index === undefined ? undefined : props.marks[index];
    if (mark !== undefined) props.onJump(mark.key);
  };
  /** The tick the tab key reaches: the focused one, else the current prompt's. */
  const stop = () => focused() ?? Math.min(props.current, count() - 1);
  const onKeyDown = (event: KeyboardEvent, index: number) => {
    // With a modifier it is an app shortcut, not a move along the rail.
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const keys: Record<string, number> = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: count() - 1 };
    const to = keys[event.key];
    if (to === undefined) return;
    event.preventDefault();
    ticks[Math.max(0, Math.min(count() - 1, to))]?.focus();
  };
  // The card's middle is level with its tick unless that takes it out of the chat view, and it is no larger than the view leaves.
  createEffect(() => {
    const index = shown()?.index;
    if (index === undefined || card === undefined) return;
    const view = rail.getBoundingClientRect();
    const box = strip.getBoundingClientRect();
    card.style.maxWidth = `${Math.max(0, view.right - card.getBoundingClientRect().left - CARD_INSET)}px`;
    card.style.maxHeight = `${Math.max(0, view.height - 2 * CARD_INSET)}px`;
    const tick = box.top + (at(index) / 100) * box.height;
    const top = Math.max(view.top + CARD_INSET, Math.min(tick - card.offsetHeight / 2, view.bottom - card.offsetHeight - CARD_INSET));
    card.style.top = `${top - box.top}px`;
  });
  return (
    <nav
      class="prompt-rail"
      classList={{ tucked: props.room < RAIL_ROOM }}
      aria-label="Prompts"
      ref={rail}
      style={{ "--room": `${props.room}px`, "--below": `${props.below}px`, "--count": count() }}
    >
      <div class="prompt-strip" ref={strip}>
        <button class="prompt-step previous" aria-label="Previous prompt" disabled={props.previous === undefined} onClick={() => jump(props.previous)}>
          <ChevronIcon />
        </button>
        <div
          class="prompt-hit"
          aria-hidden="true"
          onMouseMove={(event) => setHovered(fromPointer(event))}
          onMouseLeave={() => setHovered(undefined)}
          // Going to a prompt leaves focus where the reader was typing.
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => jump(fromPointer(event))}
        />
        <div class="prompt-ticks">
          <Index each={props.marks}>
            {(mark, index) => (
              <button
                class="prompt-tick"
                classList={{ pointed: active() === index, seen: props.seen !== undefined && index >= props.seen.first && index <= props.seen.last }}
                style={{ top: `${at(index)}%`, "--scale": scale(index) }}
                ref={(element) => (ticks[index] = element)}
                tabIndex={stop() === index ? 0 : -1}
                aria-label={`Prompt ${index + 1} of ${count()}: ${mark().prompt}`}
                aria-current={index === props.current ? "location" : undefined}
                onFocus={() => setFocused(index)}
                onBlur={() => setFocused(undefined)}
                onKeyDown={(event) => onKeyDown(event, index)}
                onClick={() => jump(index)}
              />
            )}
          </Index>
        </div>
        <button class="prompt-step next" aria-label="Next prompt" disabled={props.next === undefined} onClick={() => jump(props.next)}>
          <ChevronIcon />
        </button>
        <Show when={shown()}>
          {(preview) => (
            <div class="prompt-card" ref={card} aria-hidden="true">
              <div class="prompt-card-prompt">{preview().prompt}</div>
              <Show when={preview().reply}>
                <div class="prompt-card-reply">{preview().reply}</div>
              </Show>
            </div>
          )}
        </Show>
      </div>
    </nav>
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
    const tops = marks().map((mark) => turns.get(mark.key));
    const top = scroller.scrollTop;
    const bottom = top + scroller.clientHeight;
    const line = top + scroller.clientHeight / 3;
    const from = heading ?? top;
    const atEnd = from >= scroller.scrollHeight - scroller.clientHeight - 1;
    let found: number | undefined;
    let first: number | undefined;
    let last: number | undefined;
    let previous: number | undefined;
    let next: number | undefined;
    let end = scroller.scrollHeight;
    for (let index = tops.length - 1; index >= 0; index--) {
      const start = tops[index];
      if (start === undefined) continue;
      if (start < bottom && end > top) {
        first = index;
        last ??= index;
      }
      if (found === undefined && start <= line) found = index;
      const target = Math.max(0, start - JUMP_MARGIN);
      if (previous === undefined && target < from - 1) previous = index;
      if (!atEnd && target > from + 1) next = index;
      end = start;
    }
    // At the bottom the last prompt is the one being read, however short its turn.
    setCurrent(scroller.scrollHeight - bottom < 2 ? Math.max(0, tops.length - 1) : (found ?? 0));
    setSeen(first === undefined || last === undefined ? undefined : { first, last });
    setSteps({ previous, next });
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
    if (heading !== undefined) {
      // The jump is over once the view gets there, passes it, or turns away from it.
      const left = heading - scroller.scrollTop;
      const before = heading - lastTop;
      if (Math.abs(left) < 2 || Math.sign(left) !== Math.sign(before) || Math.abs(left) > Math.abs(before)) heading = undefined;
    }
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
    const [now, setNow] = createSignal(Date.now());
    createEffect(() => {
      if (!threads.busy()) return;
      setNow(Date.now());
      const timer = setInterval(() => setNow(Date.now()), 1000);
      onCleanup(() => clearInterval(timer));
    });
    const chat: Chat = {
      client,
      threads,
      router,
      slots,
      config: plugin.config,
      isOpen: (key, fallback) => expanded().get(key) ?? fallback,
      toggle: (key, fallback) => setExpanded((map) => new Map(map).set(key, !(map.get(key) ?? fallback))),
      pending,
      now,
    };
    // Its own parts' defaults; any plugin replaces one by adding with a lower order.
    const part = <P extends Record<string, any>>(slot: Part<P>, component: Component<P>) =>
      plugin.onCleanup(slots.add(slot, { id: `chat.${slot.name.slice("part.chat.".length)}`, order: DEFAULT_PART_ORDER, component }));
    part(ChatUserPart, UserView);
    part(ChatThinkingPart, ThinkingView);
    part(ChatToolPart, toolView({ client, threads, slots }));
    part(ChatWorkPart, WorkView);
    part(ChatWorkingPart, WorkingView);
    part(ChatTurnFooterPart, TurnFooter);
    plugin.onCleanup(
      slots.add(Views, {
        id: "chat",
        title: "Chat",
        icon: ChatIcon,
        composer: true,
        component: () => <ChatView chat={chat} turns={() => transcript().turns} />,
      }),
    );
  },
});
