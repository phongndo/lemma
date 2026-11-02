import { For, Index, Match, Show, Switch, createMemo, createSignal } from "solid-js";
import type { Component, JSX } from "solid-js";
import { formatDuration, formatTokens } from "@lemma/client/format";
import { parseModelRef } from "@lemma/llm";
import type { TextContent } from "@lemma/llm";
import { formatElapsed, sentTime, summarizeUsage } from "./format.ts";
import {
  answerText,
  formatThroughput,
  throughput,
  entryKey,
  foldRunning,
  foldTurn,
  draftEntries,
  parseDraftArgs,
  createProjector,
  pendingToolCalls,
  markKey,
  queuePlaces,
  ChatThinkingPart,
  ChatToolPart,
  ChatTurnFooterPart,
  ChatUserPart,
  ChatWorkingPart,
  ChatWorkGroupPart,
  ChatWorkPart,
  ErrorActions,
  PromptActions,
  Threads,
  Views,
  ChatThinking,
  ChatTurnFooter,
  ChatUser,
  ChatWork,
  ChatWorkGroup,
  ChatWorking,
  ToolViews,
  ContextViews,
} from "@lemma/threads";
import type {
  TurnEntry,
  DraftBlock,
  StepDraft,
  AssistantItem,
  AttemptItem,
  Block,
  Item,
  TurnView,
  ChatThinkingProps,
  ChatTurnFooterProps,
  ChatUserProps,
  ChatWorkGroupProps,
  ChatWorkingProps,
  ChatWorkProps,
  QueuePlaces,
  PromptActionProps,
  PromptInfo,
  ThreadsService,
} from "@lemma/threads";
import { errorView } from "./error.ts";
import { thoughtHeadline, thoughtTitles } from "./thought.ts";
import { displayedCalls, displayEntries, workEntries } from "./work.ts";
import type { DisplayEntry, WorkEntry } from "./work.ts";
import { pendingMark } from "./prompt-rail.ts";
import { createNow } from "@lemma/web/now";
import { Client, Contained, Each, Notify, Router, Slots, WebPlugins, defineWebPlugin, usePlugin } from "@lemma/web";
import type { SlotsService, Part } from "@lemma/web";
import { AlertIcon, ChatIcon, ChevronIcon, BrainIcon, Icon, Markdown, RedoIcon, SearchIcon, CopyButton, XIcon } from "@lemma/look";
import { Actions } from "@lemma/actions";
import styles from "./chat.css?inline";
import { ChatConfig } from "./config.ts";
import type { Chat } from "./config.ts";
import { ChatView, promptAnchor } from "./chat-view.tsx";
import { addSettings } from "./settings.tsx";
import { Images, ToolCard, ToolDisplay, ToolDisplays, toolStateOf, toolView } from "./tools.tsx";

/** A prompt's text as written: its text parts, a blank line between them. */
const textOf = (content: ChatUserProps["content"]): string =>
  content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("\n\n");

/**
 * The default `chat.user` part: the prompt as sent, over a steer a quiet mark saying so, and under a placed one, while
 * the pointer is on it, when it was sent and its `PromptActions`.
 */
function UserView(props: ChatUserProps) {
  const text = () => textOf(props.content);
  return (
    <div class="user-prompt">
      <Show when={props.steer}>
        <div class="steer-mark" data-tip="Steered the running turn">
          <RedoIcon />
          Steer
        </div>
      </Show>
      <div class="user-message">
        <Show when={text()}>
          <div class="user-text">{text()}</div>
        </Show>
        <Images content={props.content} />
      </div>
      <Show when={props.prompt}>{(prompt) => <PromptFooter prompt={prompt()} />}</Show>
    </div>
  );
}

/** When a prompt was sent, its full date in the tooltip, then its `PromptActions`. */
function PromptFooter(props: { prompt: PromptInfo }) {
  // Read once: a label from before midnight stays "today"'s until the transcript draws it again.
  const time = createMemo(() => sentTime(props.prompt.at, Date.now()));
  return (
    <div class="prompt-footer">
      {/* Focusable, so its tooltip, the full date, reaches a keyboard too. */}
      <time class="prompt-time" dateTime={new Date(props.prompt.at).toISOString()} tabIndex={0} data-tip={time().full}>
        {time().label}
      </time>
      <div class="prompt-actions">
        <Each slot={PromptActions} props={{ prompt: props.prompt }} />
      </div>
    </div>
  );
}

/** The transcript's own `PromptActions` item: copies the prompt's text. */
function CopyPrompt(props: PromptActionProps) {
  const text = () => textOf(props.prompt.content);
  return (
    <Show when={text()}>
      <CopyButton text={text()} label="Copy prompt" />
    </Show>
  );
}

/** The transcript's own `PromptActions` item: copies the address of the thread opened at the prompt (`promptAnchor`). */
const copyLink = (threads: ThreadsService) =>
  function CopyLink(props: PromptActionProps) {
    const href = () => new URL(`${threads.href(props.prompt.sessionId)}#${promptAnchor(props.prompt.eventId)}`, window.location.href).href;
    return <CopyButton text={href()} label="Copy link to this prompt" icon="link" />;
  };

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

/**
 * The default `chat.thinking` part: one line, the thought's title (the latest while it is written), that opens to the
 * thought as markdown. A thought with no titles is named by its first line, which, once it is open, shows under it.
 */
function ThinkingView(props: ChatThinkingProps) {
  const open = () => props.open;
  // Its titles, read once per update of a thought being written: the headline and whether it has any both come from them.
  const titles = createMemo(() => thoughtTitles(props.text));
  const headline = createMemo(() => thoughtHeadline(props.text, props.live === true, titles()));
  const titled = () => titles().length > 0;
  const empty = () => props.text.trim() === "";
  const fallback = () => (props.redacted ? "Reasoning hidden" : props.live ? "Thinking" : "Thought");
  const label = () => (open() && !empty() && !titled() ? fallback() : headline() || fallback());
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
 * the message is logged. A tool call draws its view's `display` under its line
 * unless `displays` is false: inside a fold, which draws them after itself.
 */
function BlockView(props: { chat: Chat; block: Block; scope: string; turnEnded: boolean; displays?: boolean | undefined }) {
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
          const toolState = () => toolStateOf(b().result, !props.turnEnded && props.chat.threads.busy());
          return (
            <>
              <ToolCard chat={props.chat} id={b().call.id} name={b().call.name} args={b().call.arguments} result={b().result} state={toolState()} />
              <Show when={props.displays !== false}>
                <ToolDisplay chat={props.chat} id={b().call.id} name={b().call.name} args={b().call.arguments} result={b().result} state={toolState()} />
              </Show>
            </>
          );
        }}
      </Match>
    </Switch>
  );
}

/** A message's blocks; see `BlockView`. */
function Blocks(props: { chat: Chat; blocks: readonly Block[]; scope: string; turnEnded: boolean; displays?: boolean | undefined }) {
  return (
    <For each={props.blocks}>
      {(block) => <BlockView chat={props.chat} block={block} scope={props.scope} turnEnded={props.turnEnded} displays={props.displays} />}
    </For>
  );
}

/** A line of an error, what it quotes in backticks (a command to run) shown as code. */
function ErrorLine(props: { text: string; class?: string }) {
  // Split on a capture: the odd parts are what was quoted.
  const parts = () => props.text.split(/`([^`]+)`/);
  return (
    <p class={props.class}>
      <For each={parts()}>{(part, index) => (index() % 2 === 1 ? <code>{part}</code> : part)}</For>
    </p>
  );
}

/**
 * An error in the transcript, read for a person (see `errorView`), with a button that copies what it shows, and what
 * plugins offer to fix it (`ErrorActions`), for a failed model request.
 */
function ErrorNote(props: { message: string; request?: { readonly provider: string; readonly model: string } | undefined }) {
  const view = createMemo(() => errorView(props.message));
  return (
    <div class="callout callout-error chat-error">
      <AlertIcon />
      <div class="chat-error-text">
        <ErrorLine class="chat-error-summary" text={view().summary} />
        <Show when={view().description}>{(description) => <ErrorLine text={description()} />}</Show>
        <Show when={view().hint}>{(hint) => <ErrorLine text={hint()} />}</Show>
        <Show when={props.request}>
          {(request) => (
            <div class="chat-error-actions">
              <Each slot={ErrorActions} props={{ provider: request().provider, model: request().model, message: props.message }} />
            </div>
          )}
        </Show>
      </div>
      <CopyButton text={[view().summary, view().description, view().hint].filter((line) => line !== undefined).join("\n")} label="Copy error" />
    </div>
  );
}

/** Why a message ended, when it is worth saying: a stop the person asked for is not. */
function StopNote(props: { item: AssistantItem }) {
  return (
    <Switch>
      <Match when={props.item.message.stopReason === "error"}>
        <ErrorNote
          message={props.item.message.errorMessage ?? "The model request failed."}
          request={{ provider: props.item.message.provider, model: props.item.message.model }}
        />
      </Match>
      <Match when={props.item.message.stopReason === "length"}>
        <p class="note">Output hit the model's token limit</p>
      </Match>
    </Switch>
  );
}

/**
 * A model call that did not finish: a failed one as a row that opens to what it wrote. One the person stopped shows
 * what it had written, as it was, and nothing when it had not begun.
 */
function Attempt(props: { chat: Chat; item: AttemptItem }) {
  return (
    <Show
      when={props.item.message.stopReason !== "aborted"}
      fallback={<Blocks chat={props.chat} blocks={props.item.blocks} scope={props.item.id} turnEnded={true} />}
    >
      <FailedAttempt chat={props.chat} item={props.item} />
    </Show>
  );
}

function FailedAttempt(props: { chat: Chat; item: AttemptItem }) {
  const { isOpen, toggle } = props.chat;
  const open = () => isOpen(props.item.id, false);
  const hasContent = () => props.item.blocks.some((block) => block.kind !== "text" || block.text.trim() !== "");
  return (
    <div class="attempt" classList={{ open: open() }}>
      <button class="row-head attempt-head" aria-expanded={open()} disabled={!hasContent()} onClick={() => toggle(props.item.id, false)}>
        <span class="row-icon">
          <AlertIcon />
        </span>
        <span class="attempt-label">Attempt failed</span>
        <span class="attempt-error tw:truncate">{props.item.message.errorMessage ?? ""}</span>
        <span class="attempt-time">{formatDuration(props.item.timing.endedAt - props.item.timing.startedAt)}</span>
      </button>
      <Show when={open() && hasContent()}>
        <div class="attempt-body">
          <Blocks chat={props.chat} blocks={props.item.blocks} scope={props.item.id} turnEnded={true} displays={false} />
        </div>
      </Show>
    </div>
  );
}

/** Context a plugin added to the conversation, as a line: its plugin and its first line, the whole text in the tooltip. */
function ContextLine(props: { source: string; text: string }) {
  return (
    <div class="divider" data-tip={props.text}>
      <span>
        Context from {props.source}: {props.text.split("\n")[0]}
      </span>
    </div>
  );
}

/**
 * `mark`: a steer's place on the prompt rail (`PromptMark.key`), which it marks. A prompt's element names its event
 * (`data-prompt`), for its link (`promptAnchor`) to find. `displays`: as `BlockView`'s.
 */
function ItemView(props: {
  chat: Chat;
  item: Item;
  turnEnded: boolean;
  note?: boolean;
  mark?: string | undefined;
  displays?: boolean | undefined;
}): JSX.Element {
  return (
    <Switch>
      <Match when={props.item.kind === "user" && props.item}>
        {(item) => {
          const prompt = createMemo((): PromptInfo | undefined => {
            const sessionId = props.chat.threads.activeId();
            const { id, at, content, steer } = item();
            return sessionId === undefined ? undefined : { sessionId, eventId: id, at, content, steer: steer === true };
          });
          return (
            <div class="prompt" data-prompt={item().id} data-mark={props.mark}>
              <ChatUser content={item().content} steer={item().steer} prompt={prompt()} />
            </div>
          );
        }}
      </Match>
      <Match when={props.item.kind === "assistant" && props.item}>
        {(item) => (
          <div class="assistant">
            <Blocks chat={props.chat} blocks={item().blocks} scope={item().stepId ?? item().id} turnEnded={props.turnEnded} displays={props.displays} />
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
      <Match when={props.item.kind === "context" && props.item}>
        {(item) => (
          <Show when={props.chat.contextView(item().source)} keyed fallback={<ContextLine source={item().source} text={item().text} />}>
            {(view) => (
              <Contained
                slot={ContextViews}
                item={view}
                component={view.component}
                props={{
                  id: item().id,
                  source: item().source,
                  content: item().content,
                  display: item().display,
                  requestId: item().requestId,
                  at: item().at,
                }}
              />
            )}
          </Show>
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
  const speed = createMemo(() => {
    const rate = throughput(props.turn.items.flatMap((item) => (item.kind === "assistant" ? [item] : [])));
    return rate === undefined ? undefined : formatThroughput(rate);
  });
  const title = () => (speed() === undefined ? usage().title : `${usage().title}\nSpeed ${speed()} while streaming`);
  const duration = () => (props.turn.endedAt === undefined ? undefined : props.turn.endedAt - props.turn.startedAt);
  const model = () => props.turn.models.map((ref) => parseModelRef(ref)?.model ?? ref).join(", ");
  const reason = () => props.turn.end?.reason;
  const answer = () => props.answer;
  return (
    <footer class="turn-footer">
      <Show when={answer()}>{(text) => <CopyButton text={text()} label="Copy response" class="turn-copy" />}</Show>
      {/* A turn the person stopped has no badge: its section ends with a line saying so. */}
      <Show when={reason() === "max-steps"}>
        <span class="badge badge-warn">step limit</span>
      </Show>
      <Show when={reason() === "error"}>
        <span class="badge badge-error">error</span>
      </Show>
      {/* Focusable, so the tokens in its tooltip reach a keyboard too; read out whole, and shown where nothing hovers. */}
      <span class="turn-usage" tabIndex={0} data-tip={title()}>
        <Show when={model()}>
          <span>{model()}</span>
        </Show>
        <Show when={props.turn.usage.totalTokens > 0}>
          <span class="turn-tokens" aria-hidden="true">
            ↑{usage().input} ↓{usage().output}
          </span>
        </Show>
        <Show when={speed()}>
          <span aria-hidden="true">{speed()}</span>
        </Show>
        <Show when={usage().cost}>
          <span>{usage().cost}</span>
        </Show>
        <Show when={duration() !== undefined}>
          <span>{formatDuration(duration()!)}</span>
        </Show>
        <span class="sr-only">{title()}</span>
      </span>
    </footer>
  );
}

/** An entry of folded work: a block on its own, an item whole, or calls made one after another under their line. */
function WorkEntryView(props: { chat: Chat; entry: WorkEntry; turnEnded: boolean }) {
  return (
    <Switch>
      <Match when={props.entry.kind === "block" && props.entry}>
        {(row) => <BlockView chat={props.chat} block={row().block} scope={row().scope} turnEnded={props.turnEnded} displays={false} />}
      </Match>
      <Match when={props.entry.kind === "item" && props.entry}>
        {(row) => <ItemView chat={props.chat} item={row().item} turnEnded={props.turnEnded} note={false} displays={false} />}
      </Match>
      <Match when={props.entry.kind === "group" && props.entry}>
        {(group) => (
          <ChatWorkGroup
            summary={group().summary}
            tools={group().tools}
            failed={group().failed}
            at={group().at}
            open={props.chat.isOpen(group().key, props.chat.config.expandTools)}
            onToggle={() => props.chat.toggle(group().key, props.chat.config.expandTools)}
          >
            <Keyed each={group().rows}>{(row) => <WorkEntryView chat={props.chat} entry={row()} turnEnded={props.turnEnded} />}</Keyed>
          </ChatWorkGroup>
        )}
      </Match>
    </Switch>
  );
}

/** What a fold's calls show the reader (`ToolViews`' `display`): one call's, or a run of one tool's its view draws together. */
function DisplayEntryView(props: { chat: Chat; entry: DisplayEntry; running: boolean }) {
  return (
    <Switch>
      <Match when={props.entry.kind === "one" && props.entry.block}>
        {(block) => (
          <ToolDisplay
            chat={props.chat}
            id={block().call.id}
            name={block().call.name}
            args={block().call.arguments}
            result={block().result}
            state={toolStateOf(block().result, props.running)}
          />
        )}
      </Match>
      <Match when={props.entry.kind === "many" && props.entry}>
        {(many) => (
          <ToolDisplays
            chat={props.chat}
            name={many().name}
            calls={many().blocks.map((block) => ({
              id: block.call.id,
              name: block.call.name,
              args: block.call.arguments,
              result: block.result,
              state: toolStateOf(block.result, props.running),
            }))}
          />
        )}
      </Match>
    </Switch>
  );
}

/** Entries keyed by their key, so what stays in view keeps its DOM as the turn runs on and the entries are made again. */
function Keyed<T extends { readonly key: string }>(props: { each: readonly T[]; children: (entry: () => T) => JSX.Element }) {
  const byKey = createMemo(() => new Map(props.each.map((entry) => [entry.key, entry])));
  return <For each={[...byKey().keys()]}>{(key) => <Show when={byKey().get(key)}>{(entry) => props.children(entry)}</Show>}</For>;
}

/**
 * A run of folded work, through the `chat.work` part: its rows, with calls
 * made one after another gathered under a `chat.work-group` line, and in the
 * running turn's live run, its streaming step at the end. Each run of a
 * running turn stays open until the turn ends, unless the reader closed it,
 * so a steer joining between two runs moves nothing above it. After it, open
 * or closed, what its calls show the reader (`ToolViews`' `display`), above
 * the answer.
 */
function WorkFold(props: { chat: Chat; work: Extract<TurnEntry, { kind: "work" }>; drafts: readonly StepDraft[]; running: boolean }) {
  const live = () => props.work.live === true;
  const entries = createMemo(() => workEntries(props.work.items, (name) => props.chat.toolView(name)?.action));
  // Keyed by call, so a page drawn while the turn ran stays as it is (not loaded again) as the fold is made again; a
  // run of one tool's calls its view draws together (`displays`) is one entry.
  const displays = createMemo(() =>
    displayEntries(
      displayedCalls(props.work.items, (name) => {
        const view = props.chat.toolView(name);
        return view?.display === undefined ? undefined : { live: view.live === true };
      }),
      (name) => props.chat.toolView(name)?.displays !== undefined,
    ),
  );
  const duration = () => (live() ? Math.max(0, props.chat.now() - props.work.since) : props.work.duration);
  return (
    <>
      <ChatWork
        steps={props.work.items.filter((item) => item.kind !== "user" && item.kind !== "compaction").length}
        tools={props.work.tools}
        failed={props.work.failed}
        duration={duration()}
        live={live()}
        open={props.chat.isOpen(props.work.key, props.running)}
        onToggle={() => props.chat.toggle(props.work.key, props.running)}
      >
        <Keyed each={entries()}>{(entry) => <WorkEntryView chat={props.chat} entry={entry()} turnEnded={!props.running} />}</Keyed>
        <Index each={live() ? props.drafts : []}>{(draft) => <Draft chat={props.chat} draft={draft()} />}</Index>
      </ChatWork>
      <Keyed each={displays()}>{(entry) => <DisplayEntryView chat={props.chat} entry={entry()} running={props.running} />}</Keyed>
    </>
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
          <span class="work-sep" aria-hidden="true">
            ·
          </span>
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

/**
 * The default `chat.work-group` part: calls made one after another as one line, what they did, that opens to them.
 * Its icon is their tools' when they share one (`ToolViews`).
 */
const workGroupView = (slots: SlotsService) =>
  function WorkGroupView(props: ChatWorkGroupProps) {
    const icon = () => {
      const icons = new Set(props.tools.map((name) => slots.get(ToolViews, name)?.icon));
      const [only] = icons;
      return icons.size === 1 && only !== undefined ? only : "hammer";
    };
    return (
      <div class="work-group" classList={{ open: props.open }}>
        <button class="row-head work-group-head" aria-expanded={props.open} onClick={() => props.onToggle()}>
          <span class="row-icon">
            <Icon name={icon()} />
          </span>
          <span class="row-label">
            <span class="work-group-summary">{props.summary}</span>
            <Show when={props.failed > 0}>
              <span class="work-sep" aria-hidden="true">
                ·
              </span>
              <span class="work-failed">{props.failed} failed</span>
            </Show>
          </span>
          <span class="row-time">{new Date(props.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
          <ChevronIcon class="chevron row-chevron" />
        </button>
        <Show when={props.open}>
          <div class="work-group-body">{props.children}</div>
        </Show>
      </div>
    );
  };

/** The default `chat.working` part. */
function WorkingView(props: ChatWorkingProps) {
  return (
    <div class="chat-working">
      <span class="pulse" data-motion />
      Working
      <Show when={props.startedAt}>{(started) => <span class="working-time">{formatElapsed(props.now - started())}</span>}</Show>
    </div>
  );
}

/** An entry of a folded turn: a run of work, or an item on its own. `mark`: see `ItemView`. */
function FoldedEntry(props: {
  chat: Chat;
  entry: TurnEntry;
  ended: boolean;
  running: boolean;
  drafts: readonly StepDraft[];
  mark: (item: Item) => string | undefined;
}) {
  return (
    <Switch>
      <Match when={props.entry.kind === "work" && props.entry}>
        {(work) => <WorkFold chat={props.chat} work={work()} drafts={props.drafts} running={props.running} />}
      </Match>
      <Match when={props.entry.kind === "item" && props.entry}>
        {(entry) => <ItemView chat={props.chat} item={entry().item} turnEnded={props.ended} note={entry().note} mark={props.mark(entry().item)} />}
      </Match>
    </Switch>
  );
}

/**
 * A turn; `running` when it is the one the session is running now, whose live run of work shows its streaming steps
 * (`drafts`). The last turn ends with the steers sent and not yet placed (`steers`), after the step under way, where
 * the turn places them once that step ends, unless its streaming steps are drawn after it.
 */
function Turn(props: { chat: Chat; turn: TurnView; running: boolean; drafts: readonly StepDraft[]; steers: QueuePlaces["joining"] }) {
  const ended = () => props.turn.end !== undefined;
  /** The last model call's error, which its stop note already shows. */
  const lastError = () => {
    const last = [...props.turn.items].reverse().find((item): item is AssistantItem => item.kind === "assistant");
    return last?.message.stopReason === "error" ? last.message.errorMessage : undefined;
  };
  const folded = createMemo(() => (props.chat.config.foldWork ? (foldTurn(props.turn) ?? (props.running ? foldRunning(props.turn) : undefined)) : undefined));
  /** The prompt that starts the turn: the user items after it are steers, each with its own place on the prompt rail. */
  const opening = createMemo(() => props.turn.items.find((item) => item.kind === "user")?.id);
  const markOf = (item: Item) => (item.kind === "user" && item.id !== opening() ? markKey(props.turn, item) : undefined);
  // A fold makes new entries each time the turn changes: keyed by entry key, what stays in view stays mounted.
  const keyed = createMemo(() => (folded() ?? []).map((entry) => ({ key: entryKey(entry), entry })));
  return (
    <section class="turn" data-turn={props.turn.key} data-mark={props.turn.key} data-end={props.turn.end?.reason}>
      <Show
        when={folded()}
        fallback={<For each={props.turn.items}>{(item) => <ItemView chat={props.chat} item={item} turnEnded={ended()} mark={markOf(item)} />}</For>}
      >
        <Keyed each={keyed()}>
          {(keyedEntry) => (
            <FoldedEntry chat={props.chat} entry={keyedEntry().entry} ended={ended()} running={props.running} drafts={props.drafts} mark={markOf} />
          )}
        </Keyed>
      </Show>
      <Show when={props.turn.end?.reason === "error" && props.turn.end.error !== lastError() && props.turn.end.error}>
        {(error) => <ErrorNote message={error()} />}
      </Show>
      <Show when={ended()}>
        <ChatTurnFooter turn={props.turn} answer={answerText(props.turn)} />
      </Show>
      <Show when={props.turn.end?.reason === "cancelled"}>
        <div class="turn-interrupted">
          <span>
            <XIcon />
            Interrupted
          </span>
        </div>
      </Show>
      <For each={props.steers}>{(steer) => <PendingSteer chat={props.chat} steer={steer} />}</For>
    </section>
  );
}

/**
 * A steer sent and not yet placed, where it will join, as it will show once placed; until then it can be withdrawn. A
 * plugin's notice (`QueuedPrompt.source`) shows as the context line it will be, with no place on the prompt rail.
 */
function PendingSteer(props: { chat: Chat; steer: QueuePlaces["joining"][number] }) {
  const withdraw = usePlugin().action("withdraw a steer", () => props.chat.threads.withdraw(props.steer.requestId));
  const notice = () => props.steer.source;
  const noticeText = () => props.steer.display ?? props.steer.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
  return (
    <Show when={notice() === undefined} fallback={<ContextLine source={notice()!} text={noticeText()} />}>
      <div class="steer-pending" data-mark={pendingMark(props.steer.requestId)}>
        <button
          type="button"
          class="icon-button steer-withdraw"
          aria-label="Withdraw the steer"
          data-tip="Withdraw: the turn has not taken it yet"
          onClick={() => withdraw()}
        >
          <XIcon />
        </button>
        <ChatUser content={props.steer.content} steer />
      </div>
    </Show>
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
  /**
   * Steers the running turn has yet to place (`queuePlaces`' `joining`), which join after the step that streams: at the
   * end of the last turn, or after its steps drawn loose. What a stopped turn left waits in the composer's queue.
   */
  const steers = createMemo(() => queuePlaces(threads).joining);
  // Shown for the whole turn, not only between steps (a line that came and went with each step made the transcript jump), unless its live fold says it.
  const working = () => threads.busy() && folding() === undefined;
  const turnStarted = () => {
    const last = props.turns.at(-1);
    return last !== undefined && last.end === undefined ? last.startedAt : undefined;
  };
  return (
    <div class="transcript">
      <Index each={props.turns}>
        {(turn) => (
          <Turn
            chat={props.chat}
            turn={turn()}
            running={turn() === running()}
            drafts={draftsOf(turn())}
            steers={turn() === props.turns.at(-1) && loose().length === 0 ? steers() : []}
          />
        )}
      </Index>
      <Index each={loose()}>{(draft) => <Draft chat={props.chat} draft={draft()} />}</Index>
      <Show when={loose().length > 0}>
        <For each={steers()}>{(steer) => <PendingSteer chat={props.chat} steer={steer} />}</For>
      </Show>
      <Show when={working()}>
        <ChatWorking startedAt={turnStarted()} now={props.chat.now()} />
      </Show>
    </div>
  );
}

/**
 * The session as a conversation, projected from its log. Tool calls render
 * through the `chat.tools` slot when a plugin fills it for that tool.
 */
export default defineWebPlugin({
  id: "threads.transcript",
  styles,
  config: ChatConfig,
  requires: { client: Client, threads: Threads, router: Router, slots: Slots, webPlugins: WebPlugins, notify: Notify },
  setup: ({ client, threads, router, slots, webPlugins, notify }, plugin) => {
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
    /** Opens the find bar of the transcript shown, if one is. */
    const [find, setFind] = createSignal<(() => void) | undefined>();
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
      toolView: (name) => slots.get(ToolViews, name),
      contextView: (source) => slots.get(ContextViews, source),
    };
    // Its own parts' defaults, in the phase `default`: any plugin replaces one by adding one of its own.
    const part = <P extends Record<string, any>>(slot: Part<P>, component: Component<P>) =>
      slots.add(slot, { id: `chat.${slot.name.slice("part.chat.".length)}`, phase: "default", component });
    part(ChatUserPart, UserView);
    part(ChatThinkingPart, ThinkingView);
    part(ChatToolPart, toolView({ client, threads, slots }));
    part(ChatWorkPart, WorkView);
    part(ChatWorkGroupPart, workGroupView(slots));
    part(ChatWorkingPart, WorkingView);
    part(ChatTurnFooterPart, TurnFooter);
    // After the composer's "Edit from here" (10).
    slots.add(PromptActions, { id: "chat.copy-prompt", order: 20, component: CopyPrompt });
    slots.add(PromptActions, { id: "chat.prompt-link", order: 30, component: copyLink(threads) });
    // Before a view added without an order (0), whatever its plugin's id: a thread opens on its transcript.
    slots.add(Views, {
      id: "transcript",
      order: -10,
      title: "Thread",
      icon: ChatIcon,
      composer: true,
      component: () => (
        <ChatView chat={chat} turns={() => transcript().turns} findWith={(open) => setFind(() => open)}>
          <Transcript chat={chat} turns={transcript().turns} />
        </ChatView>
      ),
    });
    addSettings(slots, webPlugins, notify, plugin.id, plugin.config);
    slots.add(Actions, {
      id: "thread.find",
      order: 15,
      title: "Find in thread",
      category: "Thread",
      keywords: ["search"],
      icon: SearchIcon,
      keys: "mod+f",
      when: () => find() !== undefined,
      run: () => find()?.(),
    });
  },
});
