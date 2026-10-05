import { For, Show, createEffect, createMemo, createSignal, on } from "solid-js";
import type { Accessor } from "solid-js";
import type { ConnectionStatus } from "@lemma/client";
import type { HostEvent } from "@lemma/contracts";
import { ActionIds, Actions, Client, Devtools, DevtoolsPanels, Router, Slots, ThreadRoute } from "../ui/contracts.ts";
import type { ClientService, RouterService } from "../ui/contracts.ts";
import { defineUiPlugin } from "../ui/define.ts";
import { LogIcon, XIcon } from "../ui/parts.tsx";
import styles from "./event-log.css?inline";

const PANEL = "devtools.events";
/** Lines kept, newest last; older ones drop off the top. */
const LIMIT = 1000;

/** A line of the log: an event from the stream, or a change in the connection carrying it. */
type Line =
  | { readonly seq: number; readonly at: number; readonly kind: "event"; readonly event: HostEvent; readonly bytes: number }
  | { readonly seq: number; readonly at: number; readonly kind: "conn"; readonly status: ConnectionStatus };

/** What a line is about, for its colour. */
const category = (line: Line): string => {
  if (line.kind === "conn") return "conn";
  const event = line.event;
  if (event.type === "notice") return `notice-${event.notice.level}`;
  if (event.type === "delta" || event.type === "tool-output") return "delta";
  if (event.type.startsWith("session")) return "session";
  if (event.type.startsWith("turn")) return "turn";
  if (event.type.startsWith("interaction")) return "interaction";
  return "host";
};

const typeOf = (line: Line): string => (line.kind === "conn" ? "connection" : line.event.type);

const sessionOf = (line: Line): string | undefined => {
  if (line.kind === "conn") return undefined;
  const event = line.event;
  if ("sessionId" in event) return event.sessionId;
  if (event.type === "session-changed") return event.info.id;
  return undefined;
};

/** The line's message, as `lemma events` prints it. */
const describe = (line: Line): string => {
  if (line.kind === "conn") {
    const { state, generation, attempts, error } = line.status;
    return `${state} · generation ${generation}${attempts > 0 ? ` · attempt ${attempts}` : ""}${error === undefined ? "" : ` · ${error}`}`;
  }
  const event = line.event;
  switch (event.type) {
    case "notice":
      return `${event.notice.level}${event.notice.source === undefined ? "" : ` ${event.notice.source}:`} ${event.notice.message}`;
    case "delta":
      return `${event.event.type}${event.event.type === "text-delta" ? ` ${JSON.stringify(event.event.delta)}` : ""} · turn ${event.turnId} step ${event.stepId}`;
    case "tool-output":
      return `${JSON.stringify(event.chunk.length > 80 ? `${event.chunk.slice(0, 80)}…` : event.chunk)} · call ${event.toolCallId}`;
    case "session-appended":
      return `#${event.event.seq} ${event.event.data.type} ${event.event.id}`;
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
    case "interaction":
      return `${event.request.id} ${event.request.type}: ${event.request.title}`;
    case "interaction-closed":
      return event.id;
    case "plugins-changed":
      return event.plugins.map((plugin) => `${plugin.id}=${plugin.state}`).join(" ");
    case "commands-changed":
      return event.commands.map((command) => command.id).join(" ");
    case "models-changed":
      return "list them again";
    case "harnesses-changed":
      return event.harnesses.map((harness) => `${harness.id}=${harness.status.state}`).join(" ");
    case "ui-changed":
      return `${Object.keys(event.ui.plugins).length} rows · files ${event.ui.files.map((file) => file.name).join(" ") || "none"}`;
  }
};

const pad = (n: number, width: number) => String(n).padStart(width, "0");
const clock = (at: number) => {
  const time = new Date(at);
  return `${pad(time.getHours(), 2)}:${pad(time.getMinutes(), 2)}:${pad(time.getSeconds(), 2)}.${pad(time.getMilliseconds(), 3)}`;
};
const gap = (ms: number) => (ms < 1000 ? `+${ms}ms` : ms < 60_000 ? `+${(ms / 1000).toFixed(1)}s` : `+${Math.round(ms / 60_000)}m`);
const size = (bytes: number) => (bytes < 1024 ? `${bytes}B` : `${(bytes / 1024).toFixed(1)}K`);

/**
 * This page's subscription to `Host.Events` over the WebSocket, as a log: one
 * row per event with its time, the gap since the one before, its type,
 * session, and size, and changes in the connection itself. Follows the tail
 * while scrolled to the bottom; a row selected opens its raw JSON, and a
 * session its thread's trajectory.
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
      if (!deltas() && line.kind === "event" && (line.event.type === "delta" || line.event.type === "tool-output")) return false;
      if (words.length === 0) return true;
      const text = `${typeOf(line)} ${sessionOf(line) ?? ""} ${describe(line)}`.toLowerCase();
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
            placeholder="Filter: type, session, or text; -word excludes"
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
                <th style={{ width: "150px" }}>Type</th>
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
                    <td colSpan={6} class="dt-muted">
                      {props.lines().length === 0 ? "Waiting for events…" : "No events match"}
                    </td>
                  </tr>
                }
              >
                {(line, index) => {
                  const before = () => shown()[index() - 1];
                  return (
                    <tr data-row data-selected={selected() === line.seq} onClick={() => setSelected(selected() === line.seq ? undefined : line.seq)}>
                      <td class="dt-code dt-muted">{clock(line.at)}</td>
                      <td class="dt-code dt-muted dt-num">{before() === undefined ? "" : gap(line.at - before()!.at)}</td>
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
                <span class="dt-muted">{clock(line.at)}</span>
                <button class="dt-close" style={{ "margin-left": "auto" }} aria-label="Close details" onClick={() => setSelected(undefined)}>
                  <XIcon />
                </button>
              </div>
              <div class="dt-side-body">
                <pre class="dt-pre">{JSON.stringify(line.kind === "event" ? line.event : line.status, null, 2)}</pre>
              </div>
            </aside>
          )}
        </Show>
      </div>
      <div class="dt-status" role="status">
        <span>
          <span class={`dt-dot ${state() === "connected" ? "dt-ok" : state() === "closed" ? "dt-err" : "dt-warn"}`} />
          Host.Events · {state()} · gen {props.client.status().generation}
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
 * Records the host's event stream, and the connection carrying it, from when
 * it starts, and shows it as the devtools' Host events panel.
 */
export default defineUiPlugin({
  id: "event-log",
  styles,
  requires: { client: Client, devtools: Devtools, router: Router, slots: Slots },
  setup: ({ client, devtools, router, slots }, plugin) => {
    const [lines, setLines] = createSignal<readonly Line[]>([]);
    let seq = 0;
    const push = (line: Line) => setLines((current) => [...(current.length >= LIMIT ? current.slice(current.length - LIMIT + 1) : current), line]);
    plugin.onCleanup(client.onEvent((event) => push({ seq: ++seq, at: Date.now(), kind: "event", event, bytes: JSON.stringify(event).length })));
    let last: string | undefined;
    plugin.onCleanup(
      client.host.onStatus((status) => {
        // One line per change of state or generation, not per retry countdown.
        const key = `${status.state}:${status.generation}`;
        if (key === last) return;
        last = key;
        push({ seq: ++seq, at: Date.now(), kind: "conn", status });
      }),
    );
    plugin.onCleanup(
      slots.add(DevtoolsPanels, {
        id: PANEL,
        order: 15,
        title: "Host events",
        component: () => <EventLog client={client} router={router} lines={lines} clear={() => setLines([])} />,
        snapshot: () => lines().map((line) => ({ at: line.at, type: typeOf(line), session: sessionOf(line), message: describe(line) })),
      }),
    );
    plugin.onCleanup(
      slots.add(Actions, {
        id: ActionIds.eventLog,
        order: 10,
        title: "Show host events",
        category: "Developer",
        keywords: ["debug", "events", "stream", "log", "devtools"],
        icon: LogIcon,
        run: () => devtools.show(PANEL),
      }),
    );
  },
});
