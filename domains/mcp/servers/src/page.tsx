import { For, Show, createMemo, createSignal } from "solid-js";
import type { Accessor, Component } from "solid-js";
import { AlertIcon, Dialog, HammerIcon, Picture, PlugIcon, PlusIcon, SearchField, Toggle } from "@lemma/look";
import { SettingsGroups, SettingsSections } from "@lemma/settings";
import type { SettingsService } from "@lemma/settings";
import type { SlotsService } from "@lemma/web";
import { dotted, filterItems, troubled } from "./items.ts";
import type { ServerItem } from "./items.ts";

/**
 * Settings › Integrations' section id, for `Settings.open`: its address is `/settings/integrations`, `item` opening a
 * server (`?item=github`) and `add` the form adding one.
 */
export const INTEGRATIONS = "integrations";

/** What the page draws a server's details and the form adding one with: `web.tsx`'s. */
export interface PageParts {
  readonly items: Accessor<readonly ServerItem[]>;
  /** The servers' state has arrived; until then the list says it is loading them. */
  readonly loaded: Accessor<boolean>;
  /** What is wrong with the servers' file as a whole, shown above them. */
  readonly problem: Accessor<string | undefined>;
  /** One server's details, beside the list: `close` once it is removed. */
  readonly detail: Component<{ readonly id: string; readonly close: () => void }>;
  /** The form adding one, which says when it `added` a server, opened then. */
  readonly add: Component<{ readonly added: (id: string) => void; readonly cancel: () => void }>;
}

/** A server's mark: its icon (one for a dark theme besides), or a hammer. */
function Mark(props: { icon?: string | undefined; iconDark?: string | undefined }) {
  return (
    <span class="integration-icon" aria-hidden="true">
      <Picture src={props.icon} dark={props.iconDark} fallback={<HammerIcon />} />
    </span>
  );
}

/** A server's row, on the settings' row grid: its icon, name, version, status in words (a dot only for trouble), and its switch. */
function Row(props: { item: ServerItem; selected: boolean; open: () => void }) {
  return (
    <div class="setting-row setting-row-pick integration-row" classList={{ selected: props.selected, off: props.item.status.tone === "off" }}>
      <button type="button" class="integration-row-main" aria-current={props.selected ? "true" : undefined} onClick={() => props.open()}>
        <span class="setting-lead">
          <Mark icon={props.item.icon} iconDark={props.item.iconDark} />
        </span>
        <span class="setting-text">
          <span class="setting-title integration-row-title">
            {props.item.title}
            <Show when={props.item.version}>{(version) => <code class="integration-version">v{version()}</code>}</Show>
          </span>
          <span class="setting-desc integration-row-status" data-tone={props.item.status.tone}>
            <Show when={dotted(props.item.status.tone)}>
              <span class="integration-dot" aria-hidden="true" />
            </Show>
            {props.item.status.text}
          </span>
        </span>
      </button>
      <Toggle label={`${props.item.title} on`} checked={props.item.enabled} onChange={(on) => props.item.setEnabled(on)} />
    </div>
  );
}

/** The servers in a list, filtered as you type, beside the open one's details; the form adding one in a dialog. */
function IntegrationsPage(props: { parts: PageParts; settings: SettingsService }) {
  const [query, setQuery] = createSignal("");
  const shown = createMemo(() => filterItems(props.parts.items(), query()));
  const params = () => props.settings.params();
  const open = (item: string) => props.settings.setParams({ item, add: undefined });
  const close = () => props.settings.setParams({ item: undefined });
  const openItem = () => {
    const id = params()["item"];
    return id === undefined ? undefined : props.parts.items().find((item) => item.id === id);
  };
  return (
    <div class="integrations">
      <aside class="integrations-list" aria-label="Integrations">
        <div class="integrations-list-head">
          <SearchField value={query()} onInput={setQuery} placeholder="Filter" label="Filter integrations" />
        </div>
        <div class="integrations-groups">
          <section class="integrations-group">
            <h2 class="settings-group-title integrations-group-title">
              <span>MCP servers</span>
            </h2>
            <Show when={props.parts.problem()}>
              {(problem) => (
                <div class="callout callout-warn integrations-problem">
                  <AlertIcon />
                  <span>{problem()}</span>
                </div>
              )}
            </Show>
            <Show when={props.parts.loaded()} fallback={<p class="muted small integrations-note">Loading…</p>}>
              <For each={shown()}>{(item) => <Row item={item} selected={params()["item"] === item.id} open={() => open(item.id)} />}</For>
              <Show when={shown().length === 0}>
                <p class="muted small integrations-note">{query().trim() === "" ? "None yet." : "None match."}</p>
              </Show>
            </Show>
          </section>
        </div>
      </aside>
      <main class="integrations-detail">
        <Show
          when={openItem()}
          fallback={
            <p class="settings-empty">
              {props.parts.loaded() && props.parts.items().length === 0
                ? "None yet: add one to give agents more to work with."
                : "Pick one to see its state, how it is reached, and what it offers."}
            </p>
          }
        >
          <Show when={openItem()!.id} keyed>
            {(id: string) => <props.parts.detail id={id} close={close} />}
          </Show>
        </Show>
      </main>
      <Show when={params()["add"] !== undefined}>
        <Dialog label="Add an MCP server" onClose={() => props.settings.setParams({ add: undefined })} class="integrations-add">
          {/* In an element of its own: the dialog takes its children once. */}
          <div class="integrations-add-body">
            <div class="integrations-add-form-head">
              <h2>Add an MCP server</h2>
            </div>
            <props.parts.add added={open} cancel={() => props.settings.setParams({ add: undefined })} />
          </div>
        </Dialog>
      </Show>
    </div>
  );
}

/**
 * Settings › Integrations: the MCP servers in one list, filtered as you type, beside the open one's details, with the
 * form adding one; a search of the settings finds each server too.
 */
export function addIntegrationsPage(slots: SlotsService, settings: SettingsService, parts: PageParts): void {
  slots.add(SettingsSections, {
    id: INTEGRATIONS,
    order: 30,
    title: "Integrations",
    icon: PlugIcon,
    description: "The MCP servers that give agents tools.",
    actions: () => (
      <button type="button" class="button small" onClick={() => settings.setParams({ add: "server" })}>
        <PlusIcon /> Add an integration
      </button>
    ),
    badge: () => {
      const count = troubled(parts.items());
      return count === 0 ? undefined : String(count);
    },
    body: () => <IntegrationsPage parts={parts} settings={settings} />,
  });
  // A search of the settings finds each server, which opens it here.
  slots.add(SettingsGroups, {
    id: `${INTEGRATIONS}.items`,
    section: INTEGRATIONS,
    title: "Integrations",
    entries: () =>
      parts.items().map((item) => ({
        text: `integration mcp server ${item.title} ${item.status.text} ${item.keywords}`,
        view: () => (
          <button type="button" class="integration-result" onClick={() => settings.open(INTEGRATIONS, { item: item.id })}>
            <span class="integration-icon" aria-hidden="true">
              <HammerIcon />
            </span>
            <span>{item.title}</span>
            <span class="muted small">MCP servers · {item.status.text}</span>
          </button>
        ),
      })),
  });
}
