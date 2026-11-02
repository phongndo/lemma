import { Show, createMemo, createSignal } from "solid-js";
import { KERNEL_LABEL, describeReload } from "@lemma/contracts";
import { Actions } from "@lemma/actions";
import { PluginTabs, SectionIds, Settings, SettingsGroups, SettingsSections } from "@lemma/settings";
import type { PluginTab } from "@lemma/settings";
import { Client, HostPlugins, Notify, Slots, WebPlugins, defineWebPlugin } from "@lemma/web";
import type { PluginsService } from "@lemma/web";
import { PuzzleIcon, RefreshIcon, Spinner } from "@lemma/look";
import { Faults, Overview, PluginsInspector, SettingsTab } from "./inspector.tsx";
import type { Confirmation, Inspector, Selection, Tab } from "./inspector.tsx";
import { describeState, pluginText } from "./plugins.ts";
import type { PluginKind } from "./plugins.ts";
import { Wiring } from "./wiring.tsx";
import styles from "./plugins-page.css?inline";

const SECTION = SectionIds.plugins;
const DEFAULT_TAB = "plugins.overview";

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
    const setFilter = (next: string) => settings.setParams({ filter: next === "" ? undefined : next });
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
      order: 90,
      title: "Plugins",
      icon: PuzzleIcon,
      description: "Every plugin of the host and of this app, turned on or off, configured, and inspected.",
      badge: () => (failed() > 0 ? `${failed()} failed` : undefined),
      body: () => <PluginsInspector inspector={inspector} filter={filter} setFilter={setFilter} />,
      actions: () => (
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
