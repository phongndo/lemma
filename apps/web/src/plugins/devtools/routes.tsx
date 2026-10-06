import { For, Show, createMemo, createSignal } from "solid-js";
import type { RouterEvent, RouteVerdict } from "@lemma/router";
import { clockTime } from "../../model/format.ts";
import { Pages, PLUGIN_PANEL } from "../../ui/contracts.ts";
import type { DevtoolsPanel, DevtoolsService, RouterService } from "../../ui/contracts.ts";
import type { SlotItem, SlotsService } from "../../ui/slots.ts";

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
        <button class="dt-link" onClick={() => props.devtools.show(PLUGIN_PANEL, `web:${id()}`)}>
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
function Routes(props: { router: RouterService; slots: SlotsService; devtools: DevtoolsService }) {
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
        <label class="dt-filter" style={{ width: "420px" }}>
          <span>Address</span>
          <input
            aria-label="Address to explain"
            placeholder={router.location().href}
            value={address() ?? router.location().href}
            spellcheck={false}
            autocomplete="off"
            onInput={(event) => setAddress(event.currentTarget.value)}
          />
        </label>
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
          <table class="dt-table" aria-label="Routes">
            <thead>
              <tr>
                <th>Path</th>
                <th>Route</th>
                <th>Verdict</th>
                <th>Shown by</th>
                <th>Plugin</th>
              </tr>
            </thead>
            <tbody>
              <For each={snapshot().routes}>
                {(route) => {
                  const verdict = () => verdictOf(route.id);
                  return (
                    <tr data-row data-selected={current()?.id === route.id} onClick={() => setSelected(route.id)}>
                      <td class="dt-code">{route.path}</td>
                      <td>{route.id}</td>
                      <td class={VERDICT_CLASS[verdict()?.outcome ?? "no-match"]}>{verdict()?.outcome ?? ""}</td>
                      <td class="dt-code">{route.entries[0] ?? <span class="dt-warn">nothing: its plugin is off</span>}</td>
                      <td>
                        <Show when={route.entries[0]}>{(entry) => <PluginLink devtools={devtools} id={owner(entry())} />}</Show>
                      </td>
                    </tr>
                  );
                }}
              </For>
            </tbody>
          </table>
        </div>
        <Show when={current()} keyed>
          {(route) => (
            <aside class="dt-details dt-side" aria-label="Route details">
              <div class="dt-details-title">
                <strong>{route.id}</strong>
                <span class="dt-muted dt-code">{route.path}</span>
              </div>
              <div class="dt-side-body">
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
                <section class="dt-section">
                  <h4>
                    <span>Registered</span>
                    <span class="dt-section-aside">first shows; the rest are overridden</span>
                  </h4>
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
                </section>
              </div>
            </aside>
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
function Navigation(props: { router: RouterService }) {
  const { router } = props;
  const [query, setQuery] = createSignal("");
  const [kind, setKind] = createSignal<(typeof KINDS)[number]["id"]>("all");
  const [selected, setSelected] = createSignal<number>();
  const events = createMemo(() => {
    const words = query().trim().toLowerCase();
    return [...router.journal()]
      .reverse()
      .filter((event) => kind() === "all" || event.kind === kind())
      .filter((event) => words === "" || `${event.kind} ${addressOf(event)} ${detailOf(event)}`.toLowerCase().includes(words));
  });
  const chosen = () => router.journal().find((event) => event.seq === selected());
  const here = () => router.location();
  /** What is kept with this entry; a value set back to nothing (`undefined`) is not kept. */
  const state = () => {
    const kept = Object.entries(router.entryStates()[here().key] ?? {}).filter(([, value]) => value !== undefined);
    return kept.length === 0 ? undefined : Object.fromEntries(kept);
  };
  return (
    <div class="dt-scope">
      <div class="dt-toolbar" role="toolbar" aria-label="Navigation toolbar">
        <label class="dt-filter">
          <input aria-label="Filter the journal" placeholder="Filter" value={query()} onInput={(event) => setQuery(event.currentTarget.value)} />
        </label>
        <span class="dt-sep" />
        <For each={KINDS}>
          {(option) => (
            <button class="dt-chip" aria-pressed={kind() === option.id} onClick={() => setKind(option.id)}>
              {option.label}
            </button>
          )}
        </For>
      </div>
      <div class="dt-split">
        <div class="dt-main" tabindex="-1">
          <table class="dt-table" aria-label="Router journal">
            <thead>
              <tr>
                <th style={{ width: "96px" }}>Time</th>
                <th style={{ width: "40px" }}>At</th>
                <th style={{ width: "86px" }}>Event</th>
                <th>Address</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              <For
                each={events()}
                fallback={
                  <tr>
                    <td colSpan={5} class="dt-muted">
                      Nothing yet
                    </td>
                  </tr>
                }
              >
                {(event) => (
                  <tr data-row data-selected={selected() === event.seq} onClick={() => setSelected(selected() === event.seq ? undefined : event.seq)}>
                    <td class="dt-code dt-muted">{clockTime(event.at)}</td>
                    <td class="dt-num dt-muted">{event.index}</td>
                    <td class={KIND_CLASS[event.kind]}>{event.kind}</td>
                    <td class="dt-code">{addressOf(event)}</td>
                    <td>{detailOf(event)}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
        <aside class="dt-details dt-side" aria-label="Navigation details">
          <Show
            when={chosen()}
            keyed
            fallback={
              <>
                <div class="dt-details-title">
                  <strong>This history entry</strong>
                </div>
                <div class="dt-side-body">
                  <dl class="dt-facts">
                    <dt>Address</dt>
                    <dd>{here().href}</dd>
                    <dt>Position</dt>
                    <dd>{here().index}</dd>
                    <dt>Key</dt>
                    <dd>{here().key}</dd>
                  </dl>
                  <section class="dt-section">
                    <h4>
                      <span>Kept with it</span>
                      <span class="dt-section-aside">back or forward finds it again</span>
                    </h4>
                    <Show when={state()} fallback={<p class="dt-muted">Nothing.</p>}>
                      {(kept) => <pre class="dt-pre">{JSON.stringify(kept(), undefined, 2)}</pre>}
                    </Show>
                  </section>
                </div>
              </>
            }
          >
            {(event) => (
              <>
                <div class="dt-details-title">
                  <strong class={KIND_CLASS[event.kind]}>{event.kind}</strong>
                  <span class="dt-muted">
                    #{event.seq} · {clockTime(event.at)}
                  </span>
                </div>
                <div class="dt-side-body">
                  <pre class="dt-pre">{JSON.stringify(event, undefined, 2)}</pre>
                </div>
              </>
            )}
          </Show>
        </aside>
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

/** The router's panels: why an address shows what it does, who shows each route, and what navigation did. */
export const routePanels = (router: RouterService, slots: SlotsService, devtools: DevtoolsService): readonly SlotItem<DevtoolsPanel>[] => [
  {
    id: "devtools.routes",
    order: 0,
    title: "Routes",
    component: () => <Routes router={router} slots={slots} devtools={devtools} />,
    snapshot: () => router.inspect(),
  },
  {
    id: "devtools.navigation",
    order: 10,
    title: "Navigation",
    component: () => <Navigation router={router} />,
    snapshot: () => ({ journal: router.journal(), entryStates: router.entryStates() }),
  },
];
