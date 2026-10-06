import { For, Match, Show, Switch, createMemo, createSignal } from "solid-js";
import { contentText, formatDuration } from "@lemma/contracts";
import type { ImageContent, TextContent } from "@lemma/contracts";
import { diffStats, parseDiff, readDetails } from "../../model/details.ts";
import { formatElapsed, summarizeToolArgs, summarizePartialArgs, truncateLines } from "../../model/format.ts";
import type { ToolResultView } from "../../model/transcript.ts";
import { ToolViews } from "../../ui/contracts.ts";
import type { ChatToolProps, ClientService, ThreadsService } from "../../ui/contracts.ts";
import type { SlotsService } from "../../ui/slots.ts";
import { ChatTool, CheckIcon, ChevronDownIcon, ChevronIcon, Contained, FileTypeIcon, Spinner, XIcon } from "../../ui/parts.tsx";
import type { Chat } from "./config.ts";

const imageSrc = (image: ImageContent) => `data:${image.mimeType};base64,${image.data}`;

/** The images among `content`: a prompt's, or a tool result's. */
export function Images(props: { content: readonly (TextContent | ImageContent)[] }) {
  const images = () => props.content.filter((part): part is ImageContent => part.type === "image");
  return (
    <Show when={images().length > 0}>
      <div class="images">
        <For each={images()}>{(image) => <img src={imageSrc(image)} alt="Attached image" loading="lazy" />}</For>
      </div>
    </Show>
  );
}

/** Lines of a tool's output shown before "more lines". */
const OUTPUT_LINES = 14;

function Output(props: { text: string; error?: boolean }) {
  const [all, setAll] = createSignal(false);
  const cut = createMemo(() => truncateLines(props.text.replace(/\n+$/, ""), OUTPUT_LINES));
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

/** Lines of a running tool's output shown under it. */
const LIVE_LINES = 6;

export type ToolState = "running" | "queued" | "ok" | "error" | "interrupted";

/** A tool call, through the `chat.tool` part, with the chat's open state, its live output, and how long it has run. */
export function ToolCard(props: {
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
export const toolView = (deps: { readonly client: ClientService; readonly threads: ThreadsService; readonly slots: SlotsService }) =>
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
    const outputText = () => (props.result === undefined ? "" : contentText(props.result.content));
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
          <span class="tool-name">{props.name || "tool"}</span>
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
            // A view with a summary and no body leaves the body to the chat's own.
            when={custom()?.body === undefined ? undefined : custom()}
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
            {(view) => (
              <Contained
                slot={ToolViews}
                item={view}
                component={view.body}
                props={{ id: props.id, name: props.name, args: props.args, result: props.result, state: props.state, output: props.output }}
              />
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
        <Output text={outputText()} error={props.state === "error"} />
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
