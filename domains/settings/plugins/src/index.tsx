import { For, Show, createEffect, createMemo, createSignal, on } from "solid-js";
import type { JSX } from "solid-js";
import { KERNEL_LABEL, RUNTIME_LABEL, capabilityName, describeReload, pluginWiring, recoverable, usersOf } from "@lemma/contracts";
import type { PluginStatus } from "@lemma/contracts";
import { tildePath } from "@lemma/web/format";
import {
  PLUGIN_FILTERS,
  dependentsOf,
  describeState,
  domainOf,
  groupPlugins,
  halvesOf,
  matchPlugins,
  pairHalves,
  pluginText,
  replaces,
  summarizeDomain,
  waitingOn,
} from "./plugins.ts";
import type { KindedPlugin, PluginGroup, PluginKind } from "./plugins.ts";
import { stepFor } from "@lemma/web/keys";
import { Actions } from "@lemma/actions";
import { PluginTabs, PluginsFacts, SectionIds, Settings, SettingsGroups, SettingsSections } from "@lemma/settings";
import { Client, HostPlugins, Notify, Slots, WebPlugins, defineWebPlugin, Contained } from "@lemma/web";
import type { PluginTab, PluginsFact } from "@lemma/settings";
import type { ClientService, PluginsService, WebPluginsService, SlotsService } from "@lemma/web";
import { ChevronIcon, ConfigForm, PuzzleIcon, RefreshIcon, SearchField, Segmented, Spinner, Toggle, XIcon } from "@lemma/look";
import styles from "./plugins-page.css?inline";

const SECTION = SectionIds.plugins;
const DEFAULT_TAB = "plugins.overview";

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
  const dir = "plugins";
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

/**
 * A domain's row: its plugins folded into one line, which a click, Enter, or Space opens and closes (→ opens, ← folds).
 * It takes the keyboard's focus as the table's arrow keys move through it (`data-nav`).
 */
function DomainRow(props: { group: PluginGroup; open: boolean; onToggle: () => void }) {
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
      tabindex="-1"
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
      <span class={`inspector-state state-text-${summary().tone === "failed" ? "failed" : "active"}`} role="cell">
        {summary().state}
      </span>
      <span role="cell" />
    </div>
  );
}

/** A plugin's row; `nested` under its domain's. */
function Row(props: { inspector: Inspector; entry: KindedPlugin; nested?: boolean }) {
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
        tabindex="-1"
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
        <span class={`inspector-state state-text-${shownState().state}`} role="cell">
          {describeState(shownState())}
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

/**
 * How a plugin meets the others, in the five shapes every domain's contract offers: what it adds to registries and
 * slots, the hooks it intercepts, the events it observes, the capabilities it calls, and what it serves (capabilities,
 * and channels to clients).
 */
function Wiring(props: { inspector: Inspector; kind: PluginKind; plugin: PluginStatus }) {
  const { inspector } = props;
  const wiring = createMemo(() => {
    const service = inspector.services[props.kind];
    return pluginWiring(service.list(), props.plugin, service.runtime());
  });
  return (
    <div class="inspector-wiring">
      <section>
        <h3>Adds</h3>
        <Show when={wiring().adds.length > 0} fallback={<p class="muted small">Nothing to a registry or slot.</p>}>
          <ul>
            <For each={wiring().adds}>
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
      <section>
        <h3>Intercepts</h3>
        <Show when={wiring().hooks.length > 0 || wiring().parts.length > 0} fallback={<p class="muted small">No hook or part.</p>}>
          <ul>
            <For each={wiring().parts}>
              {(part) => (
                <li>
                  <span class="capability">{part.name}</span>
                  <span class="muted"> draws it: {part.keys?.join(", ") ?? `${part.items} ${part.items === 1 ? "item" : "items"}`}</span>
                </li>
              )}
            </For>
            <For each={wiring().hooks}>
              {(hook) => (
                <li>
                  <span class="capability">{hook.name}</span>
                  <span class="muted">
                    {" "}
                    {hook.phase === undefined ? "" : `${hook.phase} · `}order {hook.order} · {hook.of > 1 ? `${hook.position} of ${hook.of}` : "only handler"}
                  </span>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>
      <section>
        <h3>Observes</h3>
        <Show when={wiring().observes.length > 0} fallback={<p class="muted small">No event.</p>}>
          <ul>
            <For each={wiring().observes}>{(event) => <li class="capability">{event}</li>}</For>
          </ul>
        </Show>
      </section>
      <section>
        <h3>Calls</h3>
        <Show when={wiring().calls.length > 0} fallback={<p class="muted small">No capability.</p>}>
          <ul>
            <For each={wiring().calls}>
              {(call) => (
                <li>
                  <span class="capability" data-tip={call.key}>
                    {capabilityName(call.key)}
                  </span>
                  <span class="muted"> from </span>
                  <Show when={call.providers[0]} fallback={<span class="muted">{call.runtime ? RUNTIME_LABEL[props.kind] : "no plugin"}</span>}>
                    {(provider) => <PluginLink inspector={inspector} kind={props.kind} id={provider().id} />}
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>
      <section>
        <h3>Serves</h3>
        <Show when={wiring().serves.length > 0 || wiring().channels.length > 0} fallback={<p class="muted small">Nothing; other plugins do not call it.</p>}>
          <ul>
            <For each={wiring().serves}>
              {(serve) => (
                <li>
                  <span class="capability" data-tip={serve.key}>
                    {capabilityName(serve.key)}
                  </span>
                  <span class="muted"> used by </span>
                  <Links inspector={inspector} kind={props.kind} ids={serve.users} none="no plugin" />
                </li>
              )}
            </For>
            <Show when={wiring().channels.length > 0}>
              <li>
                <span class="capability">channels</span>
                <span class="muted"> {wiring().channels.join(", ")}</span>
              </li>
            </Show>
          </ul>
        </Show>
      </section>
    </div>
  );
}

function SettingsTab(props: { inspector: Inspector; kind: PluginKind; plugin: PluginStatus }) {
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

/** What each app provides itself, and who uses each: the runtime plugins are written against, which has no row. */
function Runtime(props: { inspector: Inspector }) {
  const { inspector } = props;
  const kinds = () => (["web", "host"] as const).filter((kind) => inspector.services[kind].runtime().length > 0);
  return (
    <section class="inspector-wiring inspector-runtime">
      <h3>Runtime</h3>
      <For each={kinds()}>
        {(kind) => (
          <>
            <p class="muted small">Provided by {RUNTIME_LABEL[kind]} itself, for its plugins to require; none replaces it, and it has no switch.</p>
            <ul>
              <For each={inspector.services[kind].runtime()}>
                {(key) => {
                  const users = () => usersOf(inspector.services[kind].list(), key);
                  return (
                    <li>
                      <details>
                        <summary>
                          <span class="capability" data-tip={key}>
                            {capabilityName(key)}
                          </span>
                          <span class="muted"> used by {users().length === 1 ? "1 plugin" : `${users().length} plugins`}</span>
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
          </>
        )}
      </For>
      <HostFacts client={inspector.client} slots={inspector.slots} webPlugins={inspector.webPlugins} />
    </section>
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
function PluginsInspector(props: { inspector: Inspector; filter: () => string; setFilter: (value: string) => void }) {
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
      // Once drawn: its domain may open in this same change.
      if (entry !== undefined)
        requestAnimationFrame(() =>
          table?.querySelector(`[data-key="${CSS.escape(`${entry.kind}:${entry.plugin.id}`)}"]`)?.scrollIntoView({ block: "nearest" }),
        );
    }),
  );
  // The keys move through every row that shows, a domain's too (which Enter or → opens), and select a plugin's.
  const onKey = (event: KeyboardEvent) => {
    const rows = [...table.querySelectorAll<HTMLElement>("[data-nav]")];
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement.closest<HTMLElement>("[data-nav]") : null;
    const from = focused ?? table.querySelector<HTMLElement>('[data-nav][aria-selected="true"]');
    const step = stepFor(event.key, from === null ? -1 : rows.indexOf(from), rows.length);
    if (step === undefined) return;
    event.preventDefault();
    const next = rows[step];
    next?.focus();
    const entry = shown().find((candidate) => `${candidate.kind}:${candidate.plugin.id}` === next?.dataset.nav);
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
        <div class="inspector-table" role="grid" aria-label="Plugins" tabindex="0" ref={table} onKeyDown={onKey}>
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
                  <DomainRow group={group} open={isOpen(group.domain)} onToggle={() => toggle(group.domain)} />
                  <Show when={isOpen(group.domain)}>
                    <For each={group.entries}>{(entry) => <Row inspector={inspector} entry={entry} nested />}</For>
                  </Show>
                </div>
              )}
            </For>
            <For each={loose()}>{(entry) => <Row inspector={inspector} entry={entry} />}</For>
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

/** The Plugins section: the inspector over the host's plugins and this web app's. */
export default defineWebPlugin({
  id: "settings.plugins",
  styles,
  requires: { client: Client, notify: Notify, settings: Settings, slots: Slots, host: HostPlugins, webPlugins: WebPlugins },
  setup: ({ client, notify, settings, slots, host, webPlugins }, plugin) => {
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
    // A memo: a change of selection or tab in the address is no change of filter.
    const filter = createMemo(() => params().filter ?? "");
    const setFilter = (next: string) => settings.setParams({ filter: next });
    const [confirming, setConfirming] = createSignal<Confirmation>();
    const [busy, setBusy] = createSignal<string>();
    const services: Readonly<Record<PluginKind, PluginsService>> = { host, web: webPlugins };
    const run = async (key: string, action: () => Promise<void>) => {
      setBusy(key);
      try {
        await action();
      } finally {
        setBusy(undefined);
      }
    };
    // The host defers a change asked for here only when it restarts the transport serving the request: it applies once
    // the reply is out, dropping the connection.
    const deferredNote = "the host restarts the transport once this reply is out, and this page reconnects";

    const inspector: Inspector = {
      client,
      webPlugins,
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
          const result = await host.reload();
          const summary = describeReload(result);
          notify.toast({
            level: "info",
            message: result.deferred
              ? "Reloading config: the host restarts the plugins it changes, the transport among them, and this page reconnects"
              : summary === undefined
                ? "Config reloaded; nothing changed"
                : `Config reloaded: ${summary}`,
          });
        } catch (error) {
          notify.report(error, "Reload failed");
        }
      });

    const failed = () => [...host.list(), ...webPlugins.list()].filter((candidate) => candidate.state === "failed").length;
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
            onClick={plugin.action("reload config", reload)}
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
                <span class="muted small">{KERNEL_LABEL[kind]}</span>
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
