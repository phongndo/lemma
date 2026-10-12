import { For, Show, createMemo, createSignal, onMount } from "solid-js";
import type { Accessor } from "solid-js";
import type { SpanRecord } from "@lemma/contracts";
import { DevtoolsPanels } from "@lemma/devtools/web";
import { Client, defineWebPlugin, PageTrace, Slots, usePlugin } from "@lemma/web";
import type { ClientService, PageTraceService } from "@lemma/web";
import { clockTime } from "@lemma/web/format";
import { createTrace, hostTrace, pageTrace } from "./model.ts";
import type { TraceSource } from "./model.ts";

/** How many rows the table draws: the newest that match. */
const ROWS = 500;

const pluginOf = (span: SpanRecord) => span.attributes["plugin.id"];

/** A trace's spans, newest first, and its composition's changes. */
function TraceView(props: { source: TraceSource }) {
  const plugin = usePlugin();
  const trace = createTrace(props.source);
  onMount(plugin.action("read the trace", trace.refresh));
  const [query, setQuery] = createSignal("");
  const shown = createMemo(() => {
    const words = query().trim().toLowerCase().split(/\s+/).filter(Boolean);
    const found: SpanRecord[] = [];
    const spans = trace.spans();
    for (let index = spans.length - 1; index >= 0 && found.length < ROWS; index--) {
      const span = spans[index]!;
      const text = `${span.name} ${String(pluginOf(span) ?? "")} ${span.status}`.toLowerCase();
      if (words.every((word) => text.includes(word))) found.push(span);
    }
    return found;
  });
  return (
    <div class="dt-scope" aria-label="Trace">
      <div class="dt-toolbar" role="toolbar" aria-label="Trace toolbar">
        <label class="dt-filter">
          <input
            placeholder="Filter: span, plugin, or status"
            aria-label="Filter spans"
            autocomplete="off"
            spellcheck={false}
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
        <button class="dt-chip" onClick={plugin.action("read the trace", () => trace.refresh())}>
          Refresh
        </button>
        <span class="dt-sep" />
        <span class="dt-muted">
          {trace.spans().length} spans · {trace.changes().length} composition changes
        </span>
        <Show when={trace.error()}>{(error) => <span class="dt-error">{error()}</span>}</Show>
      </div>
      <div class="dt-main" tabindex="-1">
        <table class="dt-table" aria-label="Spans">
          <thead>
            <tr>
              <th style={{ width: "96px" }}>Ended</th>
              <th>Span</th>
              <th>Plugin</th>
              <th style={{ width: "80px" }}>ms</th>
              <th style={{ width: "80px" }}>Status</th>
            </tr>
          </thead>
          <tbody>
            <For
              each={shown()}
              fallback={
                <tr>
                  <td colSpan={5} class="dt-muted">
                    {trace.spans().length === 0 ? "No spans yet" : "No spans match"}
                  </td>
                </tr>
              }
            >
              {(span) => (
                <tr data-row title={span.error}>
                  <td class="dt-muted">{clockTime(span.start + span.ms)}</td>
                  <td class="dt-code">{span.name}</td>
                  <td>{String(pluginOf(span) ?? "")}</td>
                  <td class="dt-num">{span.ms.toFixed(2)}</td>
                  <td classList={{ "dt-error": span.status === "error" }}>{span.status}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** The host's trace, or the page's. */
function TracePanel(props: { client: ClientService; page: PageTraceService }) {
  const [which, setWhich] = createSignal<"host" | "page">("host");
  const sources: Record<"host" | "page", Accessor<TraceSource>> = {
    host: createMemo(() => hostTrace(props.client)),
    page: createMemo(() => pageTrace(props.page)),
  };
  return (
    <div class="dt-scope" aria-label="Trace panel">
      <div class="dt-toolbar" role="tablist" aria-label="Which trace">
        <For each={["host", "page"] as const}>
          {(name) => (
            <button role="tab" class="dt-chip" aria-selected={which() === name} onClick={() => setWhich(name)}>
              {name === "host" ? "Host" : "Page"}
            </button>
          )}
        </For>
      </div>
      <Show when={which()} keyed>
        {(name) => <TraceView source={sources[name]()} />}
      </Show>
    </div>
  );
}

/** The web half of `devtools.trace`: the host's trace, and the page's, as a devtools panel. It runs while the host half does. */
export default defineWebPlugin({
  id: "devtools.trace",
  requires: { slots: Slots, client: Client, page: PageTrace },
  setup: ({ slots, client, page }) => {
    slots.add(DevtoolsPanels, { id: "devtools.trace", title: "Trace", component: () => <TracePanel client={client} page={page} /> });
  },
});
