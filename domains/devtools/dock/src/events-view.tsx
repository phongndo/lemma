import { For, Show, createEffect, createMemo, createSignal, on } from "solid-js";
import type { Accessor } from "solid-js";
import { ThreadRoute } from "@lemma/sessions";
import { clockTime } from "@lemma/web/format";
import type { ClientService, RouterService } from "@lemma/web";
import { XIcon } from "@lemma/look";
import { rowKeys } from "./rows.ts";
import { HOST_EVENTS, category, describe, sessionOf, streamOf, typeOf } from "./events.tsx";
import type { Line } from "./events.tsx";

/* The Host events panel's view (see `hostEventsPanel`), loaded the first time the devtools draw one of their own panels. */

const gap = (ms: number) => (ms < 1000 ? `+${ms}ms` : ms < 60_000 ? `+${(ms / 1000).toFixed(1)}s` : `+${Math.round(ms / 60_000)}m`);
const size = (bytes: number) => (bytes < 1024 ? `${bytes}B` : `${(bytes / 1024).toFixed(1)}K`);

/**
 * What this page hears from the host, as a log: the host's own events
 * (`Host.Events`), the domains' streams while the devtools are open (their
 * changes, and the agent's activity), and changes in the connection carrying
 * them. One row per element with its time, the gap since the one before, its
 * stream and type, session, and size. Follows the tail while scrolled to the
 * bottom; a row selected opens its raw JSON, and a session its thread's
 * trajectory.
 */
export function EventLog(props: { client: ClientService; router: RouterService; lines: Accessor<readonly Line[]>; clear: () => void }) {
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
          <table
            class="dt-table log-table"
            aria-label="Events"
            role="grid"
            tabindex="0"
            onKeyDown={rowKeys(
              (key) => setSelected(Number(key)),
              () => setSelected(undefined),
            )}
          >
            <thead>
              <tr>
                <th class="devtools-log-time">Time</th>
                <th class="devtools-log-gap">Gap</th>
                <th class="devtools-log-stream">Stream</th>
                <th class="devtools-log-stream">Type</th>
                <th class="devtools-log-session">Session</th>
                <th class="devtools-log-size">Size</th>
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
                    <tr
                      data-row
                      data-key={line.seq}
                      data-selected={selected() === line.seq}
                      aria-selected={selected() === line.seq}
                      tabindex="-1"
                      onClick={() => setSelected(selected() === line.seq ? undefined : line.seq)}
                    >
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
                <button class="dt-close devtools-end" aria-label="Close details" onClick={() => setSelected(undefined)}>
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
