import { For, Match, Show, Switch, createComputed, createMemo, createSignal, on, onMount } from "solid-js";
import type { Accessor, JSX } from "solid-js";
import type { PluginStatus, SpanRecord } from "@lemma/contracts";
import { Devtools, DevtoolsPanels, PLUGIN_PANEL, TRACE_PANEL } from "@lemma/devtools/web";
import type { DevtoolsService } from "@lemma/devtools/web";
import { ThreadRoute } from "@lemma/sessions";
import type { LedgerRecord } from "@lemma/sessions";
import { TrajectoryActions } from "@lemma/threads";
import { Client, defineWebPlugin, HostPlugins, PageTrace, Router, Slots, usePlugin, WebPlugins } from "@lemma/web";
import type { ClientService, PageTraceService, PluginsService, RouterService } from "@lemma/web";
import { clockTime } from "@lemma/web/format";
import { createTrace, hostTrace, pageTrace } from "./model.ts";
import type { TraceModel, TraceSource } from "./model.ts";
import { matcher, narrowedBy, parseQuery, turnOrder } from "./query.ts";
import { contains, flatten, forest, profile } from "./tree.ts";
import type { SpanNode } from "./tree.ts";
import styles from "./trace.css?inline";

/** How many traces (root spans) the list draws: the newest that match. */
const ROOTS = 200;

type Which = "host" | "page";
type Mode = "spans" | "plugins" | "changes" | "faults";
const MODES: readonly { readonly id: Mode; readonly label: string }[] = [
  { id: "spans", label: "Spans" },
  { id: "plugins", label: "Plugins" },
  { id: "changes", label: "Changes" },
  { id: "faults", label: "Faults" },
];

/** What the panel shows: kept by the plugin, so the panel drawn again (another tab, then this one) shows it still. */
interface PanelState {
  readonly which: Accessor<Which>;
  readonly setWhich: (which: Which) => void;
  readonly mode: Accessor<Mode>;
  readonly setMode: (mode: Mode) => void;
  readonly query: Accessor<string>;
  readonly setQuery: (query: string) => void;
}

interface Deps {
  readonly state: PanelState;
  readonly client: ClientService;
  readonly page: PageTraceService;
  readonly devtools: DevtoolsService;
  readonly router: RouterService;
  readonly host: PluginsService;
  readonly web: PluginsService;
}

/** A time with its unit: milliseconds below a second, seconds from there. */
const ms = (value: number) => (value < 10 ? `${value.toFixed(2)} ms` : value < 1000 ? `${value.toFixed(1)} ms` : `${(value / 1000).toFixed(2)} s`);
const pluginOf = (span: SpanRecord) => (typeof span.attributes["plugin.id"] === "string" ? (span.attributes["plugin.id"] as string) : undefined);

/** What the panel shares between its views: the trace shown, its filter, and the span selected. */
interface Shown {
  readonly which: Which;
  readonly trace: TraceModel;
  readonly query: Accessor<string>;
  readonly setQuery: (query: string) => void;
  readonly setMode: (mode: Mode) => void;
  readonly selected: Accessor<string | undefined>;
  readonly select: (id: string | undefined) => void;
  readonly deps: Deps;
}

/** A plugin's id, linking to it in the Plugins panel. */
function PluginLink(props: { shown: Shown; id: string | undefined }) {
  return (
    <Show when={props.id} fallback={<span class="dt-muted">—</span>}>
      {(id) => (
        <button
          class="dt-link"
          onClick={(event) => {
            event.stopPropagation();
            props.shown.deps.devtools.show(PLUGIN_PANEL, `${props.shown.which === "host" ? "host" : "web"}:${id()}`);
          }}
        >
          {id()}
        </button>
      )}
    </Show>
  );
}

/** The selected span: its timing, its attributes, and where it leads. */
function SpanDetails(props: { shown: Shown; span: SpanRecord }) {
  const span = () => props.span;
  const attribute = (key: string) => (typeof span().attributes[key] === "string" ? (span().attributes[key] as string) : undefined);
  const narrow = (query: string) => {
    props.shown.setQuery(query);
    props.shown.select(undefined);
  };
  return (
    <aside class="dt-details dt-side" aria-label="Span details">
      <div class="dt-details-title">
        <strong class="dt-code">{span().name}</strong>
      </div>
      <div class="dt-side-body">
        <dl class="dt-facts">
          <dt>Span</dt>
          <dd class="dt-code">{span().name}</dd>
          <dt>Plugin</dt>
          <dd>
            <PluginLink shown={props.shown} id={pluginOf(span())} />
          </dd>
          <dt>Started</dt>
          <dd>{clockTime(span().start)}</dd>
          <dt>Took</dt>
          <dd>{ms(span().ms)}</dd>
          <dt>Status</dt>
          <dd classList={{ "dt-err": span().status === "error" }}>{span().status}</dd>
          <Show when={span().error}>
            <dt>Error</dt>
            <dd class="dt-err">{span().error}</dd>
          </Show>
        </dl>
        <div class="dt-toolbar" role="toolbar" aria-label="Narrow the trace">
          <Show when={attribute("session.id")}>
            {(session) => (
              <a class="dt-chip" href={props.shown.deps.router.href(ThreadRoute, { id: session(), view: "trajectory" })}>
                Thread's trajectory
              </a>
            )}
          </Show>
          <Show when={attribute("turn.id")}>
            {(turn) => (
              <button class="dt-chip" onClick={() => narrow(`turn:${turn()}`)}>
                This turn
              </button>
            )}
          </Show>
          <Show when={attribute("tool.call.id")}>
            {(call) => (
              <button class="dt-chip" onClick={() => narrow(`tool:${call()}`)}>
                This tool call
              </button>
            )}
          </Show>
          <Show when={pluginOf(span())}>
            {(plugin) => (
              <button class="dt-chip" onClick={() => narrow(`plugin:${plugin()}`)}>
                This plugin
              </button>
            )}
          </Show>
        </div>
        <table class="dt-table" aria-label="Attributes">
          <tbody>
            <For each={Object.entries(span().attributes).sort(([a], [b]) => a.localeCompare(b))}>
              {([key, value]) => (
                <tr>
                  <td class="dt-code">{key}</td>
                  <td class="dt-code">{String(value)}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
    </aside>
  );
}

/** The spans under a trace's root, as a waterfall: each span's bar where it ran within the trace. */
function Waterfall(props: { shown: Shown; root: SpanNode; matches: (span: SpanRecord) => boolean }) {
  const rows = createMemo(() => flatten(props.root).slice(1));
  const start = () => props.root.span.start;
  const width = () => Math.max(props.root.span.ms, 0.001);
  return (
    <For each={rows()}>
      {({ node, depth }) => (
        <tr
          data-row
          data-selected={props.shown.selected() === node.span.id}
          classList={{ "trc-dim": !props.matches(node.span) }}
          onClick={() => props.shown.select(props.shown.selected() === node.span.id ? undefined : node.span.id)}
        >
          <td class="dt-code trc-name" style={{ "padding-left": `${6 + depth * 14}px` }} title={node.span.error}>
            {node.span.name}
          </td>
          <td>
            <PluginLink shown={props.shown} id={pluginOf(node.span)} />
          </td>
          <td class="dt-num">{ms(node.span.ms)}</td>
          <td class="trc-bar-cell" aria-hidden="true">
            <div
              class="trc-bar"
              classList={{ "trc-bar-error": node.span.status === "error" }}
              style={{ left: `${((node.span.start - start()) / width()) * 100}%`, width: `${Math.max(0.5, (node.span.ms / width()) * 100)}%` }}
            />
          </td>
        </tr>
      )}
    </For>
  );
}

/** The traces that hold a span the filter picks, newest first; one opened shows its waterfall. */
function SpansView(props: { shown: Shown }) {
  const spans = () => props.shown.trace.spans();
  const matches = createMemo(() => matcher(parseQuery(props.shown.query()), turnOrder(spans())));
  // A trace whose spans did not change keeps its node, so its row and open waterfall are not drawn again each batch.
  let kept = new Map<string, SpanNode>();
  const roots = createMemo(() => {
    const steady = forest(spans()).map((root) => {
      const before = kept.get(root.span.id);
      return before !== undefined && before.span === root.span && before.size === root.size ? before : root;
    });
    kept = new Map(steady.map((root) => [root.span.id, root]));
    return steady;
  });
  const shown = createMemo(() => {
    const found: SpanNode[] = [];
    const all = roots();
    for (let index = all.length - 1; index >= 0 && found.length < ROOTS; index--) if (contains(all[index]!, matches())) found.push(all[index]!);
    return found;
  });
  const [open, setOpen] = createSignal<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((was) => {
      const next = new Set(was);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const selected = createMemo(() => spans().find((span) => span.id === props.shown.selected()));
  return (
    <div class="dt-split">
      <div class="dt-main" tabindex="-1">
        <table class="dt-table trc-table" aria-label="Spans">
          <thead>
            <tr>
              <th>Span</th>
              <th style={{ width: "160px" }}>Plugin</th>
              <th style={{ width: "80px" }} class="dt-num">
                Took
              </th>
              <th style={{ width: "34%" }}>When, within its trace</th>
            </tr>
          </thead>
          <tbody>
            <For
              each={shown()}
              fallback={
                <tr>
                  <td colSpan={4} class="dt-muted">
                    {spans().length === 0 ? "No spans yet" : "No spans match"}
                  </td>
                </tr>
              }
            >
              {(root) => (
                <>
                  <tr
                    data-row
                    data-selected={props.shown.selected() === root.span.id}
                    onClick={() => {
                      // Opens its waterfall and shows its details; again, closes both.
                      const closing = open().has(root.span.id) && props.shown.selected() === root.span.id;
                      if (closing || !open().has(root.span.id)) toggle(root.span.id);
                      props.shown.select(closing ? undefined : root.span.id);
                    }}
                  >
                    <td class="dt-code trc-name" title={root.span.error}>
                      <span class="trc-caret">{open().has(root.span.id) ? "▾" : "▸"}</span>
                      {root.span.name}
                      <Show when={root.children.length > 0}>
                        <span class="dt-muted"> · {root.size - 1} under it</span>
                      </Show>
                    </td>
                    <td>
                      <PluginLink shown={props.shown} id={pluginOf(root.span)} />
                    </td>
                    <td class="dt-num" classList={{ "dt-err": root.span.status === "error" }}>
                      {ms(root.span.ms)}
                    </td>
                    <td class="dt-muted">{clockTime(root.span.start)}</td>
                  </tr>
                  <Show when={open().has(root.span.id)}>
                    <Waterfall shown={props.shown} root={root} matches={matches()} />
                  </Show>
                </>
              )}
            </For>
          </tbody>
        </table>
      </div>
      <Show when={selected()} keyed>
        {(span) => <SpanDetails shown={props.shown} span={span} />}
      </Show>
    </div>
  );
}

/** Each plugin's spans: how many, their time, their own time, the slowest, and how many failed. */
function PluginsView(props: { shown: Shown }) {
  // The trees of every span, so a span's own time leaves out its children though the filter does not pick them.
  const rows = createMemo(() => {
    const spans = props.shown.trace.spans();
    return profile(forest(spans), matcher(parseQuery(props.shown.query()), turnOrder(spans)));
  });
  return (
    <div class="dt-main" tabindex="-1">
      <table class="dt-table" aria-label="Plugins by time">
        <thead>
          <tr>
            <th>Plugin</th>
            <th class="dt-num">Spans</th>
            <th class="dt-num">Own</th>
            <th class="dt-num">Total</th>
            <th class="dt-num">p95</th>
            <th class="dt-num">Max</th>
            <th>Slowest</th>
            <th class="dt-num">Failed</th>
          </tr>
        </thead>
        <tbody>
          <For
            each={rows()}
            fallback={
              <tr>
                <td colSpan={8} class="dt-muted">
                  No plugin's spans match
                </td>
              </tr>
            }
          >
            {(row) => (
              <tr
                data-row
                onClick={() => {
                  props.shown.setQuery(narrowedBy(props.shown.query(), "plugin", row.plugin));
                  props.shown.setMode("spans");
                }}
              >
                <td>
                  <PluginLink shown={props.shown} id={row.plugin} />
                </td>
                <td class="dt-num">{row.spans}</td>
                <td class="dt-num">{ms(row.self)}</td>
                <td class="dt-num">{ms(row.total)}</td>
                <td class="dt-num">{ms(row.p95)}</td>
                <td class="dt-num">{ms(row.max)}</td>
                <td class="dt-code">{row.slowest}</td>
                <td class="dt-num" classList={{ "dt-err": row.errors > 0 }}>
                  {row.errors}
                </td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  );
}

const ids = (list: readonly string[]): JSX.Element => (list.length === 0 ? <span class="dt-muted">—</span> : list.join(", "));

/** The composition's changes, newest first: what each started, stopped, and restarted, or why it was refused. */
function ChangesView(props: { shown: Shown }) {
  return (
    <div class="dt-main" tabindex="-1">
      <table class="dt-table" aria-label="Composition changes">
        <thead>
          <tr>
            <th style={{ width: "96px" }}>When</th>
            <th style={{ width: "84px" }}>Cause</th>
            <th>Started</th>
            <th>Stopped</th>
            <th>Restarted</th>
            <th>Failed</th>
          </tr>
        </thead>
        <tbody>
          <For
            each={props.shown.trace.changes()}
            fallback={
              <tr>
                <td colSpan={6} class="dt-muted">
                  No changes yet
                </td>
              </tr>
            }
          >
            {(change) => (
              <tr data-row title={change.subjects?.join(", ")}>
                <td class="dt-muted">{clockTime(change.at)}</td>
                <td>{change.cause}</td>
                <Show
                  when={change.refused === undefined}
                  fallback={
                    <td colSpan={4} class="dt-err">
                      Refused: {change.refused}
                    </td>
                  }
                >
                  <td>{ids(change.started)}</td>
                  <td>{ids(change.stopped)}</td>
                  <td>{ids(change.restarted)}</td>
                  <td classList={{ "dt-err": change.failed.length > 0 }}>{ids(change.failed)}</td>
                </Show>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  );
}

/** What went wrong: each plugin's recent faults, and the spans that failed. */
function FaultsView(props: { shown: Shown; plugins: Accessor<readonly PluginStatus[]> }) {
  const faults = createMemo(() =>
    props
      .plugins()
      .flatMap((plugin) => (plugin.faults ?? []).map((fault) => ({ plugin: plugin.id, fault })))
      .sort((a, b) => b.fault.at - a.fault.at),
  );
  const failed = createMemo(() =>
    props.shown.trace
      .spans()
      .filter((span) => span.status === "error")
      .reverse(),
  );
  return (
    <div class="dt-main" tabindex="-1">
      <table class="dt-table" aria-label="Plugin faults">
        <thead>
          <tr>
            <th style={{ width: "96px" }}>When</th>
            <th style={{ width: "180px" }}>Plugin</th>
            <th style={{ width: "140px" }}>Where</th>
            <th>Fault</th>
          </tr>
        </thead>
        <tbody>
          <For
            each={faults()}
            fallback={
              <tr>
                <td colSpan={4} class="dt-muted">
                  No plugin has faulted
                </td>
              </tr>
            }
          >
            {({ plugin, fault }) => (
              <tr data-row>
                <td class="dt-muted">{clockTime(fault.at)}</td>
                <td>
                  <PluginLink shown={props.shown} id={plugin} />
                </td>
                <td class="dt-code">{fault.operation ?? fault.phase}</td>
                <td class="dt-err">{fault.message}</td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
      <table class="dt-table" aria-label="Failed spans">
        <thead>
          <tr>
            <th style={{ width: "96px" }}>When</th>
            <th style={{ width: "180px" }}>Plugin</th>
            <th style={{ width: "140px" }}>Span</th>
            <th>Error</th>
          </tr>
        </thead>
        <tbody>
          <For
            each={failed()}
            fallback={
              <tr>
                <td colSpan={4} class="dt-muted">
                  No span the trace kept failed
                </td>
              </tr>
            }
          >
            {(span) => (
              <tr
                data-row
                onClick={() => {
                  props.shown.setQuery(span.attributes["turn.id"] === undefined ? "status:error" : `turn:${String(span.attributes["turn.id"])}`);
                  props.shown.select(span.id);
                  props.shown.setMode("spans");
                }}
              >
                <td class="dt-muted">{clockTime(span.start)}</td>
                <td>
                  <PluginLink shown={props.shown} id={pluginOf(span)} />
                </td>
                <td class="dt-code">{span.name}</td>
                <td class="dt-err">{span.error ?? "failed"}</td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  );
}

/** One trace (the host's or the page's) in one of its views. */
function TraceView(props: {
  which: Which;
  source: TraceSource;
  deps: Deps;
  mode: Accessor<Mode>;
  setMode: (mode: Mode) => void;
  query: Accessor<string>;
  setQuery: (query: string) => void;
}) {
  const plugin = usePlugin();
  const trace = createTrace(props.source);
  onMount(plugin.action("read the trace", trace.refresh));
  const [selected, select] = createSignal<string>();
  const shown: Shown = {
    which: props.which,
    trace,
    query: props.query,
    setQuery: props.setQuery,
    setMode: props.setMode,
    selected,
    select,
    deps: props.deps,
  };
  return (
    <>
      <div class="dt-toolbar" role="toolbar" aria-label="Trace toolbar">
        <label class="dt-filter">
          <input
            placeholder="Filter: plugin:tools turn:2 slow:>5ms status:error …"
            aria-label="Filter spans"
            autocomplete="off"
            spellcheck={false}
            value={props.query()}
            onInput={(event) => props.setQuery(event.currentTarget.value)}
          />
        </label>
        <button class="dt-chip" onClick={plugin.action("read the trace", () => trace.refresh())}>
          Refresh
        </button>
        <span class="dt-sep" />
        <span class="dt-muted">
          {trace.spans().length} spans · {trace.changes().length} changes
        </span>
        <Show when={trace.error()}>{(error) => <span class="dt-err">{error()}</span>}</Show>
      </div>
      <Switch>
        <Match when={props.mode() === "spans"}>
          <SpansView shown={shown} />
        </Match>
        <Match when={props.mode() === "plugins"}>
          <PluginsView shown={shown} />
        </Match>
        <Match when={props.mode() === "changes"}>
          <ChangesView shown={shown} />
        </Match>
        <Match when={props.mode() === "faults"}>
          <FaultsView shown={shown} plugins={props.which === "host" ? props.deps.host.list : props.deps.web.list} />
        </Match>
      </Switch>
    </>
  );
}

/** The host's trace, or the page's, in the view picked (`PanelState`). */
function TracePanel(props: { deps: Deps }) {
  const { which, setWhich, mode, setMode, query, setQuery } = props.deps.state;
  const sources: Record<Which, Accessor<TraceSource>> = {
    host: createMemo(() => hostTrace(props.deps.client)),
    page: createMemo(() => pageTrace(props.deps.page)),
  };
  return (
    <div class="dt-scope trc" aria-label="Trace panel">
      <div class="dt-toolbar" role="toolbar" aria-label="Which trace">
        <For each={["host", "page"] as const}>
          {(name) => (
            <button class="dt-chip" aria-pressed={which() === name} onClick={() => setWhich(name)}>
              {name === "host" ? "Host" : "Page"}
            </button>
          )}
        </For>
        <span class="dt-sep" />
        <For each={MODES}>
          {(entry) => (
            <button class="dt-chip" aria-pressed={mode() === entry.id} onClick={() => setMode(entry.id)}>
              {entry.label}
            </button>
          )}
        </For>
      </div>
      <Show when={which()} keyed>
        {(name) => <TraceView which={name} source={sources[name]()} deps={props.deps} mode={mode} setMode={setMode} query={query} setQuery={setQuery} />}
      </Show>
    </div>
  );
}

/** The trace a trajectory record's work left: its tool call's, or its step's. */
const subjectOf = (record: LedgerRecord): string | undefined =>
  record.kind === "tool" ? `tool:${record.run.call.id}` : record.kind === "assistant" ? `step:${record.step.stepId}` : undefined;

/**
 * The web half of `devtools.trace`: the host's trace, and the page's, as a devtools panel, and a way there from a
 * trajectory's records. It runs while the host half does.
 */
export default defineWebPlugin({
  id: "devtools.trace",
  styles,
  requires: {
    slots: Slots,
    client: Client,
    page: PageTrace,
    devtools: Devtools,
    router: Router,
    host: HostPlugins,
    web: WebPlugins,
  },
  setup: ({ slots, client, page, devtools, router, host, web }) => {
    const [which, setWhich] = createSignal<Which>("host");
    const [mode, setMode] = createSignal<Mode>("spans");
    const [query, setQuery] = createSignal("");
    const state: PanelState = { which, setWhich, mode, setMode, query, setQuery };
    /** A subject: `trace:page` picks the page's trace (the host's otherwise), and the rest is the filter. */
    const take = (asked: string) => {
      const words = asked.split(/\s+/);
      setWhich(words.includes("trace:page") ? "page" : "host");
      setMode("spans");
      setQuery(words.filter((word) => !word.startsWith("trace:")).join(" "));
    };
    // One the devtools are shown with is taken when it changes, before the panel draws: drawn again, it keeps its state.
    const subject = createMemo(() => devtools.subject(TRACE_PANEL));
    createComputed(on(subject, (asked) => asked !== undefined && take(asked)));
    const deps: Deps = { state, client, page, devtools, router, host, web };
    // After the dock's own panels (the inspectors are at 50).
    slots.add(DevtoolsPanels, { id: TRACE_PANEL, order: 60, title: "Trace", component: () => <TracePanel deps={deps} /> });
    slots.add(TrajectoryActions, {
      id: "devtools.trace.show",
      label: "Show in trace",
      when: (record) => subjectOf(record) !== undefined,
      // Taken here too: the same record asked again, after the filter changed, shows it again.
      run: (record) => {
        take(subjectOf(record)!);
        devtools.show(TRACE_PANEL, subjectOf(record)!);
      },
    });
  },
});
