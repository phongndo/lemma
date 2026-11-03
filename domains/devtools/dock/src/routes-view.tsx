import { For, Show, createMemo, createSignal } from "solid-js";
import type { RouterEvent, RouteVerdict } from "@lemma/router";
import { clockTime } from "@lemma/web/format";
import { Chips, clearsOnEscape, FilterField, PLUGIN_PANEL, SelectableTable } from "@lemma/devtools/web";
import { Pages } from "@lemma/web";
import type { RouterService, SlotsService } from "@lemma/web";
import type { DevtoolsService } from "@lemma/devtools/web";
import { Details, Section } from "./parts.tsx";

/* The router's panels' views (see `routePanels`), loaded the first time the devtools draw one of their own panels. */

const VERDICT_CLASS: Readonly<Record<RouteVerdict["outcome"], string>> = {
  shown: "dt-ok",
  unavailable: "dt-warn",
  outranked: "",
  rejected: "dt-err",
  "no-match": "dt-muted",
};

/** Where an event happened, and what it did there. */
const addressOf = (event: RouterEvent): string =>
  event.kind === "matched" ? event.match.href : event.kind === "failed" || event.kind === "issue" ? "" : event.href;
const detailOf = (event: RouterEvent): string => {
  switch (event.kind) {
    case "navigate":
      return `${event.action}${event.held ? ", after a back or forward landed" : ""}`;
    case "blocked":
      return `${event.action} refused by ${event.by}`;
    case "moved":
      return `${event.delta < 0 ? "back" : "forward"} ${Math.abs(event.delta) || "?"}`;
    case "matched":
      return `${event.match.status}${event.match.route === undefined ? "" : ` ${event.match.route}`}${event.match.entry === undefined ? "" : ` · ${event.match.entry}`}`;
    case "failed":
      return `${event.during}: ${event.message}`;
    case "issue":
      return event.message;
  }
};
const KIND_CLASS: Readonly<Record<RouterEvent["kind"], string>> = {
  navigate: "",
  matched: "",
  moved: "",
  blocked: "dt-warn",
  failed: "dt-err",
  issue: "dt-warn",
};

/** A plugin's name: opens it in the devtools' Plugins panel. */
function PluginLink(props: { devtools: DevtoolsService; id: string | undefined }) {
  return (
    <Show when={props.id} fallback={<span class="dt-muted">?</span>}>
      {(id) => (
        <button class="dt-link dt-code" onClick={() => props.devtools.show(PLUGIN_PANEL, `web:${id()}`)}>
          {id()}
        </button>
      )}
    </Show>
  );
}

/**
 * Every route, and its verdict on the address in the toolbar (the current
 * one until another is typed): which shows it and why the others do not. A
 * route selected opens its details.
 */
export function Routes(props: { router: RouterService; slots: SlotsService; devtools: DevtoolsService }) {
  const { router, slots, devtools } = props;
  const snapshot = () => router.inspect();
  const [address, setAddress] = createSignal<string>();
  const [selected, setSelected] = createSignal<string>();
  const explained = createMemo(() => {
    snapshot();
    const href = (address() ?? router.location().href).trim();
    return router.explain(href.startsWith("/") ? href : `/${href}`);
  });
  const verdictOf = (id: string) => explained().verdicts.find((verdict) => verdict.route === id);
  const current = () => snapshot().routes.find((route) => route.id === (selected() ?? explained().route));
  const owner = (entry: string) => slots.owner(Pages, entry);
  return (
    <div class="dt-scope">
      <div class="dt-toolbar" role="toolbar" aria-label="Routes toolbar">
        <FilterField
          class="devtools-routes-address"
          label="Address to explain"
          placeholder={router.location().href}
          value={address() ?? router.location().href}
          onInput={setAddress}
          onKeyDown={clearsOnEscape(
            () => address() ?? "",
            () => setAddress(undefined),
          )}
        >
          <span>Address</span>
        </FilterField>
        <span class="dt-sep" />
        <span>
          <span class={explained().status === "matched" ? "dt-ok" : "dt-warn"}>{explained().status}</span>
          <Show when={explained().route}>{(route) => <span class="dt-muted"> · {route()}</span>}</Show>
        </span>
        <Show when={address() !== undefined}>
          <span class="dt-sep" />
          <button class="dt-chip" onClick={() => setAddress(undefined)}>
            Follow the page
          </button>
        </Show>
      </div>
      <For each={snapshot().issues}>{(issue) => <div class="dt-banner">{issue.message}</div>}</For>
      <div class="dt-split">
        <div class="dt-main" tabindex="-1">
          <SelectableTable
            label="Routes"
            columns={[{ title: "Path" }, { title: "Route" }, { title: "Verdict" }, { title: "Shown by" }, { title: "Plugin" }]}
            rows={snapshot().routes}
            key={(route) => route.id}
            selected={current()?.id}
            onSelect={setSelected}
          >
            {(route) => (
              <>
                <td class="dt-code">{route.path}</td>
                <td>{route.id}</td>
                <td class={VERDICT_CLASS[verdictOf(route.id)?.outcome ?? "no-match"]}>{verdictOf(route.id)?.outcome ?? ""}</td>
                <td class="dt-code">{route.entries[0] ?? <span class="dt-warn">nothing: its plugin is off</span>}</td>
                <td>
                  <Show when={route.entries[0]}>{(entry) => <PluginLink devtools={devtools} id={owner(entry())} />}</Show>
                </td>
              </>
            )}
          </SelectableTable>
        </div>
        <Show when={current()} keyed>
          {(route) => (
            <Details
              label="Route details"
              title={
                <>
                  <strong>{route.id}</strong>
                  <span class="dt-muted dt-code">{route.path}</span>
                </>
              }
            >
              <dl class="dt-facts">
                <dt>Verdict</dt>
                <dd class={VERDICT_CLASS[verdictOf(route.id)?.outcome ?? "no-match"]}>{verdictOf(route.id)?.outcome}</dd>
                <dt>Why</dt>
                <dd>{verdictOf(route.id)?.detail}</dd>
                <dt>For</dt>
                <dd>{explained().href}</dd>
                <dt>Known</dt>
                <dd>{route.known ? "yes: it matches while nothing shows it" : "no"}</dd>
              </dl>
              <Section title="Registered" aside="first shows; the rest are overridden">
                <Show when={route.entries.length > 0} fallback={<p class="dt-muted">Nothing: it shows as unavailable.</p>}>
                  <table class="dt-table">
                    <tbody>
                      <For each={route.entries}>
                        {(entry, index) => (
                          <tr data-row>
                            <td class="dt-code">{entry}</td>
                            <td>
                              <PluginLink devtools={devtools} id={owner(entry)} />
                            </td>
                            <td class="dt-muted">{index() === 0 ? "shown" : "overridden"}</td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </Show>
              </Section>
            </Details>
          )}
        </Show>
      </div>
      <div class="dt-status" role="status">
        <span>{snapshot().routes.length} routes</span>
        <span>{snapshot().issues.length} conflicts</span>
        <span>Blockers: {snapshot().blockers.join(", ") || "none"}</span>
        <span>
          Keeps{" "}
          {snapshot()
            .retain.map((key) => `?${key}`)
            .join(" ") || "nothing"}
        </span>
      </div>
    </div>
  );
}

const KINDS = [
  { id: "all", label: "All" },
  { id: "navigate", label: "Navigations" },
  { id: "matched", label: "Matches" },
  { id: "moved", label: "Back & forward" },
  { id: "blocked", label: "Blocked" },
  { id: "failed", label: "Failed" },
] as const;

/** The router's journal, newest first; an event selected opens it, and otherwise the current history entry. */
export function Navigation(props: { router: RouterService }) {
  const { router } = props;
  const [query, setQuery] = createSignal("");
  const [kind, setKind] = createSignal<(typeof KINDS)[number]["id"]>("all");
  const [selected, setSelected] = createSignal<string>();
  const events = createMemo(() => {
    const words = query().trim().toLowerCase();
    return [...router.journal()]
      .reverse()
      .filter((event) => kind() === "all" || event.kind === kind())
      .filter((event) => words === "" || `${event.kind} ${addressOf(event)} ${detailOf(event)}`.toLowerCase().includes(words));
  });
  const chosen = () => router.journal().find((event) => String(event.seq) === selected());
  const here = () => router.location();
  /** What is kept with this entry; a value set back to nothing (`undefined`) is not kept. */
  const state = () => {
    const kept = Object.entries(router.entryStates()[here().key] ?? {}).filter(([, value]) => value !== undefined);
    return kept.length === 0 ? undefined : Object.fromEntries(kept);
  };
  return (
    <div class="dt-scope">
      <div class="dt-toolbar" role="toolbar" aria-label="Navigation toolbar">
        <FilterField label="Filter the journal" placeholder="Filter" value={query()} onInput={setQuery} />
        <span class="dt-sep" />
        <Chips options={KINDS} value={kind()} onChange={setKind} />
      </div>
      <div class="dt-split">
        <div class="dt-main" tabindex="-1">
          <SelectableTable
            label="Router journal"
            columns={[
              { title: "Time", class: "devtools-journal-time" },
              { title: "At", class: "devtools-journal-at dt-num" },
              { title: "Event", class: "devtools-journal-event" },
              { title: "Address" },
              { title: "Details" },
            ]}
            rows={events()}
            key={(event) => String(event.seq)}
            selected={selected()}
            onSelect={setSelected}
            onClear={() => setSelected(undefined)}
            empty="Nothing yet"
          >
            {(event) => (
              <>
                <td class="dt-code dt-muted">{clockTime(event.at)}</td>
                <td class="dt-num dt-muted">{event.index}</td>
                <td class={KIND_CLASS[event.kind]}>{event.kind}</td>
                <td class="dt-code">{addressOf(event)}</td>
                <td>{detailOf(event)}</td>
              </>
            )}
          </SelectableTable>
        </div>
        <Show
          when={chosen()}
          keyed
          fallback={
            <Details label="Navigation details" title={<strong>This history entry</strong>}>
              <dl class="dt-facts">
                <dt>Address</dt>
                <dd>{here().href}</dd>
                <dt>Position</dt>
                <dd>{here().index}</dd>
                <dt>Key</dt>
                <dd>{here().key}</dd>
              </dl>
              <Section title="Kept with it" aside="back or forward finds it again">
                <Show when={state()} fallback={<p class="dt-muted">Nothing.</p>}>
                  {(kept) => <pre class="dt-pre">{JSON.stringify(kept(), undefined, 2)}</pre>}
                </Show>
              </Section>
            </Details>
          }
        >
          {(event) => (
            <Details
              label="Navigation details"
              title={
                <>
                  <strong class={KIND_CLASS[event.kind]}>{event.kind}</strong>
                  <span class="dt-muted">
                    #{event.seq} · {clockTime(event.at)}
                  </span>
                </>
              }
            >
              <pre class="dt-pre">{JSON.stringify(event, undefined, 2)}</pre>
            </Details>
          )}
        </Show>
      </div>
      <div class="dt-status" role="status">
        <span class="dt-code">{here().href}</span>
        <span>position {here().index}</span>
        <span>
          {events().length} / {router.journal().length} events
        </span>
      </div>
    </div>
  );
}
