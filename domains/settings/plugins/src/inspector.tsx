import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import type { JSX } from "solid-js";
import { KERNEL_LABEL, capabilityName, recoverable, usersOf } from "@lemma/contracts";
import type { PluginStatus } from "@lemma/contracts";
import { PluginTabs, PluginsFacts } from "@lemma/settings";
import type { PluginsFact } from "@lemma/settings";
import { Contained } from "@lemma/web";
import type { ClientService, PluginsService, SlotsService, WebPluginsService } from "@lemma/web";
import { focusStep } from "@lemma/web/keys";
import { plural, tildePath } from "@lemma/web/format";
import { ChevronIcon, ConfigForm, SearchField, Segmented, Spinner, Toggle, XIcon } from "@lemma/look";
import {
  PLUGIN_FILTERS,
  dependentsOf,
  describeState,
  domainOf,
  groupPlugins,
  halvesOf,
  matchPlugins,
  pairHalves,
  replaces,
  summarizeDomain,
  waitingOn,
} from "./plugins.ts";
import type { KindedPlugin, PluginGroup, PluginKind } from "./plugins.ts";

/** Each app's runtime, as the summary heads its list. */
const KIND_HEADING: Readonly<Record<PluginKind, string>> = { web: "Web app", host: "Host" };

/** A tab's id in the `plugins.tabs` slot. */
export type Tab = string;

export interface Selection {
  readonly kind: PluginKind;
  readonly id: string;
}

export interface Confirmation extends Selection {
  readonly enabled: boolean;
  /** What else the change touches: the dependents that stop, or the provider that is replaced. */
  readonly others: readonly string[];
}

const sourceLabel = (plugin: PluginStatus): string | undefined => (plugin.source === "user" ? "yours" : plugin.source === "project" ? "project" : undefined);

const describeSource = (plugin: PluginStatus, kind: PluginKind, home: string | undefined): string => {
  switch (plugin.source) {
    case "bundled":
      return kind === "host" ? "Bundled with Lemma" : "Bundled with the web app";
    case "user":
      return `${tildePath(`${home ?? "~/.lemma"}/plugins`, home)}${plugin.shadows ? ", in place of the bundled plugin with this id" : ""}`;
    case "project":
      return `.lemma/plugins in this project${plugin.shadows ? ", in place of the bundled plugin with this id" : ""}`;
  }
};

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** Everything the inspector's parts share. */
export interface Inspector {
  readonly client: ClientService;
  readonly webPlugins: WebPluginsService;
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
export function PluginLink(props: { inspector: Inspector; kind: PluginKind; id: string }) {
  const known = () => props.inspector.services[props.kind].list().some((plugin) => plugin.id === props.id);
  return (
    <Show when={known()} fallback={<span>{props.id}</span>}>
      <button class="link-button inspector-link" onClick={() => props.inspector.select({ kind: props.kind, id: props.id })}>
        {props.id}
      </button>
    </Show>
  );
}

/** The plugins `ids` names, each a link (`PluginLink`); `none` is what shows when there are none. */
export function Links(props: { inspector: Inspector; kind: PluginKind; ids: readonly string[]; none?: string }) {
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

/** Restarts the plugin (`force`: a running one, with the plugins that need it); off while a change runs. */
function RestartButton(props: { inspector: Inspector; kind: PluginKind; plugin: PluginStatus; force: boolean }) {
  return (
    <button class="button small" disabled={props.inspector.busy() !== undefined} onClick={() => props.inspector.restart(props.kind, props.plugin, props.force)}>
      Restart
    </button>
  );
}

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

/**
 * A domain's row: its plugins folded into one line, which a click, Enter, or Space opens and closes (→ opens, ← folds).
 * It takes the keyboard's focus as the table's arrow keys move through it (`data-nav`).
 */
function DomainRow(props: { group: PluginGroup; open: boolean; stop: boolean; onToggle: () => void }) {
  const summary = createMemo(() => summarizeDomain(props.group));
  const onKeyDown = (event: KeyboardEvent) => {
    const wants = event.key === "Enter" || event.key === " " ? !props.open : event.key === "ArrowRight" ? true : event.key === "ArrowLeft" ? false : undefined;
    if (wants === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    if (wants !== props.open) props.onToggle();
  };
  return (
    <div
      class="inspector-row inspector-domain"
      classList={{ open: props.open }}
      role="row"
      aria-expanded={props.open}
      tabindex={props.stop ? 0 : -1}
      data-nav={`domain:${props.group.domain}`}
      onClick={() => props.onToggle()}
      onKeyDown={onKeyDown}
    >
      <span class="inspector-name" role="rowheader">
        {/* The chevron turns in its own box: an icon's fallback, with look.kit off, takes no class. */}
        <span class="chevron">
          <ChevronIcon />
        </span>
        <span class={`state-dot state-${summary().tone}`} />
        <span class="plugin-id">{props.group.domain}</span>
        <span class="muted">{props.group.entries.length}</span>
        <Show when={summary().yours > 0}>
          <span class="tag">{summary().yours === props.group.entries.length ? "yours" : `${summary().yours} yours`}</span>
        </Show>
      </span>
      <span class="inspector-kind muted" role="cell">
        {summary().kinds}
      </span>
      <span class={`inspector-state tw:truncate state-text-${summary().tone === "failed" ? "failed" : "active"}`} role="cell">
        {summary().state}
      </span>
      <span role="cell" />
    </div>
  );
}

/** A plugin's row; `nested` under its domain's; `stop`, the table's one Tab stop. */
function Row(props: { inspector: Inspector; entry: KindedPlugin; nested?: boolean; stop: boolean }) {
  const { inspector } = props;
  const plugin = () => props.entry.plugin;
  /** The half whose state the row shows: the first half, unless it runs and its other half does not. */
  const shownState = () => {
    const pair = props.entry.pair?.plugin;
    return pair !== undefined && plugin().state === "active" && pair.state !== "active" ? pair : plugin();
  };
  const kind = () => props.entry.kind;
  const key = () => `${kind()}:${plugin().id}`;
  const selected = () => inspector.selected()?.id === plugin().id;
  const pending = () => {
    const confirming = inspector.confirming();
    return confirming?.id === plugin().id ? confirming : undefined;
  };
  return (
    <>
      <div
        class="inspector-row"
        classList={{ selected: selected(), off: !plugin().enabled, nested: props.nested === true }}
        role="row"
        aria-selected={selected()}
        tabindex={props.stop ? 0 : -1}
        data-key={key()}
        data-nav={key()}
        onClick={() => inspector.select({ kind: kind(), id: plugin().id })}
      >
        <span class="inspector-name" role="cell">
          <span class={`state-dot state-${plugin().state}`} />
          <span class="plugin-id">
            {/* Its section names the domain: the name stands out, and the id stays whole, as config rows write it. */}
            <Show when={domainOf(plugin().id)} fallback={plugin().id}>
              {(domain) => (
                <>
                  <span class="plugin-domain">{domain()}.</span>
                  {plugin().id.slice(domain().length + 1)}
                </>
              )}
            </Show>
          </span>
          <Show when={sourceLabel(plugin())}>{(label) => <span class="tag">{label()}</span>}</Show>
        </span>
        <span class="inspector-kind muted" role="cell">
          {props.entry.pair === undefined ? KERNEL_LABEL[kind()] : "host + web"}
        </span>
        <span class={`inspector-state tw:truncate state-text-${shownState().state}`} role="cell">
          {describeState(shownState())}
        </span>
        <span class="inspector-controls" role="cell" onClick={(event) => event.stopPropagation()}>
          <Show when={inspector.busy() === key()}>
            <Spinner />
          </Show>
          <Show when={recoverable(plugin())}>
            <RestartButton inspector={inspector} kind={kind()} plugin={plugin()} force={false} />
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

export function Overview(props: { inspector: Inspector; kind: PluginKind; plugin: PluginStatus }) {
  const { inspector } = props;
  const all = () => inspector.services[props.kind].list();
  const plugin = () => props.plugin;
  const stops = () => dependentsOf(all(), plugin().id);
  const waiting = () => waitingOn(all(), plugin().id);
  const replaced = () => replaces(all(), plugin().id);
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
                <Links inspector={inspector} kind={props.kind} ids={replaced()} /> when turned on: they provide the same thing
              </>
            ),
          ],
          [
            "Waiting",
            plugin().enabled || waiting().length === 0 ? undefined : (
              <>
                <Links inspector={inspector} kind={props.kind} ids={waiting()} /> start when it does
              </>
            ),
          ],
        ]}
      />
      <div class="plugin-actions">
        <Show when={recoverable(plugin())}>
          <RestartButton inspector={inspector} kind={props.kind} plugin={plugin()} force={false} />
          <span class="muted small">Starts it again, with the plugins it halted.</span>
        </Show>
        <Show when={plugin().state === "active" && plugin().locked === undefined}>
          <RestartButton inspector={inspector} kind={props.kind} plugin={plugin()} force />
          <span class="muted small">Stops it and the plugins that need it, then starts them again.</span>
        </Show>
      </div>
    </>
  );
}

export function SettingsTab(props: { inspector: Inspector; kind: PluginKind; plugin: PluginStatus }) {
  const file = () => `${props.plugin.configScope === "project" ? ".lemma/config.jsonc" : "config.jsonc"}, "plugins" › "${props.plugin.id}"`;
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
        <summary>
          <Disclosure />
          Effective config
        </summary>
        <pre>{JSON.stringify(props.plugin.config?.values ?? {}, null, 2)}</pre>
        <Show when={props.plugin.config?.secretsSet.length}>
          <p class="muted small">Set but not shown: {props.plugin.config!.secretsSet.join(", ")}</p>
        </Show>
      </details>
    </Show>
  );
}

export function Faults(props: { plugin: PluginStatus }) {
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

/** A plugin's line in the summary, drawn contained: one that throws leaves, a fault of the plugin that added it. */
function Fact(props: { fact: PluginsFact }) {
  return (
    <Show when={props.fact.value() !== undefined}>
      <dt>{props.fact.label}</dt>
      <dd data-tip={props.fact.tip}>{props.fact.value()}</dd>
    </Show>
  );
}

function HostFacts(props: { client: ClientService; slots: SlotsService; webPlugins: WebPluginsService }) {
  const files = () => props.webPlugins.files();
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
            config.jsonc in Home · .lemma/config.jsonc in Project; one "plugins" row per plugin, for both its halves
          </dd>
          <dt>Web app files</dt>
          <dd data-tip="Web halves load as web app plugins and stylesheets apply over the app's; a project's load only when it is trusted">
            {files().length === 0
              ? "none in plugins/ in Home"
              : files()
                  .map((file) => `${file.source === "user" ? "~" : "."}/plugins/${file.name}`)
                  .join(", ")}
          </dd>
          <dt>Composition</dt>
          <dd class="mono" data-tip={info().composition.id}>
            {info().composition.id.slice(0, 16)}
          </dd>
          <For each={props.slots.list(PluginsFacts)}>{(fact) => <Contained slot={PluginsFacts} item={fact} component={Fact} props={{ fact }} />}</For>
        </dl>
      )}
    </Show>
  );
}

/** A disclosure's chevron, first in its `<summary>`: it turns as the disclosure opens, as a domain's row's does. */
function Disclosure() {
  return (
    <span class="chevron">
      <ChevronIcon />
    </span>
  );
}

/** What each app provides itself, and who uses each: the runtime plugins are written against, which has no row. */
function Runtime(props: { inspector: Inspector }) {
  const { inspector } = props;
  const kinds = () => (["web", "host"] as const).filter((kind) => inspector.services[kind].runtime().length > 0);
  return (
    <section class="inspector-wiring inspector-runtime">
      <h3>Runtime</h3>
      <p class="muted small">Provided by each app itself, for its plugins to require; none replaces it, and it has no switch.</p>
      <For each={kinds()}>
        {(kind) => (
          <div class="inspector-runtime-kind">
            <h4>{KIND_HEADING[kind]}</h4>
            <ul>
              <For each={inspector.services[kind].runtime()}>
                {(key) => {
                  const users = () => usersOf(inspector.services[kind].list(), key);
                  return (
                    <li>
                      <details>
                        <summary>
                          <Disclosure />
                          <span class="capability" data-tip={key}>
                            {capabilityName(key)}
                          </span>
                          <span class="muted">used by {plural(users().length, "plugin")}</span>
                        </summary>
                        <div class="inspector-runtime-users">
                          <Links inspector={inspector} kind={kind} ids={users()} none="no plugin" />
                        </div>
                      </details>
                    </li>
                  );
                }}
              </For>
            </ul>
          </div>
        )}
      </For>
      <HostFacts client={inspector.client} slots={inspector.slots} webPlugins={inspector.webPlugins} />
    </section>
  );
}

/** With nothing selected: the composition as a whole. */
function Summary(props: { inspector: Inspector; entries: readonly KindedPlugin[] }) {
  const count = (test: (plugin: PluginStatus) => boolean) => props.entries.filter((entry) => test(entry.plugin)).length;
  /** A count's row, left out at none. */
  const unlessNone = (count: number) => (count === 0 ? undefined : String(count));
  return (
    <div class="inspector-summary">
      <p class="muted small">Select a plugin to see its state, wiring, settings, and faults.</p>
      <Facts
        rows={[
          ["Plugins", `${props.entries.length}: ${count((plugin) => plugin.state === "active")} running, ${count((plugin) => !plugin.enabled)} off`],
          ["Failed", unlessNone(count((plugin) => plugin.state === "failed"))],
          ["Waiting", unlessNone(count((plugin) => plugin.enabled && plugin.state === "disabled"))],
        ]}
      />
      <Runtime inspector={props.inspector} />
    </div>
  );
}

function Detail(props: { inspector: Inspector; entry: KindedPlugin }) {
  const { inspector } = props;
  /** The half shown: the one the selection names, when the plugin has it. */
  const half = () => halvesOf(props.entry).find((candidate) => candidate.kind === inspector.selected()?.kind) ?? props.entry;
  const plugin = () => half().plugin;
  const kind = () => half().kind;
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
        <Show
          when={props.entry.pair !== undefined}
          fallback={
            <span class="muted small">
              {KERNEL_LABEL[kind()]}
              {plugin().version === undefined ? "" : ` · ${plugin().version}`}
            </span>
          }
        >
          <Segmented
            label="Half"
            value={kind()}
            options={halvesOf(props.entry).map((candidate) => ({ value: candidate.kind, label: KERNEL_LABEL[candidate.kind] }))}
            onChange={(next) => inspector.select({ kind: next, id: plugin().id })}
          />
        </Show>
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
 * why it is in its state, how it meets the others (what it adds, intercepts,
 * observes, calls, and serves, and who uses that), its settings, and its
 * recent faults. Names in the details select that plugin.
 */
export function PluginsInspector(props: { inspector: Inspector; filter: () => string; setFilter: (value: string) => void }) {
  const { inspector } = props;
  // One row per plugin: a host half and a web half with one id are one plugin, with one row and one switch.
  const entries = createMemo((): KindedPlugin[] => pairHalves(inspector.services.host.list(), inspector.services.web.list()));
  const matched = createMemo(() => matchPlugins(entries(), props.filter()));
  /** The plugins as they are organized: each domain one row, which opens to its plugins; then those in no domain. */
  const groups = createMemo(() => groupPlugins(matched()));
  const domains = () => groups().filter((group) => group.domain !== "");
  const loose = () => groups().find((group) => group.domain === "")?.entries ?? [];
  // Domains start folded, and a filter shows the ones with a match open; either way a click folds or opens one. What is
  // open while filtering starts over with each filter, and the folded table comes back as it was when it is cleared.
  const filtering = () => props.filter().trim() !== "";
  const [opened, setOpened] = createSignal<ReadonlySet<string>>(new Set());
  const [shut, setShut] = createSignal<ReadonlySet<string>>(new Set());
  createEffect(on(props.filter, () => setShut(new Set<string>()), { defer: true }));
  let split!: HTMLDivElement;
  const isOpen = (domain: string) => (filtering() ? !shut().has(domain) : opened().has(domain));
  const flip = (set: ReadonlySet<string>, domain: string) => {
    const next = new Set(set);
    if (next.has(domain)) next.delete(domain);
    else next.add(domain);
    return next;
  };
  const toggle = (domain: string) => (filtering() ? setShut((was) => flip(was, domain)) : setOpened((was) => flip(was, domain)));
  // The selected plugin's domain opens, so its row shows: a link to it, a reload, or the keys moving to it.
  // While filtering too, so it is still open once the filter is cleared.
  createEffect(
    on(inspector.selected, (selection) => {
      const domain = domainOf(selection?.id ?? "");
      if (domain === undefined) return;
      if (!isOpen(domain)) toggle(domain);
      if (filtering() && !opened().has(domain)) setOpened((was) => new Set(was).add(domain));
    }),
  );
  /** The plugin rows that show, in order, for the keys that move the selection. */
  const shown = createMemo(() => groups().flatMap((group) => (group.domain === "" || isOpen(group.domain) ? group.entries : [])));
  const navKey = (entry: KindedPlugin) => `${entry.kind}:${entry.plugin.id}`;
  /**
   * The table's one Tab stop, among the rows that show: the selected plugin's, else its domain's row while that is
   * folded, else the first; its arrow keys move in it.
   */
  const stop = createMemo(() => {
    const id = inspector.selected()?.id;
    const chosen = shown().find((entry) => entry.plugin.id === id);
    if (chosen !== undefined) return navKey(chosen);
    const folded = id === undefined ? undefined : domainOf(id);
    if (folded !== undefined && domains().some((group) => group.domain === folded)) return `domain:${folded}`;
    const domain = domains()[0];
    if (domain !== undefined) return `domain:${domain.domain}`;
    const entry = loose()[0];
    return entry === undefined ? undefined : navKey(entry);
  });
  const current = () => {
    const selection = inspector.selected();
    return selection === undefined ? undefined : entries().find((entry) => entry.plugin.id === selection.id);
  };
  const selected = createMemo(() => {
    const entry = current();
    return entry === undefined ? undefined : entry.plugin.id;
  });
  let table!: HTMLDivElement;
  // Keep the selected row in view as the selection moves by keys or links, and, in a narrow page, where the details stood
  // in the table's place, the row they were for when they close; the details open at their top.
  createEffect(
    on(inspector.selected, (selection, previous) => {
      const narrow = getComputedStyle(split).getPropertyValue("--inspector-narrow").trim() === "1";
      if (selection !== undefined && narrow && selection.id !== previous?.id) split.scrollTop = 0;
      const shownFor = selection ?? (narrow ? previous : undefined);
      const entry = shownFor === undefined ? undefined : entries().find((candidate) => candidate.plugin.id === shownFor.id);
      if (entry === undefined) return;
      // Once drawn: its domain may open in this same change. A frame not yet come when the selection moves again, or
      // the table goes, is cancelled.
      const frame = requestAnimationFrame(() =>
        table?.querySelector(`[data-key="${CSS.escape(`${entry.kind}:${entry.plugin.id}`)}"]`)?.scrollIntoView({ block: "nearest" }),
      );
      onCleanup(() => cancelAnimationFrame(frame));
    }),
  );
  // The keys move through every row that shows, a domain's too (which Enter or → opens), and select a plugin's.
  const onKey = (event: KeyboardEvent) => {
    const next = focusStep(table, "[data-nav]", event.key, { from: table.querySelector('[data-nav][aria-selected="true"]') });
    if (next === undefined) return;
    event.preventDefault();
    const entry = shown().find((candidate) => navKey(candidate) === next.dataset.nav);
    if (entry !== undefined) inspector.select({ kind: entry.kind, id: entry.plugin.id });
  };
  return (
    <div class="inspector">
      <Show when={inspector.webPlugins.safe}>
        <p class="callout callout-warn">Safe mode: your rows and web halves are ignored here. Open the app without ?safe to use them.</p>
      </Show>
      <Show when={inspector.webPlugins.problems().length > 0}>
        <div class="callout callout-warn">
          <ul class="problems">
            <For each={inspector.webPlugins.problems()}>{(problem) => <li>{problem}</li>}</For>
          </ul>
        </div>
      </Show>
      <SearchField value={props.filter()} onInput={props.setFilter} placeholder={`Filter: ${PLUGIN_FILTERS.slice(0, 4).join(" ")} …`} label="Filter plugins">
        <span class="muted small">{matched().length === entries().length ? `${entries().length} plugins` : `${matched().length} of ${entries().length}`}</span>
      </SearchField>
      <div class="inspector-split" classList={{ "has-selection": selected() !== undefined }} ref={split}>
        {/* Focusable for a click between rows, which the arrow keys then move from; Tab stops at a row (`stop`). */}
        <div class="inspector-table" role="grid" aria-label="Plugins" tabindex="-1" ref={table} onKeyDown={onKey}>
          <div class="inspector-row inspector-head" role="row">
            <span role="columnheader">Plugin</span>
            <span role="columnheader">Kind</span>
            <span role="columnheader">State</span>
            <span role="columnheader" class="inspector-controls">
              On
            </span>
          </div>
          <Show when={matched().length > 0} fallback={<p class="settings-empty">No plugins match “{props.filter().trim()}”</p>}>
            <For each={domains()}>
              {(group) => (
                <div role="rowgroup" aria-label={group.domain}>
                  <DomainRow group={group} open={isOpen(group.domain)} stop={stop() === `domain:${group.domain}`} onToggle={() => toggle(group.domain)} />
                  <Show when={isOpen(group.domain)}>
                    <For each={group.entries}>{(entry) => <Row inspector={inspector} entry={entry} nested stop={stop() === navKey(entry)} />}</For>
                  </Show>
                </div>
              )}
            </For>
            <For each={loose()}>{(entry) => <Row inspector={inspector} entry={entry} stop={stop() === navKey(entry)} />}</For>
          </Show>
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
