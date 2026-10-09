import { For, Show, createEffect, createMemo, createSignal, on } from "solid-js";
import type { Accessor } from "solid-js";
import type { ConnectionStatus } from "@lemma/client";
import { AgentChannels, CommandChannels, LlmChannels, SessionChannels } from "@lemma/contracts";
import type { AgentActivity, CommandInfo, LlmChange, RuntimeEvent, SessionsChange } from "@lemma/contracts";
import { clockTime } from "../../model/format.ts";
import { ThreadRoute } from "../../ui/contracts.ts";
import type { ClientService, DevtoolsPanel, RouterService } from "../../ui/contracts.ts";
import { XIcon } from "../../ui/parts.tsx";
import type { SlotItem } from "../../ui/slots.ts";

export const EVENTS_PANEL = "devtools.events";
/** Lines kept, newest last; older ones drop off the top. */
const LIMIT = 1000;
/** The host's own event stream, beside the subsystems' streams. */
const HOST_EVENTS = "Host.Events";

/** What a line heard: one of the host's own events, or an element of a subsystem's stream. */
type Heard =
  | { readonly stream: typeof HOST_EVENTS; readonly event: RuntimeEvent }
  | { readonly stream: "sessions.changes"; readonly event: SessionsChange }
  | { readonly stream: "agent.activity"; readonly event: AgentActivity }
  | { readonly stream: "llm.changes"; readonly event: LlmChange }
  | { readonly stream: "commands.changes"; readonly event: readonly CommandInfo[] };

/** A line of the log: what a stream sent, a stream ending, or a change in the connection carrying them. */
type Line =
  | ({ readonly seq: number; readonly at: number; readonly kind: "event"; readonly bytes: number } & Heard)
  | { readonly seq: number; readonly at: number; readonly kind: "end"; readonly stream: string; readonly error?: string }
  | { readonly seq: number; readonly at: number; readonly kind: "conn"; readonly status: ConnectionStatus };

/** Follows the subsystems' streams, each element heard and each ending told; returns the stops. */
const followStreams = (client: ClientService, hear: (heard: Heard) => void, ended: (stream: string, error?: Error) => void): (() => void)[] => [
  client.follow(
    SessionChannels.changes,
    undefined,
    (event) => hear({ stream: "sessions.changes", event }),
    (error) => ended(SessionChannels.changes.id, error),
  ),
  client.follow(
    AgentChannels.activity,
    undefined,
    (event) => hear({ stream: "agent.activity", event }),
    (error) => ended(AgentChannels.activity.id, error),
  ),
  client.follow(
    LlmChannels.changes,
    undefined,
    (event) => hear({ stream: "llm.changes", event }),
    (error) => ended(LlmChannels.changes.id, error),
  ),
  client.follow(
    CommandChannels.changes,
    undefined,
    (event) => hear({ stream: "commands.changes", event }),
    (error) => ended(CommandChannels.changes.id, error),
  ),
];

const streamOf = (line: Line): string => (line.kind === "conn" ? "connection" : line.stream);

/** What a line is about, for its colour. */
const category = (line: Line): string => {
  if (line.kind !== "event") return "conn";
  if (line.stream === "commands.changes") return "host";
  const event = line.event;
  if (event.type === "notice") return `notice-${event.notice.level}`;
  if (event.type === "delta" || event.type === "tool-output") return "delta";
  if (event.type.startsWith("session")) return "session";
  if (event.type.startsWith("turn") || event.type === "queue-changed") return "turn";
  if (event.type.startsWith("interaction")) return "interaction";
  return "host";
};

const typeOf = (line: Line): string => {
  if (line.kind === "conn") return line.status.state;
  if (line.kind === "end") return "ended";
  return line.stream === "commands.changes" ? "commands" : line.event.type;
};

const sessionOf = (line: Line): string | undefined => {
  if (line.kind !== "event" || line.stream === "commands.changes") return undefined;
  const event = line.event;
  if ("sessionId" in event) return event.sessionId;
  if (event.type === "session-changed") return event.info.id;
  return undefined;
};

/** The line's message. */
const describe = (line: Line): string => {
  if (line.kind === "conn") {
    const { generation, attempts, error } = line.status;
    return `generation ${generation}${attempts > 0 ? ` · attempt ${attempts}` : ""}${error === undefined ? "" : ` · ${error}`}`;
  }
  if (line.kind === "end") return line.error ?? "finished";
  if (line.stream === "commands.changes") return line.event.map((command) => command.id).join(" ") || "none";
  const event = line.event;
  switch (event.type) {
    case "subscribed":
      return "running" in event ? `running: ${event.running.join(" ") || "none"}` : "from here on it hears every change";
    case "notice":
      return `${event.notice.level}${event.notice.source === undefined ? "" : ` ${event.notice.source}:`} ${event.notice.message}`;
    case "delta":
      return `${event.event.type}${event.event.type === "text-delta" ? ` ${JSON.stringify(event.event.delta)}` : ""} · turn ${event.turnId} step ${event.stepId}`;
    case "tool-output":
      return `${JSON.stringify(event.chunk.length > 80 ? `${event.chunk.slice(0, 80)}…` : event.chunk)} · call ${event.toolCallId}`;
    case "session-removed":
      return "deleted";
    case "session-changed":
      return `lastSeq ${event.info.lastSeq}${event.info.title === undefined ? "" : ` "${event.info.title}"`}`;
    case "turn-started":
      return `turn ${event.turnId}`;
    case "queue-changed":
      return event.queue.length === 0 ? "empty" : event.queue.map((queued) => `${queued.mode} ${queued.requestId}`).join(" · ");
    case "turn-ended":
      return `turn ${event.turnId} ${event.reason} · ↑${event.usage.input} ↓${event.usage.output}`;
    case "models-changed":
      return "list them again";
    case "interaction":
      return `${event.request.id} ${event.request.type}: ${event.request.title}`;
    case "interaction-closed":
      return event.id;
    case "plugins-changed":
      return event.plugins.map((plugin) => `${plugin.id}=${plugin.state}`).join(" ");
    case "channels-changed":
      return event.channels.map((channel) => `${channel.id} (${channel.source})`).join(" ") || "none";
    case "ui-changed":
      return `${Object.keys(event.ui.plugins).length} rows · files ${event.ui.files.map((file) => file.name).join(" ") || "none"}`;
  }
};

const gap = (ms: number) => (ms < 1000 ? `+${ms}ms` : ms < 60_000 ? `+${(ms / 1000).toFixed(1)}s` : `+${Math.round(ms / 60_000)}m`);
const size = (bytes: number) => (bytes < 1024 ? `${bytes}B` : `${(bytes / 1024).toFixed(1)}K`);

/**
 * What this page hears from the host, as a log: the host's own events
 * (`Host.Events`), the subsystems' streams while the devtools are open (their
 * changes, and the agent's activity), and changes in the connection carrying
 * them. One row per element with its time, the gap since the one before, its
 * stream and type, session, and size. Follows the tail while scrolled to the
 * bottom; a row selected opens its raw JSON, and a session its thread's
 * trajectory.
 */
function EventLog(props: { client: ClientService; router: RouterService; lines: Accessor<readonly Line[]>; clear: () => void }) {
  const [query, setQuery] = createSignal("");
  const [deltas, setDeltas] = createSignal(false);
  const [paused, setPaused] = createSignal<readonly Line[]>();
  const [selected, setSelected] = createSignal<number>();
  const [stuck, setStuck] = createSignal(true);
  let scroller!: HTMLDivElement;

  const source = () => paused() ?? props.lines();
  const shown = createMemo(() => {
    const words = query().trim().toLowerCase().split(/\s+/).filter(Boolean);
    return source().filter((line) => {
      // Streamed output (model deltas, tool output) is hidden until asked for.
      if (!deltas() && category(line) === "delta") return false;
      if (words.length === 0) return true;
      const text = `${streamOf(line)} ${typeOf(line)} ${sessionOf(line) ?? ""} ${describe(line)}`.toLowerCase();
      return words.every((word) => (word.startsWith("-") && word.length > 1 ? !text.includes(word.slice(1)) : text.includes(word)));
    });
  });
  const rate = createMemo(() => {
    const since = Date.now() - 10_000;
    return props.lines().filter((line) => line.at >= since).length / 10;
  });
  const chosen = () => source().find((line) => line.seq === selected());
  const url = () => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/rpc`;
  const state = () => props.client.status().state;

  createEffect(
    on(shown, () => {
      if (stuck()) queueMicrotask(() => scroller.scrollTo({ top: scroller.scrollHeight }));
    }),
  );
  const onScroll = () => setStuck(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 24);
  // Escape in the filter clears it.
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented || query() === "") return;
    event.preventDefault();
    event.stopPropagation();
    setQuery("");
  };

  return (
    <div class="dt-scope log-view" aria-label="Host events">
      <div class="dt-toolbar" role="toolbar" aria-label="Host events toolbar">
        <label class="dt-filter">
          <input
            placeholder="Filter: stream, type, session, or text; -word excludes"
            aria-label="Filter events"
            autocomplete="off"
            spellcheck={false}
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={onKey}
          />
        </label>
        <span class="dt-sep" />
        <button class="dt-chip" aria-pressed={deltas()} onClick={() => setDeltas(!deltas())}>
          Deltas
        </button>
        <button class="dt-chip" aria-pressed={paused() !== undefined} onClick={() => setPaused(paused() === undefined ? props.lines() : undefined)}>
          {paused() === undefined ? "Pause" : `Paused · ${props.lines().length - paused()!.length} new`}
        </button>
        <button
          class="dt-chip"
          onClick={() => {
            props.clear();
            setSelected(undefined);
            if (paused() !== undefined) setPaused([]);
          }}
        >
          Clear
        </button>
        <Show when={!stuck()}>
          <span class="dt-sep" />
          <button
            class="dt-chip"
            onClick={() => {
              setStuck(true);
              scroller.scrollTo({ top: scroller.scrollHeight });
            }}
          >
            ↓ Follow
          </button>
        </Show>
      </div>
      <div class="dt-split">
        <div class="dt-main" ref={scroller} onScroll={onScroll} tabindex="-1" role="log" aria-live="off">
          <table class="dt-table log-table" aria-label="Events">
            <thead>
              <tr>
                <th style={{ width: "108px" }}>Time</th>
                <th style={{ width: "62px" }}>Gap</th>
                <th style={{ width: "130px" }}>Stream</th>
                <th style={{ width: "130px" }}>Type</th>
                <th style={{ width: "120px" }}>Session</th>
                <th style={{ width: "56px" }}>Size</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              <For
                each={shown()}
                fallback={
                  <tr>
                    <td colSpan={7} class="dt-muted">
                      {props.lines().length === 0 ? "Waiting for events…" : "No events match"}
                    </td>
                  </tr>
                }
              >
                {(line, index) => {
                  const before = () => shown()[index() - 1];
                  return (
                    <tr data-row data-selected={selected() === line.seq} onClick={() => setSelected(selected() === line.seq ? undefined : line.seq)}>
                      <td class="dt-code dt-muted">{clockTime(line.at)}</td>
                      <td class="dt-code dt-muted dt-num">{before() === undefined ? "" : gap(line.at - before()!.at)}</td>
                      <td class="dt-code dt-muted">{streamOf(line)}</td>
                      <td class={`dt-code log-type is-${category(line)}`}>{typeOf(line)}</td>
                      <td class="dt-code">
                        <Show when={sessionOf(line)} fallback={<span class="dt-muted">·</span>}>
                          {(id) => (
                            <a
                              href={props.router.href(ThreadRoute, { id: id(), view: "trajectory" })}
                              data-tip="Open its trajectory"
                              onClick={(event) => event.stopPropagation()}
                            >
                              {id()}
                            </a>
                          )}
                        </Show>
                      </td>
                      <td class="dt-code dt-muted dt-num">{line.kind === "event" ? size(line.bytes) : ""}</td>
                      <td class="dt-code">{describe(line)}</td>
                    </tr>
                  );
                }}
              </For>
            </tbody>
          </table>
        </div>
        <Show when={chosen()} keyed>
          {(line) => (
            <aside class="dt-details dt-side" aria-label="Event details">
              <div class="dt-details-title">
                <strong class={`dt-code log-type is-${category(line)}`}>{typeOf(line)}</strong>
                <span class="dt-muted dt-code">{streamOf(line)}</span>
                <span class="dt-muted">{clockTime(line.at)}</span>
                <button class="dt-close" style={{ "margin-left": "auto" }} aria-label="Close details" onClick={() => setSelected(undefined)}>
                  <XIcon />
                </button>
              </div>
              <div class="dt-side-body">
                <pre class="dt-pre">
                  {JSON.stringify(line.kind === "event" ? line.event : line.kind === "end" ? { error: line.error } : line.status, null, 2)}
                </pre>
              </div>
            </aside>
          )}
        </Show>
      </div>
      <div class="dt-status" role="status">
        <span>
          <span class={`dt-dot ${state() === "connected" ? "dt-ok" : state() === "closed" ? "dt-err" : "dt-warn"}`} />
          {HOST_EVENTS} · {state()} · gen {props.client.status().generation}
        </span>
        <span class="dt-code">{url()}</span>
        <span>
          {shown().length} / {props.lines().length}
        </span>
        <span>{rate().toFixed(1)}/s</span>
      </div>
    </div>
  );
}

/**
 * Records what the host sends this page from now until `onCleanup` runs, for
 * the Host events panel: its own events and the connection always, and the
 * subsystems' streams while `following` (the devtools are open), since
 * following them costs a subscription of the page's own, the agent's output
 * included.
 */
export function hostEventsPanel(
  client: ClientService,
  router: RouterService,
  following: Accessor<boolean>,
  onCleanup: (fn: () => void) => void,
): SlotItem<DevtoolsPanel> {
  const [lines, setLines] = createSignal<readonly Line[]>([]);
  let seq = 0;
  const push = (line: Line) => setLines((current) => [...(current.length >= LIMIT ? current.slice(current.length - LIMIT + 1) : current), line]);
  const hear = (heard: Heard) => push({ seq: ++seq, at: Date.now(), kind: "event", bytes: JSON.stringify(heard.event).length, ...heard });
  onCleanup(client.onEvent((event) => hear({ stream: HOST_EVENTS, event })));
  let streams: (() => void)[] = [];
  createEffect(
    on(following, (now) => {
      for (const stop of streams) stop();
      streams = now
        ? followStreams(client, hear, (stream, error) =>
            push({ seq: ++seq, at: Date.now(), kind: "end", stream, ...(error === undefined ? {} : { error: error.message }) }),
          )
        : [];
    }),
  );
  onCleanup(() => {
    for (const stop of streams) stop();
  });
  // One line per change of state or generation, not per retry countdown.
  createEffect(
    on(
      () => `${client.status().state}:${client.status().generation}`,
      () => push({ seq: ++seq, at: Date.now(), kind: "conn", status: client.status() }),
    ),
  );
  return {
    id: EVENTS_PANEL,
    order: 15,
    title: "Host events",
    component: () => <EventLog client={client} router={router} lines={lines} clear={() => setLines([])} />,
    snapshot: () => lines().map((line) => ({ at: line.at, stream: streamOf(line), type: typeOf(line), session: sessionOf(line), message: describe(line) })),
  };
}
