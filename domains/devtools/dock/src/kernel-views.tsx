import { For, Show, createEffect, createMemo, createResource, createSignal, on, onCleanup } from "solid-js";
import type { Accessor, JSX } from "solid-js";
import { KERNEL_LABEL, RUNTIME_LABEL, kernelOf, pluginWiring, tablesOf } from "@lemma/contracts";
import type { InspectorInfo, KernelKind as Kind, PluginStatus, Table } from "@lemma/contracts";
import { DevtoolsPanels, PLUGIN_PANEL, TRACE_PANEL, clearsOnEscape, rowKeys } from "@lemma/devtools/web";
import { SectionIds, SettingsRoute } from "@lemma/settings";
import { usePlugin } from "@lemma/web";
import { INSPECTORS_PANEL, kernelFor, slotViews } from "./kernel.tsx";
import type { Deps, SlotView } from "./kernel.tsx";

/*
 * The kernel's panels' views (see `kernelPanels`), loaded the first time the devtools draw one of their own panels.
 */

/** A kernel's name as a chip shows it: "Web app", "Host". */
const kindLabel = (kind: Kind) => `${KERNEL_LABEL[kind].charAt(0).toUpperCase()}${KERNEL_LABEL[kind].slice(1)}`;

const stateClass = (state: string, enabled = true) =>
  !enabled || state === "disabled" ? "dt-muted" : state === "active" ? "dt-ok" : state === "failed" ? "dt-err" : "dt-warn";
const stateLabel = (plugin: PluginStatus) => (plugin.enabled ? plugin.state : "off");

/** A plugin's name: opens it in the Plugins panel, wherever it appears. */
function PluginName(props: { deps: Deps; kind: Kind; id: string }) {
  return (
    <button class="dt-link dt-code" onClick={() => props.deps.devtools.show(PLUGIN_PANEL, `${props.kind}:${props.id}`)}>
      {props.id}
    </button>
  );
}

function Names(props: { deps: Deps; kind: Kind; ids: readonly string[]; none?: string }) {
  return (
    <Show when={props.ids.length > 0} fallback={<span class="dt-muted">{props.none ?? "nothing"}</span>}>
      <For each={props.ids}>
        {(id, index) => (
          <>
            {index() > 0 ? ", " : ""}
            <PluginName deps={props.deps} kind={props.kind} id={id} />
          </>
        )}
      </For>
    </Show>
  );
}

function KindChips(props: { kind: Accessor<Kind>; setKind: (kind: Kind) => void }) {
  return (
    <For each={["web", "host"] as const}>
      {(option) => (
        <button class="dt-chip" aria-pressed={props.kind() === option} onClick={() => props.setKind(option)}>
          {kindLabel(option)}
        </button>
      )}
    </For>
  );
}

function Section(props: { title: string; aside?: JSX.Element; children: JSX.Element }) {
  return (
    <section class="dt-section">
      <h4>
        <span>{props.title}</span>
        <Show when={props.aside}>
          <span class="dt-section-aside">{props.aside}</span>
        </Show>
      </h4>
      {props.children}
    </section>
  );
}

function Tables(props: { tables: readonly Table[] }) {
  return (
    <For each={props.tables}>
      {(table) => (
        <Section title={table.title ?? "Rows"} aside={`${table.rows.length}`}>
          <Show when={table.rows.length > 0} fallback={<p class="dt-muted">None.</p>}>
            <table class="dt-table">
              <thead>
                <tr>
                  <For each={table.columns}>{(column) => <th>{column}</th>}</For>
                </tr>
              </thead>
              <tbody>
                <For each={table.rows}>
                  {(row) => (
                    <tr data-row>
                      <For each={row}>{(value) => <td class="dt-code">{value}</td>}</For>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </Show>
        </Section>
      )}
    </For>
  );
}

/** Selects what `devtools.show(panel, subject)` asks for, whenever it does. */
const followSubject = (deps: Deps, panel: string, apply: (subject: string) => void) =>
  createEffect(
    on(
      () => deps.devtools.subject(panel),
      (subject) => {
        if (subject !== undefined) apply(subject);
      },
    ),
  );

/** An item's place, as the slot's items table and a plugin's contributions show it. */
const placeOf = (item: { readonly phase?: string; readonly order: number }) => `${item.phase === undefined ? "" : `${item.phase} · `}${item.order}`;

/**
 * How a web half names a slot no contract exports: by declaring it as its own declaration does (a part with
 * `api.definePart`), so whichever of the two runs first declares it the same way, and the other finds it.
 */
const declaration = (view: SlotView): string => {
  if (view.name.startsWith("part.")) return `api.definePart(${JSON.stringify(view.name.slice("part.".length))})`;
  const firstWins = view.shows === "first" && view.defaultPhase === "replace" && JSON.stringify(view.phases) === JSON.stringify(["replace", "default"]);
  const options = [
    ...(view.shows === "first" ? [`shows: "first"`] : []),
    ...(view.phases === undefined || firstWins ? [] : [`phases: ${JSON.stringify(view.phases)}`, `defaultPhase: ${JSON.stringify(view.defaultPhase)}`]),
  ];
  return `defineSlot(${JSON.stringify(view.name)}${options.length === 0 ? "" : `, { ${options.join(", ")} }`})`;
};

const snippet = (view: SlotView): string => {
  const target = view.contract !== undefined ? view.contract.name : declaration(view);
  // A web half takes the contracts from its api (no build step resolves an import); the name says which contract.
  const from = view.contract === undefined ? "" : `const { ${view.contract.name} } = api.contracts; // ${view.contract.from}\n`;
  const { phases, defaultPhase } = view;
  const rank = (phase: string | undefined) => phases?.indexOf(phase ?? defaultPhase!) ?? 0;
  const inPhases = phases === undefined ? "" : ` Phases: ${phases.join(", ")} (an item naming none goes in "${defaultPhase}").`;
  if (view.shows === "first") {
    const shown = view.items[0];
    // An item in the default phase already comes before one in a later phase; within a phase, a lower order comes first.
    const place =
      shown === undefined || rank(undefined) < rank(shown.phase)
        ? ""
        : `${shown.phase === undefined || shown.phase === defaultPhase ? "" : `phase: ${JSON.stringify(shown.phase)}, `}order: ${shown.order - 1}, `;
    return `${from}// One item shows: the first.${inPhases} This replaces "${shown?.id ?? "it"}".\nslots.add(${target}, { id: "my-plugin.${view.name}", ${place}component: Mine });`;
  }
  return `${from}// Every item shows, in order: ${phases === undefined ? "" : "by phase, then "}lower order first, then by plugin id.${inPhases}\nslots.add(${target}, { id: "my-plugin.thing", order: 0, ... });`;
};

/**
 * Everything one plugin does, and what depends on it: its state and why, the
 * capabilities it provides (and who uses them) and requires (and who provides
 * them), its place in each hook's chain, the events it observes, what it
 * contributes (in the web app: each slot item; on the host: its inspectors),
 * its settings, and its recent faults.
 */
function PluginView(props: { deps: Deps; kind: Kind; plugin: PluginStatus; plugins: readonly PluginStatus[]; inspectors: readonly InspectorInfo[] }) {
  const { deps } = props;
  const plugin = () => props.plugin;
  const wiring = createMemo(() => pluginWiring(props.plugins, props.plugin, deps.runtime[props.kind]()));
  const items = () =>
    props.kind === "web"
      ? slotViews(deps).flatMap((view) => view.items.filter((item) => item.plugin === plugin().id).map((item) => ({ slot: view.name, ...item })))
      : [];
  const own = () => props.inspectors.filter((inspector) => inspector.source === plugin().id);
  return (
    <aside class="dt-details dt-side" aria-label="Plugin details">
      <div class="dt-details-title">
        <strong class="dt-code">{plugin().id}</strong>
        <span class="dt-muted">{plugin().version ?? ""}</span>
        <span class={stateClass(plugin().state, plugin().enabled)}>{stateLabel(plugin())}</span>
        {/* Its spans, while a plugin shows the trace (`devtools.trace`). */}
        <Show when={deps.slots.get(DevtoolsPanels, TRACE_PANEL)}>
          <button
            class="dt-link devtools-end"
            onClick={() => deps.devtools.show(TRACE_PANEL, `trace:${props.kind === "web" ? "page" : "host"} plugin:${plugin().id}`)}
          >
            Spans
          </button>
        </Show>
        <a class="devtools-end" href={deps.router.href(SettingsRoute, { section: SectionIds.plugins }, { plugin: plugin().id, kind: props.kind })}>
          Plugins page
        </a>
      </div>
      <div class="dt-side-body">
        <Show when={plugin().fault}>
          {(fault) => (
            <div class="dt-banner dt-err">
              {fault().phase}
              {fault().operation === undefined ? "" : ` (${fault().operation})`}: {fault().message}
            </div>
          )}
        </Show>
        <dl class="dt-facts">
          <dt>Source</dt>
          <dd>
            {plugin().source}
            {plugin().shadows ? ", shadowing the bundled one" : ""}
          </dd>
          <Show when={plugin().haltedBy}>
            {(by) => (
              <>
                <dt>Halted by</dt>
                <dd>
                  <PluginName deps={deps} kind={props.kind} id={by()} />
                </dd>
              </>
            )}
          </Show>
          <Show when={plugin().locked}>
            {(why) => (
              <>
                <dt>Kept on</dt>
                <dd>{why()}</dd>
              </>
            )}
          </Show>
        </dl>
        <Section title="Provides" aside="replacing it restarts what requires it">
          <Show when={wiring().serves.length > 0} fallback={<p class="dt-muted">Nothing.</p>}>
            <table class="dt-table">
              <tbody>
                <For each={wiring().serves}>
                  {(serve) => (
                    <tr data-row>
                      <td class="dt-code">{serve.key}</td>
                      <td class="dt-wrap">
                        used by <Names deps={deps} kind={props.kind} ids={serve.users} />
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </Show>
        </Section>
        <Section title="Requires">
          <Show when={wiring().calls.length > 0} fallback={<p class="dt-muted">Nothing.</p>}>
            <table class="dt-table">
              <tbody>
                <For each={wiring().calls}>
                  {(call) => (
                    <tr data-row>
                      <td class="dt-code">{call.key}</td>
                      <td class="dt-wrap">
                        <Show
                          when={call.providers.length > 0}
                          fallback={call.runtime ? <span class="dt-muted">{RUNTIME_LABEL[props.kind]}</span> : <span class="dt-err">nothing provides it</span>}
                        >
                          <For each={call.providers}>
                            {(provider) => (
                              <span>
                                <PluginName deps={deps} kind={props.kind} id={provider.id} />{" "}
                                <span class={stateClass(provider.state, provider.enabled)}>{stateLabel(provider)}</span>{" "}
                              </span>
                            )}
                          </For>
                        </Show>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </Show>
        </Section>
        <Show when={wiring().hooks.length > 0}>
          <Section title="Hooks" aside="its place in each chain">
            <table class="dt-table">
              <tbody>
                <For each={wiring().hooks}>
                  {(hook) => (
                    <tr data-row>
                      <td class="dt-code">{hook.name}</td>
                      <td class="dt-num dt-muted">
                        {hook.phase === undefined ? "" : `${hook.phase} · `}order {hook.order}
                      </td>
                      <td class="dt-muted">
                        {hook.position} of {hook.of}
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </Section>
        </Show>
        <Show when={wiring().observes.length > 0}>
          <Section title="Observes">
            <p class="dt-code">{wiring().observes.join(", ")}</p>
          </Section>
        </Show>
        <Show when={props.kind === "web" ? items().length > 0 : (plugin().contributes ?? []).length > 0}>
          <Section title="Contributes" aside={props.kind === "web" ? "each slot item it added" : "items in other plugins' registries"}>
            <table class="dt-table">
              <tbody>
                <Show
                  when={props.kind === "web"}
                  fallback={
                    <For each={plugin().contributes}>
                      {(registry) => (
                        <tr data-row>
                          <td class="dt-code">{registry.name}</td>
                          <td class="dt-num">{registry.items}</td>
                          <td class="dt-code dt-muted dt-wrap">{(registry.keys ?? []).join(", ")}</td>
                        </tr>
                      )}
                    </For>
                  }
                >
                  <For each={items()}>
                    {(item) => (
                      <tr data-row>
                        <td class="dt-code">{item.slot}</td>
                        <td class="dt-code">{item.id}</td>
                        <td class="dt-num dt-muted">{placeOf(item)}</td>
                      </tr>
                    )}
                  </For>
                </Show>
              </tbody>
            </table>
          </Section>
        </Show>
        <Show when={own().length > 0}>
          <Section title="Inspectors" aside="what it lets you look into">
            <For each={own()}>
              {(inspector) => (
                <div>
                  <button class="dt-link" onClick={() => deps.devtools.show(INSPECTORS_PANEL, inspector.id)}>
                    {inspector.title}
                  </button>{" "}
                  <span class="dt-muted">{inspector.description ?? ""}</span>
                </div>
              )}
            </For>
          </Section>
        </Show>
        <Show when={(plugin().configFields ?? []).length > 0}>
          <Section title="Settings">
            <table class="dt-table">
              <tbody>
                <For each={plugin().configFields}>
                  {(field) => {
                    const value = () => plugin().config?.values[field.key];
                    return (
                      <tr data-row>
                        <td class="dt-code">{field.key}</td>
                        <td class="dt-code">
                          {field.secret
                            ? plugin().config?.secretsSet.includes(field.key)
                              ? "set"
                              : "unset"
                            : (JSON.stringify(value() ?? field.default) ?? "")}
                          {value() === undefined && field.default !== undefined ? <span class="dt-muted"> (default)</span> : ""}
                        </td>
                      </tr>
                    );
                  }}
                </For>
              </tbody>
            </table>
          </Section>
        </Show>
        <Show when={(plugin().faults ?? []).length > 0}>
          <Section title="Faults" aside={`${plugin().faults!.length} recent`}>
            <table class="dt-table">
              <tbody>
                <For each={plugin().faults}>
                  {(fault) => (
                    <tr data-row>
                      <td class="dt-muted dt-code">{new Date(fault.at).toLocaleTimeString([], { hour12: false })}</td>
                      <td class="dt-code">{fault.phase}</td>
                      <td class="dt-err">{fault.message}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </Section>
        </Show>
      </div>
    </aside>
  );
}

const STATES = [
  { id: "all", label: "All", test: () => true },
  { id: "running", label: "Running", test: (plugin: PluginStatus) => plugin.state === "active" },
  { id: "failed", label: "Failed", test: (plugin: PluginStatus) => plugin.state === "failed" || plugin.haltedBy !== undefined },
  { id: "off", label: "Off", test: (plugin: PluginStatus) => !plugin.enabled },
] as const;

export function PluginsPanel(props: { deps: Deps; inspectors: Accessor<readonly InspectorInfo[]> }) {
  const { deps } = props;
  const [kind, setKind] = createSignal<Kind>("web");
  const [state, setState] = createSignal<(typeof STATES)[number]["id"]>("all");
  const [filter, setFilter] = createSignal("");
  const [selected, setSelected] = createSignal<string>();
  followSubject(deps, PLUGIN_PANEL, (subject) => {
    const [which, ...rest] = subject.split(":");
    setKind(which === "host" ? "host" : "web");
    setFilter("");
    setState("all");
    setSelected(rest.join(":"));
  });
  const plugins = () => deps.lists[kind()]();
  const kernel = createMemo(() => kernelFor(deps, kind()));
  const shown = () => {
    const words = filter().trim().toLowerCase();
    const test = STATES.find((option) => option.id === state())!.test;
    return plugins().filter(
      (plugin) => test(plugin) && (words === "" || `${plugin.id} ${plugin.provides.join(" ")} ${plugin.requires.join(" ")}`.toLowerCase().includes(words)),
    );
  };
  const current = () => plugins().find((plugin) => plugin.id === selected()) ?? shown()[0];
  return (
    <div class="dt-scope">
      <div class="dt-toolbar" role="toolbar" aria-label="Plugins toolbar">
        <label class="dt-filter">
          <input
            placeholder="Filter plugins, capabilities"
            aria-label="Filter plugins"
            value={filter()}
            onInput={(event) => setFilter(event.currentTarget.value)}
            onKeyDown={clearsOnEscape(filter, () => setFilter(""))}
          />
        </label>
        <span class="dt-sep" />
        <KindChips kind={kind} setKind={setKind} />
        <span class="dt-sep" />
        <For each={STATES}>
          {(option) => (
            <button class="dt-chip" aria-pressed={state() === option.id} onClick={() => setState(option.id)}>
              {option.label}
            </button>
          )}
        </For>
      </div>
      <div class="dt-split">
        <div class="dt-main" tabindex="-1">
          <table class="dt-table" aria-label="Plugins" role="grid" tabindex="0" onKeyDown={rowKeys(setSelected)}>
            <thead>
              <tr>
                <th>Plugin</th>
                <th class="devtools-plugins-state">State</th>
                <th class="devtools-plugins-source">Source</th>
                <th>Provides</th>
                <th class="devtools-plugins-requires dt-num">Requires</th>
                <th class="devtools-plugins-faults dt-num">Faults</th>
              </tr>
            </thead>
            <tbody>
              <For
                each={shown()}
                fallback={
                  <tr>
                    <td colSpan={6} class="dt-muted">
                      No plugin matches
                    </td>
                  </tr>
                }
              >
                {(plugin) => (
                  <tr
                    data-row
                    data-key={plugin.id}
                    data-selected={current()?.id === plugin.id}
                    aria-selected={current()?.id === plugin.id}
                    tabindex="-1"
                    onClick={() => setSelected(plugin.id)}
                  >
                    <td class="dt-code">{plugin.id}</td>
                    <td class={stateClass(plugin.state, plugin.enabled)}>{stateLabel(plugin)}</td>
                    <td class="dt-muted">{plugin.source}</td>
                    <td class="dt-code dt-muted">{plugin.provides.join(", ")}</td>
                    <td class="dt-num">{plugin.requires.length}</td>
                    <td class={`dt-num ${(plugin.faults ?? []).length > 0 ? "dt-err" : "dt-muted"}`}>{(plugin.faults ?? []).length}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
        <Show when={current()} keyed>
          {(plugin) => <PluginView deps={deps} kind={kind()} plugin={plugin} plugins={plugins()} inspectors={props.inspectors()} />}
        </Show>
      </div>
      <div class="dt-status" role="status">
        <span>
          {shown().length} / {plugins().length} plugins
        </span>
        <span>{plugins().filter((plugin) => plugin.state === "active").length} running</span>
        <span>{plugins().filter((plugin) => plugin.state === "failed").length} failed</span>
        <span>{plugins().filter((plugin) => !plugin.enabled).length} off</span>
        <span>
          {kernel().capabilities.filter((capability) => capability.providers.length === 0 && !capability.runtime).length} capabilities without a provider
        </span>
      </div>
    </div>
  );
}

/** Each hook's chain in run order, or each event's observers. */
export function HooksPanel(props: { deps: Deps }) {
  const { deps } = props;
  const [kind, setKind] = createSignal<Kind>("host");
  const [what, setWhat] = createSignal<"hooks" | "events">("hooks");
  const [selected, setSelected] = createSignal<string>();
  const kernel = createMemo(() => kernelFor(deps, kind()));
  const rows = () =>
    what() === "hooks"
      ? kernel().hooks.map((hook) => ({
          name: hook.name,
          plugins: hook.handlers.map((handler) => handler.plugin),
          orders: hook.handlers.map((handler) => `${handler.phase === undefined ? "" : `${handler.phase} · `}order ${handler.order}`),
        }))
      : kernel().events.map((event) => ({ name: event.name, plugins: event.observers, orders: undefined }));
  const current = () => rows().find((row) => row.name === selected()) ?? rows()[0];
  return (
    <div class="dt-scope">
      <div class="dt-toolbar" role="toolbar" aria-label="Hooks toolbar">
        <KindChips kind={kind} setKind={setKind} />
        <span class="dt-sep" />
        <button class="dt-chip" aria-pressed={what() === "hooks"} onClick={() => setWhat("hooks")}>
          Hooks
        </button>
        <button class="dt-chip" aria-pressed={what() === "events"} onClick={() => setWhat("events")}>
          Events
        </button>
      </div>
      <div class="dt-split">
        <div class="dt-main" tabindex="-1">
          <table class="dt-table" aria-label={what() === "hooks" ? "Hooks" : "Events"} role="grid" tabindex="0" onKeyDown={rowKeys(setSelected)}>
            <thead>
              <tr>
                <th>{what() === "hooks" ? "Hook" : "Event"}</th>
                <th class="devtools-hooks-count dt-num">{what() === "hooks" ? "Handlers" : "Observers"}</th>
                <th>{what() === "hooks" ? "Runs" : "Observed by"}</th>
              </tr>
            </thead>
            <tbody>
              <For
                each={rows()}
                fallback={
                  <tr>
                    <td colSpan={3} class="dt-muted">
                      {what() === "hooks" ? "No plugin intercepts a hook." : "No plugin observes an event."}
                    </td>
                  </tr>
                }
              >
                {(row) => (
                  <tr
                    data-row
                    data-key={row.name}
                    data-selected={current()?.name === row.name}
                    aria-selected={current()?.name === row.name}
                    tabindex="-1"
                    onClick={() => setSelected(row.name)}
                  >
                    <td class="dt-code">{row.name}</td>
                    <td class="dt-num">{row.plugins.length}</td>
                    <td class="dt-muted">{row.plugins.join(what() === "hooks" ? " → " : ", ")}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
        <Show when={current()} keyed>
          {(row) => (
            <aside class="dt-details dt-side" aria-label="Hook details">
              <div class="dt-details-title">
                <strong class="dt-code">{row.name}</strong>
              </div>
              <div class="dt-side-body">
                <Section
                  title={row.orders === undefined ? "Observers" : "Chain"}
                  aside={row.orders === undefined ? "each hears every event" : "by phase, then lowest order first"}
                >
                  <table class="dt-table">
                    <tbody>
                      <For each={row.plugins}>
                        {(id, index) => (
                          <tr data-row>
                            <td class="dt-num dt-muted devtools-chain-place">{index() + 1}</td>
                            <td>
                              <PluginName deps={deps} kind={kind()} id={id} />
                            </td>
                            <Show when={row.orders}>{(orders) => <td class="dt-muted">{orders()[index()]}</td>}</Show>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </Section>
              </div>
            </aside>
          )}
        </Show>
      </div>
      <div class="dt-status" role="status">
        <span>{kernel().hooks.length} hooks</span>
        <span>{kernel().events.length} observed events</span>
      </div>
    </div>
  );
}

/** Every registry: the web app's slots (live, with how to add to them), or the host's registries. */
export function RegistriesPanel(props: { deps: Deps }) {
  const { deps } = props;
  const [kind, setKind] = createSignal<Kind>("web");
  const [filter, setFilter] = createSignal("");
  const [selected, setSelected] = createSignal<string>();
  const web = createMemo(() => slotViews(deps));
  const host = createMemo(() => kernelOf(deps.lists.host(), deps.runtime.host()).registries);
  const rows = () => {
    const all =
      kind() === "web"
        ? web().map((view) => ({ name: view.name, items: view.items.length, plugins: [...new Set(view.items.map((item) => item.plugin))] }))
        : host().map((registry) => ({ name: registry.name, items: registry.items, plugins: registry.contributors.map((contributor) => contributor.plugin) }));
    const words = filter().trim().toLowerCase();
    return words === "" ? all : all.filter((row) => `${row.name} ${row.plugins.join(" ")}`.toLowerCase().includes(words));
  };
  const current = () => rows().find((row) => row.name === selected()) ?? rows()[0];
  return (
    <div class="dt-scope">
      <div class="dt-toolbar" role="toolbar" aria-label="Registries toolbar">
        <label class="dt-filter">
          <input
            placeholder="Filter registries, plugins"
            aria-label="Filter registries"
            value={filter()}
            onInput={(event) => setFilter(event.currentTarget.value)}
            onKeyDown={clearsOnEscape(filter, () => setFilter(""))}
          />
        </label>
        <span class="dt-sep" />
        <KindChips kind={kind} setKind={setKind} />
      </div>
      <div class="dt-split">
        <div class="dt-main" tabindex="-1">
          <table class="dt-table" aria-label="Registries" role="grid" tabindex="0" onKeyDown={rowKeys(setSelected)}>
            <thead>
              <tr>
                <th>{kind() === "web" ? "Slot" : "Registry"}</th>
                <th class="devtools-registries-items dt-num">Items</th>
                <th>Plugins</th>
              </tr>
            </thead>
            <tbody>
              <For
                each={rows()}
                fallback={
                  <tr>
                    <td colSpan={3} class="dt-muted">
                      None matches
                    </td>
                  </tr>
                }
              >
                {(row) => (
                  <tr
                    data-row
                    data-key={row.name}
                    data-selected={current()?.name === row.name}
                    aria-selected={current()?.name === row.name}
                    tabindex="-1"
                    onClick={() => setSelected(row.name)}
                  >
                    <td class="dt-code">{row.name}</td>
                    <td class="dt-num">{row.items}</td>
                    <td class="dt-muted">{row.plugins.join(", ")}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
        <Show when={current()} keyed>
          {(row) => (
            <aside class="dt-details dt-side" aria-label="Registry details">
              <Show
                when={kind() === "web" ? web().find((view) => view.name === row.name) : undefined}
                keyed
                fallback={
                  <>
                    <div class="dt-details-title">
                      <strong class="dt-code">{row.name}</strong>
                    </div>
                    <div class="dt-side-body">
                      <Section title="Contributors">
                        <table class="dt-table" aria-label="Registry items">
                          <tbody>
                            <For each={host().find((registry) => registry.name === row.name)?.contributors ?? []}>
                              {(contributor) => (
                                <tr data-row>
                                  <td>
                                    <PluginName deps={deps} kind="host" id={contributor.plugin} />
                                  </td>
                                  <td class="dt-num">{contributor.items}</td>
                                  <td class="dt-code dt-muted dt-wrap">{contributor.keys.join(", ")}</td>
                                </tr>
                              )}
                            </For>
                          </tbody>
                        </table>
                      </Section>
                    </div>
                  </>
                }
              >
                {(view) => (
                  <>
                    <div class="dt-details-title">
                      <strong class="dt-code">{view.name}</strong>
                      <Show when={view.contract}>
                        {(contract) => (
                          <span class="dt-muted">
                            {contract().name} from {contract().from}
                          </span>
                        )}
                      </Show>
                    </div>
                    <div class="dt-side-body">
                      <dl class="dt-facts">
                        <dt>Shows</dt>
                        <dd>{view.shows === "first" ? "the first item; the rest are replaced" : "every item, in order"}</dd>
                        <Show when={view.phases}>
                          {(phases) => (
                            <>
                              <dt>Phases</dt>
                              <dd>
                                {phases().join(", ")}; an item naming none goes in {view.defaultPhase}
                              </dd>
                            </>
                          )}
                        </Show>
                      </dl>
                      <Section title="Items" aside={view.phases === undefined ? "by order, then plugin" : "by phase, then order, then plugin"}>
                        <Show when={view.items.length > 0} fallback={<p class="dt-muted">Empty: nothing adds to it now.</p>}>
                          <table class="dt-table" aria-label="Registry items">
                            <tbody>
                              <For each={view.items}>
                                {(item, index) => (
                                  <tr data-row>
                                    <td class="dt-num dt-muted devtools-registry-place">{placeOf(item)}</td>
                                    <td class="dt-code">{item.id}</td>
                                    <td>
                                      <PluginName deps={deps} kind="web" id={item.plugin} />
                                    </td>
                                    <Show when={view.shows === "first"}>
                                      <td class="dt-muted">{index() === 0 ? "shown" : "replaced"}</td>
                                    </Show>
                                  </tr>
                                )}
                              </For>
                            </tbody>
                          </table>
                        </Show>
                      </Section>
                      <Section title="Add here">
                        <pre class="dt-pre">{snippet(view)}</pre>
                      </Section>
                    </div>
                  </>
                )}
              </Show>
            </aside>
          )}
        </Show>
      </div>
      <div class="dt-status" role="status">
        <span>
          {rows().length} {kind() === "web" ? "slots" : "registries"}
        </span>
        <span>{rows().reduce((sum, row) => sum + row.items, 0)} items</span>
      </div>
    </div>
  );
}

/** How often an open inspector is read again (ms): what it shows changes as the host runs. */
const INSPECT_EVERY = 2000;

/** What host plugins let you look into: each inspector's snapshot, as tables when it has their shape. */
export function InspectorsPanel(props: { deps: Deps; inspectors: Accessor<readonly InspectorInfo[]> }) {
  const { deps } = props;
  const [selected, setSelected] = createSignal<string>();
  followSubject(deps, INSPECTORS_PANEL, setSelected);
  const current = () => props.inspectors().find((inspector) => inspector.id === selected()) ?? props.inspectors()[0];
  const [snapshot, { refetch }] = createResource(
    () => current()?.id,
    async (id) => {
      try {
        return { value: await deps.client.inspect(id) };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    },
  );
  const plugin = usePlugin();
  onCleanup(plugin.every(INSPECT_EVERY, () => refetch(), { name: "refresh inspectors" }));
  return (
    <div class="dt-scope">
      <div class="dt-toolbar" role="toolbar" aria-label="Inspectors toolbar">
        <button class="dt-chip" onClick={plugin.action("refresh inspectors", () => refetch())}>
          Refresh
        </button>
        <span class="dt-sep" />
        <span class="dt-muted">Host plugins add these to the Inspectors registry; open ones refresh every {INSPECT_EVERY / 1000}s.</span>
      </div>
      <div class="dt-split">
        <div class="dt-main devtools-inspectors-list" tabindex="-1">
          <table class="dt-table" aria-label="Inspectors" role="grid" tabindex="0" onKeyDown={rowKeys(setSelected)}>
            <thead>
              <tr>
                <th>Inspector</th>
                <th>Plugin</th>
              </tr>
            </thead>
            <tbody>
              <For
                each={props.inspectors()}
                fallback={
                  <tr>
                    <td colSpan={2} class="dt-muted">
                      No running host plugin adds one
                    </td>
                  </tr>
                }
              >
                {(inspector) => (
                  <tr
                    data-row
                    data-key={inspector.id}
                    data-selected={current()?.id === inspector.id}
                    aria-selected={current()?.id === inspector.id}
                    tabindex="-1"
                    onClick={() => setSelected(inspector.id)}
                  >
                    <td>{inspector.title}</td>
                    <td>
                      <PluginName deps={deps} kind="host" id={inspector.source} />
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
        <Show when={current()} keyed>
          {(inspector) => (
            <section class="dt-details devtools-inspector-snapshot" aria-label="Inspector snapshot">
              <div class="dt-details-title">
                <strong>{inspector.title}</strong>
                <span class="dt-muted dt-code">{inspector.id}</span>
                <span class="dt-muted">{inspector.description ?? ""}</span>
              </div>
              <div class="dt-side-body">
                <Show when={snapshot()} keyed fallback={<p class="dt-muted">Reading…</p>}>
                  {(read) =>
                    "error" in read ? (
                      <p class="dt-err">It failed: {read.error}</p>
                    ) : (
                      <Show when={tablesOf(read.value)} keyed fallback={<pre class="dt-pre">{JSON.stringify(read.value, undefined, 2)}</pre>}>
                        {(tables) => <Tables tables={tables} />}
                      </Show>
                    )
                  }
                </Show>
              </div>
            </section>
          )}
        </Show>
      </div>
      <div class="dt-status" role="status">
        <span>{props.inspectors().length} inspectors</span>
      </div>
    </div>
  );
}
