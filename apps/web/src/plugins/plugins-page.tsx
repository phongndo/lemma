import { For, Show, createEffect, createMemo, createSignal, on } from "solid-js";
import type { JSX } from "solid-js";
import { capabilityName, describeReload, hookChain, providerOf, recoverable, usersOf } from "@lemma/contracts";
import type { PluginStatus } from "@lemma/contracts";
import { tildePath } from "../model/format.ts";
import { PLUGIN_FILTERS, dependentsOf, describeState, matchPlugins, pluginText, replaces, waitingOn } from "../model/plugins.ts";
import type { KindedPlugin, PluginKind } from "../model/plugins.ts";
import { Actions, Client, HostPlugins, Notify, PluginTabs, Threads, Settings, SettingsGroups, SettingsSections, Slots, UiPlugins } from "../ui/contracts.ts";
import type { ClientService, PluginTab, PluginsService, ThreadsService, UiPluginsService } from "../ui/contracts.ts";
import { defineUiPlugin } from "../ui/define.ts";
import type { SlotsService } from "../ui/slots.ts";
import { ConfigForm, Contained, PuzzleIcon, RefreshIcon, SearchField, Spinner, Toggle, XIcon } from "../ui/parts.tsx";
import styles from "./plugins-page.css?inline";

const SECTION = "plugins";
const DEFAULT_TAB = "plugins.overview";
const KIND_LABEL: Readonly<Record<PluginKind, string>> = { host: "host", web: "web app" };

/** A tab's id in the `plugins.tabs` slot. */
type Tab = string;

interface Selection {
  readonly kind: PluginKind;
  readonly id: string;
}

interface Confirmation extends Selection {
  readonly enabled: boolean;
  /** What else the change touches: the dependents that stop, or the provider that is replaced. */
  readonly others: readonly string[];
}

const sourceLabel = (plugin: PluginStatus): string | undefined => (plugin.source === "user" ? "yours" : plugin.source === "project" ? "project" : undefined);

const describeSource = (plugin: PluginStatus, kind: PluginKind, home: string | undefined): string => {
  const dir = kind === "host" ? "plugins" : "ui";
  switch (plugin.source) {
    case "bundled":
      return kind === "host" ? "Bundled with Lemma" : "Bundled with the web app";
    case "user":
      return `${tildePath(`${home ?? "~/.lemma"}/${dir}`, home)}${plugin.shadows ? ", in place of the bundled plugin with this id" : ""}`;
    case "project":
      return `.lemma/${dir} in this project${plugin.shadows ? ", in place of the bundled plugin with this id" : ""}`;
  }
};

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** Everything the inspector's parts share. */
interface Inspector {
  readonly client: ClientService;
  readonly threads: ThreadsService;
  readonly ui: UiPluginsService;
  readonly slots: SlotsService;
  readonly services: Readonly<Record<PluginKind, PluginsService>>;
  readonly selected: () => Selection | undefined;
  readonly select: (next: Selection | undefined) => void;
  readonly tab: () => Tab;
  readonly setTab: (tab: Tab) => void;
  readonly confirming: () => Confirmation | undefined;
  readonly setConfirming: (next: Confirmation | undefined) => void;
  /** `<kind>:<id>` of the change running, which locks the others; "reload" while config reloads. */
  readonly busy: () => string | undefined;
  readonly restart: (kind: PluginKind, plugin: PluginStatus, force: boolean) => void;
  readonly toggle: (kind: PluginKind, plugin: PluginStatus, enabled: boolean) => void;
  readonly configure: (kind: PluginKind, plugin: PluginStatus, values: Readonly<Record<string, unknown>>) => Promise<void>;
}

/** A plugin's id as a link that selects it; plain text for one this app does not know. */
function PluginLink(props: { inspector: Inspector; kind: PluginKind; id: string }) {
  const known = () => props.inspector.services[props.kind].list().some((plugin) => plugin.id === props.id);
  return (
    <Show when={known()} fallback={<span>{props.id}</span>}>
      <button class="link-button inspector-link" onClick={() => props.inspector.select({ kind: props.kind, id: props.id })}>
        {props.id}
      </button>
    </Show>
  );
}

function Links(props: { inspector: Inspector; kind: PluginKind; ids: readonly string[]; none: string }) {
  return (
    <Show when={props.ids.length > 0} fallback={<span class="muted">{props.none}</span>}>
      <For each={props.ids}>
        {(id, index) => (
          <>
            {index() > 0 ? ", " : ""}
            <PluginLink inspector={props.inspector} kind={props.kind} id={id} />
          </>
        )}
      </For>
    </Show>
  );
}

/** Turning a plugin on or off, asking first when that stops or replaces others. */
const askToggle = (inspector: Inspector, kind: PluginKind, plugin: PluginStatus, enabled: boolean) => {
  const all = inspector.services[kind].list();
  const others = enabled ? replaces(all, plugin.id) : dependentsOf(all, plugin.id);
  if (others.length > 0) {
    inspector.setConfirming({ kind, id: plugin.id, enabled, others });
    return;
  }
  inspector.setConfirming(undefined);
  inspector.toggle(kind, plugin, enabled);
};

function Confirm(props: { inspector: Inspector; plugin: PluginStatus; pending: Confirmation }) {
  return (
    <div class="plugin-confirm" role="alertdialog" aria-label={`Turn ${props.plugin.id} ${props.pending.enabled ? "on" : "off"}?`}>
      <span>
        <Show
          when={props.pending.enabled}
          fallback={
            <>
              Turning off <b>{props.plugin.id}</b> also stops {props.pending.others.join(", ")}. They start again when it does.
            </>
          }
        >
          Turning on <b>{props.plugin.id}</b> turns off {props.pending.others.join(", ")}, which provides the same thing; plugins using it restart.
        </Show>
      </span>
      <span class="spacer" />
      <button class="button small" onClick={() => props.inspector.setConfirming(undefined)}>
        Cancel
      </button>
      <button
        class="button small"
        onClick={() => {
          const { kind, enabled } = props.pending;
          props.inspector.setConfirming(undefined);
          props.inspector.toggle(kind, props.plugin, enabled);
        }}
      >
        {props.pending.enabled ? "Turn on" : "Turn off"}
      </button>
    </div>
  );
}

function Row(props: { inspector: Inspector; entry: KindedPlugin }) {
  const { inspector } = props;
  const plugin = () => props.entry.plugin;
  const kind = () => props.entry.kind;
  const key = () => `${kind()}:${plugin().id}`;
  const selected = () => inspector.selected()?.kind === kind() && inspector.selected()?.id === plugin().id;
  const pending = () => {
    const confirming = inspector.confirming();
    return confirming?.kind === kind() && confirming.id === plugin().id ? confirming : undefined;
  };
  return (
    <>
      <div
        class="inspector-row"
        classList={{ selected: selected(), off: !plugin().enabled }}
        role="row"
        aria-selected={selected()}
        data-key={key()}
        onClick={() => inspector.select({ kind: kind(), id: plugin().id })}
      >
        <span class="inspector-name" role="cell">
          <span class={`state-dot state-${plugin().state}`} />
          <span class="plugin-id">{plugin().id}</span>
          <Show when={sourceLabel(plugin())}>{(label) => <span class="tag">{label()}</span>}</Show>
        </span>
        <span class="inspector-kind muted" role="cell">
          {KIND_LABEL[kind()]}
        </span>
        <span class={`inspector-state state-text-${plugin().state}`} role="cell">
          {describeState(plugin())}
        </span>
        <span class="inspector-controls" role="cell" onClick={(event) => event.stopPropagation()}>
          <Show when={inspector.busy() === key()}>
            <Spinner />
          </Show>
          <Show when={recoverable(plugin())}>
            <button class="button small" disabled={inspector.busy() !== undefined} onClick={() => inspector.restart(kind(), plugin(), false)}>
              Restart
            </button>
          </Show>
          <span data-tip={plugin().locked ?? (plugin().enabled ? `Turn ${plugin().id} off` : `Turn ${plugin().id} on`)}>
            <Toggle
              label={`${plugin().id} on`}
              checked={plugin().enabled}
              disabled={plugin().locked !== undefined || inspector.busy() !== undefined}
              onChange={(enabled) => askToggle(inspector, kind(), plugin(), enabled)}
            />
          </span>
        </span>
      </div>
      <Show when={pending()}>{(confirm) => <Confirm inspector={inspector} plugin={plugin()} pending={confirm()} />}</Show>
    </>
  );
}

function Facts(props: { rows: readonly (readonly [string, JSX.Element | undefined])[] }) {
  return (
    <dl class="plugin-details inspector-facts">
      <For each={props.rows.filter(([, value]) => value !== undefined && value !== false)}>
        {([label, value]) => (
          <>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </>
        )}
      </For>
    </dl>
  );
}

function Overview(props: { inspector: Inspector; kind: PluginKind; plugin: PluginStatus }) {
  const { inspector } = props;
  const all = () => inspector.services[props.kind].list();
  const plugin = () => props.plugin;
  const stops = () => dependentsOf(all(), plugin().id);
  const waiting = () => waitingOn(all(), plugin().id);
  const replaced = () => replaces(all(), plugin().id);
  const busy = () => inspector.busy() !== undefined;
  return (
    <>
      <Show when={plugin().fault}>
        {(fault) => (
          <pre class="plugin-fault">
            {fault().phase}
            {fault().operation ? ` · ${fault().operation}` : ""}: {fault().message}
          </pre>
        )}
      </Show>
      <Facts
        rows={[
          ["State", describeState(plugin())],
          [
            "Why",
            plugin().problem !== undefined ? (
              `Left out: ${plugin().problem}`
            ) : plugin().haltedBy === undefined ? undefined : (
              <>
                {plugin().state === "disabled" ? "Needs " : "Halted by "}
                <PluginLink inspector={inspector} kind={props.kind} id={plugin().haltedBy!} />
                {plugin().state === "disabled" ? ", which is off" : ", which failed"}
              </>
            ),
          ],
          ["Source", describeSource(plugin(), props.kind, inspector.client.info()?.home)],
          ["Version", plugin().version],
          ["Set in", plugin().scope === undefined ? undefined : `The ${plugin().scope} config file`],
          ["Locked", plugin().locked],
          [
            "Turning off",
            !plugin().enabled || plugin().locked !== undefined ? undefined : (
              <>
                stops <Links inspector={inspector} kind={props.kind} ids={stops()} none="nothing else" />
              </>
            ),
          ],
          [
            "Replaces",
            plugin().enabled || replaced().length === 0 ? undefined : (
              <>
                <Links inspector={inspector} kind={props.kind} ids={replaced()} none="" /> when turned on: they provide the same thing
              </>
            ),
          ],
          [
            "Waiting",
            plugin().enabled || waiting().length === 0 ? undefined : (
              <>
                <Links inspector={inspector} kind={props.kind} ids={waiting()} none="" /> start when it does
              </>
            ),
          ],
        ]}
      />
      <div class="plugin-actions">
        <Show when={recoverable(plugin())}>
          <button class="button small" disabled={busy()} onClick={() => inspector.restart(props.kind, plugin(), false)}>
            Restart
          </button>
          <span class="muted small">Starts it again, with the plugins it halted.</span>
        </Show>
        <Show when={plugin().state === "active" && plugin().locked === undefined}>
          <button class="button small" disabled={busy()} onClick={() => inspector.restart(props.kind, plugin(), true)}>
            Restart
          </button>
          <span class="muted small">Stops it and the plugins that need it, then starts them again.</span>
        </Show>
      </div>
    </>
  );
}

function Wiring(props: { inspector: Inspector; kind: PluginKind; plugin: PluginStatus }) {
  const { inspector } = props;
  const all = () => inspector.services[props.kind].list();
  const plugin = () => props.plugin;
  /** Where its handler runs among every plugin's handlers of that hook. */
  const position = (name: string, order: number) => {
    const chain = hookChain(all(), name);
    const index = chain.findIndex((entry) => entry.plugin === plugin().id && entry.order === order);
    return chain.length > 1 ? `${index + 1} of ${chain.length}` : "only handler";
  };
  const contributions = () => plugin().contributes ?? [];
  return (
    <div class="inspector-wiring">
      <section>
        <h3>Provides</h3>
        <Show when={plugin().provides.length > 0} fallback={<p class="muted small">Nothing; it contributes through hooks, events, or slots.</p>}>
          <ul>
            <For each={plugin().provides}>
              {(key) => (
                <li>
                  <span class="capability" data-tip={key}>
                    {capabilityName(key)}
                  </span>
                  <span class="muted"> used by </span>
                  <Links inspector={inspector} kind={props.kind} ids={usersOf(all(), key)} none="no plugin" />
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>
      <section>
        <h3>Requires</h3>
        <Show when={plugin().requires.length > 0} fallback={<p class="muted small">Nothing.</p>}>
          <ul>
            <For each={plugin().requires}>
              {(key) => (
                <li>
                  <span class="capability" data-tip={key}>
                    {capabilityName(key)}
                  </span>
                  <span class="muted"> from </span>
                  <Show when={providerOf(all(), key)} fallback={<span class="muted">no plugin</span>}>
                    {(provider) => <PluginLink inspector={inspector} kind={props.kind} id={provider().id} />}
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>
      <section>
        <h3>Hooks</h3>
        <Show when={plugin().hooks?.length} fallback={<p class="muted small">It intercepts no hooks.</p>}>
          <ul>
            <For each={plugin().hooks}>
              {(hook) => (
                <li>
                  <span class="capability">{hook.name}</span>
                  <span class="muted">
                    {" "}
                    order {hook.order} · {position(hook.name, hook.order)}
                  </span>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>
      <section>
        <h3>Observes</h3>
        <Show when={plugin().observes?.length} fallback={<p class="muted small">It observes no events.</p>}>
          <ul>
            <For each={plugin().observes}>{(event) => <li class="capability">{event}</li>}</For>
          </ul>
        </Show>
      </section>
      <section>
        <h3>Contributes</h3>
        <Show when={contributions().length > 0} fallback={<p class="muted small">It contributes to no registry.</p>}>
          <ul>
            <For each={contributions()}>
              {(registry) => (
                <li>
                  <span class="capability">{registry.name}</span>
                  <span class="muted"> {registry.keys?.join(", ") ?? `${registry.items} ${registry.items === 1 ? "item" : "items"}`}</span>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>
    </div>
  );
}

function SettingsTab(props: { inspector: Inspector; kind: PluginKind; plugin: PluginStatus }) {
  const file = () =>
    `${props.plugin.configScope === "project" ? ".lemma/config.jsonc" : "config.jsonc"}, "${props.kind === "host" ? "plugins" : "ui"}" › "${props.plugin.id}"`;
  return (
    <Show when={props.plugin.configFields?.length} fallback={<p class="muted small">It takes no config.</p>}>
      <ConfigForm
        fields={props.plugin.configFields!}
        config={props.plugin.config}
        file={file()}
        disabled={props.inspector.busy() !== undefined}
        onSave={(values) => props.inspector.configure(props.kind, props.plugin, values)}
      />
      <details class="inspector-raw">
        <summary>Effective config</summary>
        <pre>{JSON.stringify(props.plugin.config?.values ?? {}, null, 2)}</pre>
        <Show when={props.plugin.config?.secretsSet.length}>
          <p class="muted small">Set but not shown: {props.plugin.config!.secretsSet.join(", ")}</p>
        </Show>
      </details>
    </Show>
  );
}

function Faults(props: { plugin: PluginStatus }) {
  const records = () => props.plugin.faults ?? [];
  return (
    <Show when={records().length > 0} fallback={<p class="muted small">No faults since {props.plugin.fault === undefined ? "it" : "this page"} started.</p>}>
      <ol class="inspector-faults">
        <For each={records()}>
          {(record) => (
            <li>
              <div class="inspector-fault-head">
                <span class="mono">{clock(record.at)}</span>
                <span class="tag">
                  {record.phase}
                  {record.operation === undefined ? "" : ` · ${record.operation}`}
                </span>
                <span class="muted small">#{record.sequence}</span>
              </div>
              <pre class="plugin-fault">{record.message}</pre>
            </li>
          )}
        </For>
      </ol>
    </Show>
  );
}

function HostFacts(props: { client: ClientService; threads: ThreadsService; ui: UiPluginsService }) {
  const running = () => props.threads.running();
  const files = () => props.ui.files();
  return (
    <Show when={props.client.info()}>
      {(info) => (
        <dl class="host-facts">
          <dt>Host</dt>
          <dd>
            {location.host} · transport {info().version}
          </dd>
          <dt>Home</dt>
          <dd>{info().home}</dd>
          <dt>Project</dt>
          <dd>{tildePath(info().cwd, info().home)}</dd>
          <dt>Config</dt>
          <dd data-tip="Switches here write the user file; a plugin the project file sets is written there instead">
            config.jsonc in Home · .lemma/config.jsonc in Project; "plugins" rows for the host, "ui" rows for the web app
          </dd>
          <dt>Web app files</dt>
          <dd data-tip="Scripts load as web app plugins and stylesheets apply over the app's; a project's load only when it is trusted">
            {files().length === 0
              ? "none in ui/ in Home"
              : files()
                  .map((file) => `${file.source === "user" ? "~" : "."}/${file.name}`)
                  .join(", ")}
          </dd>
          <dt>Composition</dt>
          <dd class="mono" data-tip={info().composition.id}>
            {info().composition.id.slice(0, 16)}
          </dd>
          <dt>Running</dt>
          <dd>{running().length === 0 ? "no turns" : `${running().length} turn${running().length === 1 ? "" : "s"}`}</dd>
        </dl>
      )}
    </Show>
  );
}

/** With nothing selected: the composition as a whole. */
function Summary(props: { inspector: Inspector; entries: readonly KindedPlugin[] }) {
  const count = (test: (plugin: PluginStatus) => boolean) => props.entries.filter((entry) => test(entry.plugin)).length;
  return (
    <div class="inspector-summary">
      <p class="muted small">Select a plugin to see its state, wiring, settings, and faults.</p>
      <Facts
        rows={[
          ["Plugins", `${count(() => true)}: ${count((plugin) => plugin.state === "active")} running, ${count((plugin) => !plugin.enabled)} off`],
          ["Failed", count((plugin) => plugin.state === "failed") === 0 ? undefined : String(count((plugin) => plugin.state === "failed"))],
          [
            "Waiting",
            count((plugin) => plugin.enabled && plugin.state === "disabled") === 0
              ? undefined
              : String(count((plugin) => plugin.enabled && plugin.state === "disabled")),
          ],
        ]}
      />
      <HostFacts client={props.inspector.client} threads={props.inspector.threads} ui={props.inspector.ui} />
    </div>
  );
}

function Detail(props: { inspector: Inspector; entry: KindedPlugin }) {
  const { inspector } = props;
  const plugin = () => props.entry.plugin;
  const kind = () => props.entry.kind;
  const tabs = () =>
    inspector.slots.list(PluginTabs).flatMap((tab) => {
      const label = tab.label(plugin(), kind());
      return label === undefined ? [] : [{ id: tab.id, label, item: tab }];
    });
  /** The chosen tab, or the first when it has none for this plugin. */
  const current = () => tabs().find((tab) => tab.id === inspector.tab()) ?? tabs()[0];
  // The same tab stays mounted, with its open disclosures and unsaved edits, while the plugin's status refreshes.
  const item = createMemo(() => current()?.item);
  return (
    <>
      <header class="inspector-detail-head">
        <span class={`state-dot state-${plugin().state}`} />
        <h2>{plugin().id}</h2>
        <span class="muted small">
          {KIND_LABEL[kind()]}
          {plugin().version === undefined ? "" : ` · ${plugin().version}`}
        </span>
        <span class="spacer" />
        <span class={`status-pill state-${plugin().state}`}>{describeState(plugin())}</span>
        <button class="icon-button" aria-label="Close details" onClick={() => inspector.select(undefined)}>
          <XIcon />
        </button>
      </header>
      <nav class="inspector-tabs" role="tablist">
        <For each={tabs()}>
          {(tab) => (
            <button
              role="tab"
              aria-selected={current()?.id === tab.id}
              classList={{ active: current()?.id === tab.id }}
              onClick={() => inspector.setTab(tab.id)}
            >
              {tab.label}
            </button>
          )}
        </For>
      </nav>
      <div class="inspector-tab-body">
        <Show when={item()} keyed>
          {(tab) => <Contained slot={PluginTabs} item={tab} component={tab.component} props={{ plugin: plugin(), kind: kind() }} />}
        </Show>
      </div>
    </>
  );
}

/**
 * Every plugin of the host and of this web app in one table, filtered like
 * the trajectory (`is:failed kind:web`), and the selected one in detail:
 * why it is in its state, what it provides and requires and who uses it,
 * the hooks, events, and slots it takes part in, its settings, and its
 * recent faults. Names in the details select that plugin.
 */
function PluginsInspector(props: { inspector: Inspector; filter: () => string; setFilter: (value: string) => void }) {
  const { inspector } = props;
  const entries = createMemo((): KindedPlugin[] => [
    ...inspector.services.host.list().map((plugin) => ({ kind: "host" as const, plugin })),
    ...inspector.services.web.list().map((plugin) => ({ kind: "web" as const, plugin })),
  ]);
  const shown = createMemo(() => matchPlugins(entries(), props.filter()));
  const current = () => {
    const selection = inspector.selected();
    return selection === undefined ? undefined : entries().find((entry) => entry.kind === selection.kind && entry.plugin.id === selection.id);
  };
  const selected = createMemo(() => {
    const entry = current();
    return entry === undefined ? undefined : `${entry.kind}:${entry.plugin.id}`;
  });
  let table!: HTMLDivElement;
  // Keep the selected row in view as the selection moves by keys or links.
  createEffect(
    on(inspector.selected, (selection) => {
      if (selection !== undefined)
        table?.querySelector(`[data-key="${CSS.escape(`${selection.kind}:${selection.id}`)}"]`)?.scrollIntoView({ block: "nearest" });
    }),
  );
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const rows = shown();
    if (rows.length === 0) return;
    const at = rows.findIndex((entry) => entry.kind === inspector.selected()?.kind && entry.plugin.id === inspector.selected()?.id);
    const next = rows[Math.max(0, Math.min(rows.length - 1, at + (event.key === "ArrowDown" ? 1 : -1)))]!;
    inspector.select({ kind: next.kind, id: next.plugin.id });
  };
  return (
    <div class="inspector">
      <Show when={inspector.ui.safe}>
        <p class="callout callout-warn">Safe mode: your "ui" rows and web app files are ignored. Open the app without ?safe to use them.</p>
      </Show>
      <Show when={inspector.ui.problems().length > 0}>
        <div class="callout callout-warn">
          <ul class="problems">
            <For each={inspector.ui.problems()}>{(problem) => <li>{problem}</li>}</For>
          </ul>
        </div>
      </Show>
      <SearchField value={props.filter()} onInput={props.setFilter} placeholder={`Filter: ${PLUGIN_FILTERS.slice(0, 4).join(" ")} …`} label="Filter plugins">
        <span class="muted small">{shown().length === entries().length ? `${entries().length} plugins` : `${shown().length} of ${entries().length}`}</span>
      </SearchField>
      <div class="inspector-split">
        <div class="inspector-table" role="grid" aria-label="Plugins" tabindex="0" ref={table} onKeyDown={onKey}>
          <div class="inspector-row inspector-head" role="row">
            <span role="columnheader">Plugin</span>
            <span role="columnheader">Kind</span>
            <span role="columnheader">State</span>
            <span role="columnheader" class="inspector-controls">
              On
            </span>
          </div>
          <For each={shown()} fallback={<p class="settings-empty">No plugins match “{props.filter().trim()}”</p>}>
            {(entry) => <Row inspector={inspector} entry={entry} />}
          </For>
        </div>
        <aside class="inspector-detail" aria-label="Plugin details">
          {/* A new selection starts fresh; a refresh of the selected plugin's status does not. */}
          <Show when={selected()} keyed fallback={<Summary inspector={inspector} entries={entries()} />}>
            <Show when={current()}>{(entry) => <Detail inspector={inspector} entry={entry()} />}</Show>
          </Show>
        </aside>
      </div>
    </div>
  );
}

/** The Plugins section: the inspector over the host's plugins and this web app's. */
export default defineUiPlugin({
  id: "plugins-page",
  styles,
  requires: { client: Client, threads: Threads, notify: Notify, settings: Settings, slots: Slots, host: HostPlugins, ui: UiPlugins },
  setup: ({ client, threads, notify, settings, slots, host, ui }) => {
    // In the address (`?plugin=agent&kind=host&tab=…&filter=…`): a link, a reload, and back and forward return to them, and
    // settings reopen the section as it was left.
    const params = () => (settings.section() === SECTION ? settings.params() : {});
    const selected = createMemo<Selection | undefined>(
      () => {
        const { plugin: id, kind } = params();
        return id === undefined ? undefined : { kind: kind === "web" ? "web" : "host", id };
      },
      undefined,
      { equals: (a, b) => a?.kind === b?.kind && a?.id === b?.id },
    );
    const tab = (): Tab => params().tab ?? DEFAULT_TAB;
    const setTab = (next: Tab) => settings.setParams({ tab: next === DEFAULT_TAB ? undefined : next });
    const filter = () => params().filter ?? "";
    const setFilter = (next: string) => settings.setParams({ filter: next });
    const [confirming, setConfirming] = createSignal<Confirmation>();
    const [busy, setBusy] = createSignal<string>();
    const services: Readonly<Record<PluginKind, PluginsService>> = { host, web: ui };
    const run = async (key: string, action: () => Promise<void>) => {
      setBusy(key);
      try {
        await action();
      } finally {
        setBusy(undefined);
      }
    };
    const deferredNote = "the host restarts it and the plugins that use it, and this page reconnects";

    const inspector: Inspector = {
      client,
      threads,
      ui,
      slots,
      services,
      selected,
      select: (next) => {
        settings.setParams({ plugin: next?.id, kind: next?.kind });
        setConfirming(undefined);
      },
      tab,
      setTab,
      confirming,
      setConfirming,
      busy,
      restart: (kind, target, force) =>
        void run(`${kind}:${target.id}`, async () => {
          try {
            await services[kind].restart(target, force ? { force } : undefined);
            notify.toast({ level: "info", message: `Restarted ${target.id}` });
          } catch (error) {
            notify.report(error, `Restart of ${target.id} failed`);
          }
        }),
      toggle: (kind, target, enabled) =>
        void run(`${kind}:${target.id}`, async () => {
          const verb = enabled ? "on" : "off";
          try {
            const result = await services[kind].setEnabled(target, enabled);
            if (result.deferred) {
              notify.toast({ level: "info", message: `Turned ${target.id} ${verb}; ${deferredNote}` });
              return;
            }
            const after = services[kind].list().find((candidate) => candidate.id === target.id);
            // What runs is what the files say; if another file still decides the other way, say so rather than claim success.
            if (after !== undefined && after.enabled !== enabled) {
              notify.toast({
                level: "warning",
                message: `${target.id} is still ${after.enabled ? "on" : "off"}: the ${after.scope ?? "user"} config decides it`,
              });
              return;
            }
            const also = describeReload(result, target.id);
            notify.toast({ level: "info", message: `Turned ${target.id} ${verb}${also === undefined ? "" : `; ${also}`}` });
          } catch (error) {
            notify.report(error, `Could not turn ${target.id} ${verb}`);
          }
        }),
      configure: (kind, target, values) =>
        run(`${kind}:${target.id}`, async () => {
          const fields = Object.keys(values).join(", ");
          try {
            const result = await services[kind].setConfig(target, values);
            const also = describeReload(result, target.id);
            notify.toast({
              level: "info",
              message: `Saved ${target.id} ${fields}${result.deferred ? `; ${deferredNote}` : also === undefined ? "" : `; ${also}`}`,
            });
          } catch (error) {
            notify.report(error, `Could not save ${target.id} ${fields}`);
          }
        }),
    };
    // Its own tabs go through the slot other plugins add theirs to.
    const addTab = (id: string, order: number, label: PluginTab["label"], component: PluginTab["component"]) =>
      slots.add(PluginTabs, { id, order, label, component });
    addTab(
      "plugins.overview",
      0,
      () => "Overview",
      (props) => <Overview inspector={inspector} kind={props.kind} plugin={props.plugin} />,
    );
    addTab(
      "plugins.wiring",
      10,
      () => "Wiring",
      (props) => <Wiring inspector={inspector} kind={props.kind} plugin={props.plugin} />,
    );
    addTab(
      "plugins.settings",
      20,
      (target) => (target.configFields?.length ? `Settings ${target.configFields.length}` : "Settings"),
      (props) => <SettingsTab inspector={inspector} kind={props.kind} plugin={props.plugin} />,
    );
    addTab(
      "plugins.faults",
      30,
      (target) => (target.faults?.length ? `Faults ${target.faults.length}` : "Faults"),
      (props) => <Faults plugin={props.plugin} />,
    );
    const reload = () =>
      run("reload", async () => {
        try {
          const summary = describeReload(await host.reload());
          notify.toast({ level: "info", message: summary === undefined ? "Config reloaded; nothing changed" : `Config reloaded: ${summary}` });
        } catch (error) {
          notify.report(error, "Reload failed");
        }
      });

    const failed = () => [...host.list(), ...ui.list()].filter((candidate) => candidate.state === "failed").length;
    slots.add(SettingsSections, {
      id: SECTION,
      order: 30,
      title: "Plugins",
      icon: PuzzleIcon,
      badge: () => (failed() > 0 ? `${failed()} failed` : undefined),
      body: () => <PluginsInspector inspector={inspector} filter={filter} setFilter={setFilter} />,
      actions: () => (
        <>
          <button
            class="icon-button"
            aria-label="Reload config"
            disabled={busy() !== undefined}
            onClick={() => void reload()}
            data-tip="Reload config: re-read the config files and apply them"
          >
            <Show when={busy() === "reload"} fallback={<RefreshIcon />}>
              <Spinner />
            </Show>
          </button>
        </>
      ),
    });
    // What the settings search finds; picking one opens it in the inspector.
    slots.add(SettingsGroups, {
      id: SECTION,
      section: SECTION,
      entries: () =>
        (["host", "web"] as const).flatMap((kind) =>
          services[kind].list().map((target) => ({
            text: `plugin ${kind === "web" ? "web app interface" : "host"} ${pluginText(target)}`,
            view: () => (
              <button class="setting-row inspector-result" onClick={() => settings.open(SECTION, { plugin: target.id, kind })}>
                <span class={`state-dot state-${target.state}`} />
                <span class="plugin-id">{target.id}</span>
                <span class="muted small">{KIND_LABEL[kind]}</span>
                <span class="spacer" />
                <span class={`status-pill state-${target.state}`}>{describeState(target)}</span>
              </button>
            ),
          })),
        ),
    });
    slots.add(Actions, {
      id: "plugins-page.open",
      order: 7,
      title: "Show plugins",
      category: "Host",
      keywords: ["status", "restart", "composition", "web app", "ui", "inspect"],
      icon: PuzzleIcon,
      run: () => settings.open(SECTION),
    });
  },
});
