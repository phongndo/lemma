import { For, Show, createEffect, createMemo, createResource, createSignal, on, onCleanup } from "solid-js";
import type { Accessor, JSX } from "solid-js";
import { kernelOf, tablesOf } from "@lemma/contracts";
import type { InspectorInfo, KernelView, PluginStatus, Table } from "@lemma/contracts";
import * as contracts from "../../ui/contracts.ts";
import { PLUGIN_PANEL, SectionIds, SettingsRoute } from "../../ui/contracts.ts";
import type { ClientService, DevtoolsService, RouterService } from "../../ui/contracts.ts";
import { DEFAULT_PART_ORDER, definedSlots } from "../../ui/slots.ts";
import type { Slot, SlotItem, SlotsService } from "../../ui/slots.ts";

type Kind = "web" | "host";
const KIND_LABEL: Readonly<Record<Kind, string>> = { web: "Web app", host: "Host" };
/** Who provides a runtime capability: the app itself, not a plugin. */
const RUNTIME_LABEL: Readonly<Record<Kind, string>> = { web: "the web app", host: "the host" };
const INSPECTORS_PANEL = "devtools.inspectors";

/** What the kernel's panels read. */
interface Deps {
  readonly slots: SlotsService;
  readonly router: RouterService;
  readonly devtools: DevtoolsService;
  readonly client: ClientService;
  /** Every plugin of each kernel, with what it provides, requires, intercepts, observes, and contributes. */
  readonly lists: Readonly<Record<Kind, Accessor<readonly PluginStatus[]>>>;
  /** What each kernel's app provides itself, its runtime (`PluginsService.runtime`). */
  readonly runtime: Readonly<Record<Kind, Accessor<readonly string[]>>>;
}

/** The kernel view of `kind`, its runtime marked (`kernelOf`). */
const kernelFor = (deps: Deps, kind: Kind) => kernelOf(deps.lists[kind](), deps.runtime[kind]());

const stateClass = (state: string, enabled = true) =>
  !enabled || state === "disabled" ? "dt-muted" : state === "active" ? "dt-ok" : state === "failed" ? "dt-err" : "dt-warn";
const stateLabel = (plugin: PluginStatus) => (plugin.enabled ? plugin.state : "off");

/** A plugin's name: opens it in the Plugins panel, wherever it appears. */
function PluginName(props: { deps: Deps; kind: Kind; id: string }) {
  return (
    <button class="dt-link" onClick={() => props.deps.devtools.show(PLUGIN_PANEL, `${props.kind}:${props.id}`)}>
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
          {KIND_LABEL[option]}
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

/** The name each contract slot is exported as (`MainRegion`), for the snippet that adds to it. */
const exportNames = new Map<unknown, string>(Object.entries(contracts).map(([name, value]) => [value, name]));

interface SlotView {
  readonly name: string;
  readonly contract: string | undefined;
  readonly shows: "first" | "all";
  readonly items: readonly { readonly id: string; readonly plugin: string; readonly order: number }[];
}
const slotViews = (slots: SlotsService): SlotView[] =>
  definedSlots()
    .map(({ slot, shows }: { slot: Slot<unknown>; shows: "first" | "all" }) => ({
      name: slot.name,
      contract: exportNames.get(slot),
      shows,
      items: slots.contributions(slot).map((contribution) => ({ id: contribution.item.id, plugin: contribution.pluginId, order: contribution.order })),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));

const snippet = (view: SlotView): string => {
  const target = view.contract === undefined ? `defineSlot(${JSON.stringify(view.name)})` : `contracts.${view.contract}`;
  if (view.shows === "first") {
    const first = view.items[0]?.order ?? DEFAULT_PART_ORDER;
    return `// One item shows: the first by order. To replace "${view.items[0]?.id ?? "it"}", add with a lower order.\nslots.add(${target}, { id: "my-plugin.${view.name}", order: ${first - 1}, component: Mine });`;
  }
  return `// Every item shows, in order (then by plugin id).\nslots.add(${target}, { id: "my-plugin.thing", order: 0, ... });`;
};

/**
 * Everything one plugin does, and what depends on it: its state and why, the
 * capabilities it provides (and who uses them) and requires (and who provides
 * them), its place in each hook's chain, the events it observes, what it
 * contributes (in the web app: each slot item; on the host: its inspectors),
 * its settings, and its recent faults.
 */
function PluginView(props: {
  deps: Deps;
  kind: Kind;
  plugin: PluginStatus;
  plugins: readonly PluginStatus[];
  kernel: KernelView;
  inspectors: readonly InspectorInfo[];
}) {
  const { deps } = props;
  const plugin = () => props.plugin;
  const users = (key: string) => props.plugins.filter((other) => other.requires.includes(key)).map((other) => other.id);
  const providers = (key: string) => props.plugins.filter((other) => other.provides.includes(key));
  const chainOf = (name: string) => props.kernel.hooks.find((hook) => hook.name === name)?.handlers ?? [];
  const items = () =>
    props.kind === "web"
      ? slotViews(deps.slots).flatMap((view) => view.items.filter((item) => item.plugin === plugin().id).map((item) => ({ slot: view.name, ...item })))
      : [];
  const own = () => props.inspectors.filter((inspector) => inspector.source === plugin().id);
  return (
    <aside class="dt-details dt-side" aria-label="Plugin details">
      <div class="dt-details-title">
        <strong class="dt-code">{plugin().id}</strong>
        <span class="dt-muted">{plugin().version ?? ""}</span>
        <span class={stateClass(plugin().state, plugin().enabled)}>{stateLabel(plugin())}</span>
        <a style={{ "margin-left": "auto" }} href={deps.router.href(SettingsRoute, { section: SectionIds.plugins }, { plugin: plugin().id, kind: props.kind })}>
          Plugins page
        </a>
      </div>
      <div class="dt-side-body">
        <Show when={plugin().fault}>
          {(fault) => (
            <div class="dt-banner dt-err" style={{ background: "var(--err-soft)" }}>
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
          <Show when={plugin().provides.length > 0} fallback={<p class="dt-muted">Nothing.</p>}>
            <table class="dt-table">
              <tbody>
                <For each={plugin().provides}>
                  {(key) => (
                    <tr data-row>
                      <td class="dt-code">{key}</td>
                      <td class="dt-wrap">
                        used by <Names deps={deps} kind={props.kind} ids={users(key)} />
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </Show>
        </Section>
        <Section title="Requires">
          <Show when={plugin().requires.length > 0} fallback={<p class="dt-muted">Nothing.</p>}>
            <table class="dt-table">
              <tbody>
                <For each={plugin().requires}>
                  {(key) => (
                    <tr data-row>
                      <td class="dt-code">{key}</td>
                      <td class="dt-wrap">
                        <Show
                          when={providers(key).length > 0}
                          fallback={
                            props.kernel.capabilities.find((capability) => capability.key === key)?.runtime ? (
                              <span class="dt-muted">{RUNTIME_LABEL[props.kind]}</span>
                            ) : (
                              <span class="dt-err">nothing provides it</span>
                            )
                          }
                        >
                          <For each={providers(key)}>
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
        <Show when={(plugin().hooks ?? []).length > 0}>
          <Section title="Hooks" aside="its place in each chain">
            <table class="dt-table">
              <tbody>
                <For each={plugin().hooks}>
                  {(hook) => {
                    const chain = () => chainOf(hook.name);
                    return (
                      <tr data-row>
                        <td class="dt-code">{hook.name}</td>
                        <td class="dt-num dt-muted">order {hook.order}</td>
                        <td class="dt-muted">
                          {chain().findIndex((handler) => handler.plugin === plugin().id) + 1} of {chain().length}
                        </td>
                      </tr>
                    );
                  }}
                </For>
              </tbody>
            </table>
          </Section>
        </Show>
        <Show when={(plugin().observes ?? []).length > 0}>
          <Section title="Observes">
            <p class="dt-code">{plugin().observes!.join(", ")}</p>
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
                        <td class="dt-num dt-muted">{item.order}</td>
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

function PluginsPanel(props: { deps: Deps; inspectors: Accessor<readonly InspectorInfo[]> }) {
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
          <table class="dt-table" aria-label="Plugins">
            <thead>
              <tr>
                <th>Plugin</th>
                <th style={{ width: "80px" }}>State</th>
                <th style={{ width: "72px" }}>Source</th>
                <th>Provides</th>
                <th style={{ width: "64px" }}>Requires</th>
                <th style={{ width: "56px" }}>Faults</th>
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
                  <tr data-row data-selected={current()?.id === plugin.id} onClick={() => setSelected(plugin.id)}>
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
          {(plugin) => <PluginView deps={deps} kind={kind()} plugin={plugin} plugins={plugins()} kernel={kernel()} inspectors={props.inspectors()} />}
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
function HooksPanel(props: { deps: Deps }) {
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
          orders: hook.handlers.map((handler) => handler.order),
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
          <table class="dt-table" aria-label={what() === "hooks" ? "Hooks" : "Events"}>
            <thead>
              <tr>
                <th>{what() === "hooks" ? "Hook" : "Event"}</th>
                <th style={{ width: "70px" }}>{what() === "hooks" ? "Handlers" : "Observers"}</th>
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
                  <tr data-row data-selected={current()?.name === row.name} onClick={() => setSelected(row.name)}>
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
                  aside={row.orders === undefined ? "each hears every event" : "lowest order runs first"}
                >
                  <table class="dt-table">
                    <tbody>
                      <For each={row.plugins}>
                        {(id, index) => (
                          <tr data-row>
                            <td class="dt-num dt-muted" style={{ width: "28px" }}>
                              {index() + 1}
                            </td>
                            <td>
                              <PluginName deps={deps} kind={kind()} id={id} />
                            </td>
                            <td class="dt-muted">{row.orders === undefined ? "" : `order ${row.orders[index()]}`}</td>
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
function RegistriesPanel(props: { deps: Deps }) {
  const { deps } = props;
  const [kind, setKind] = createSignal<Kind>("web");
  const [filter, setFilter] = createSignal("");
  const [selected, setSelected] = createSignal<string>();
  const web = createMemo(() => slotViews(deps.slots));
  const host = createMemo(() => kernelOf(deps.lists.host()).registries);
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
          />
        </label>
        <span class="dt-sep" />
        <KindChips kind={kind} setKind={setKind} />
      </div>
      <div class="dt-split">
        <div class="dt-main" tabindex="-1">
          <table class="dt-table" aria-label="Registries">
            <thead>
              <tr>
                <th>{kind() === "web" ? "Slot" : "Registry"}</th>
                <th style={{ width: "50px" }}>Items</th>
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
                  <tr data-row data-selected={current()?.name === row.name} onClick={() => setSelected(row.name)}>
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
                      <Show when={view.contract}>{(name) => <span class="dt-muted">contracts.{name()}</span>}</Show>
                    </div>
                    <div class="dt-side-body">
                      <dl class="dt-facts">
                        <dt>Shows</dt>
                        <dd>{view.shows === "first" ? "the first item by order; the rest are replaced" : "every item, in order"}</dd>
                      </dl>
                      <Section title="Items" aside="by order, then plugin">
                        <Show when={view.items.length > 0} fallback={<p class="dt-muted">Empty: nothing adds to it now.</p>}>
                          <table class="dt-table" aria-label="Registry items">
                            <tbody>
                              <For each={view.items}>
                                {(item, index) => (
                                  <tr data-row>
                                    <td class="dt-num dt-muted" style={{ width: "40px" }}>
                                      {item.order}
                                    </td>
                                    <td class="dt-code">{item.id}</td>
                                    <td>
                                      <PluginName deps={deps} kind="web" id={item.plugin} />
                                    </td>
                                    <td class="dt-muted">{view.shows === "first" ? (index() === 0 ? "shown" : "replaced") : ""}</td>
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
function InspectorsPanel(props: { deps: Deps; inspectors: Accessor<readonly InspectorInfo[]> }) {
  const { deps } = props;
  const [selected, setSelected] = createSignal<string>();
  followSubject(deps, INSPECTORS_PANEL, setSelected);
  const current = () => props.inspectors().find((inspector) => inspector.id === selected()) ?? props.inspectors()[0];
  const [snapshot, { refetch }] = createResource(
    () => current()?.id,
    async (id) => {
      try {
        return { value: await deps.client.host.host.inspect(id) };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    },
  );
  const timer = setInterval(() => void refetch(), INSPECT_EVERY);
  onCleanup(() => clearInterval(timer));
  return (
    <div class="dt-scope">
      <div class="dt-toolbar" role="toolbar" aria-label="Inspectors toolbar">
        <button class="dt-chip" onClick={() => void refetch()}>
          Refresh
        </button>
        <span class="dt-sep" />
        <span class="dt-muted">Host plugins add these to the Inspectors registry; open ones refresh every {INSPECT_EVERY / 1000}s.</span>
      </div>
      <div class="dt-split">
        <div class="dt-main" tabindex="-1" style={{ "max-width": "380px" }}>
          <table class="dt-table" aria-label="Inspectors">
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
                  <tr data-row data-selected={current()?.id === inspector.id} onClick={() => setSelected(inspector.id)}>
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
            <section class="dt-details" style={{ flex: "1" }} aria-label="Inspector snapshot">
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

/**
 * The kernel's panels, for the web app and the host alike (both run the
 * core): every plugin and everything it does, each hook's chain, every
 * registry, and what host plugins let you look into. A plugin's name anywhere
 * in the devtools opens it here.
 */
export function kernelPanels(deps: Deps): readonly SlotItem<contracts.DevtoolsPanel>[] {
  // Read again whenever the host's plugins change: inspectors come and go with them.
  const [inspectors] = createResource(
    () => deps.lists.host(),
    () => deps.client.host.host.inspectors().catch(() => [] as readonly InspectorInfo[]),
    { initialValue: [] },
  );
  return [
    {
      id: PLUGIN_PANEL,
      order: 20,
      title: "Plugins",
      component: () => <PluginsPanel deps={deps} inspectors={inspectors} />,
      snapshot: () => ({ web: deps.lists.web(), host: deps.lists.host() }),
    },
    {
      id: "devtools.hooks",
      order: 30,
      title: "Hooks",
      component: () => <HooksPanel deps={deps} />,
      snapshot: () => ({ web: kernelFor(deps, "web"), host: kernelFor(deps, "host") }),
    },
    {
      id: "devtools.registries",
      order: 40,
      title: "Registries",
      component: () => <RegistriesPanel deps={deps} />,
      snapshot: () => ({ web: slotViews(deps.slots), host: kernelOf(deps.lists.host()).registries }),
    },
    {
      id: INSPECTORS_PANEL,
      order: 50,
      title: "Inspectors",
      component: () => <InspectorsPanel deps={deps} inspectors={inspectors} />,
      snapshot: () => inspectors(),
    },
  ];
}
