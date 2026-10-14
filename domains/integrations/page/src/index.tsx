import { For, Show, createMemo, createSignal } from "solid-js";
import type { Component, JSX } from "solid-js";
import { IntegrationKinds, IntegrationsSection } from "@lemma/integrations";
import type { IntegrationItem, IntegrationKind, IntegrationOffer } from "@lemma/integrations";
import { AlertIcon, ArrowLeftIcon, CheckIcon, Dialog, PlugIcon, PlusIcon, SearchField, SearchIcon, Spinner, Toggle } from "@lemma/look";
import { Settings, SettingsGroups, SettingsSections } from "@lemma/settings";
import type { SettingsService } from "@lemma/settings";
import { Contained, Isolated, Slots, defineWebPlugin, usePlugin } from "@lemma/web";
import type { SlotItem, SlotsService } from "@lemma/web";
import { matchesQuery } from "@lemma/web/match";
import { dotted, filterItems, filterOffers, troubled } from "./model.ts";
import styles from "./integrations.css?inline";

type Kind = SlotItem<IntegrationKind>;

/** The Add dialog's param for every kind's offers. */
const ALL = "all";

const addable = (kind: Kind) => kind.catalog !== undefined || kind.add !== undefined;

/** A heading mid-sentence: its first letter lower, unless the word is an acronym (`MCP servers`). */
const quiet = (title: string) => (/^[A-Z]{2}/.test(title) ? title : title.charAt(0).toLowerCase() + title.slice(1));

/** An item's row: its icon, name, version, status in words (a dot only for trouble), and its switch. */
function Row(props: { kind: Kind; item: IntegrationItem; selected: boolean; open: () => void }) {
  return (
    <div class="integration-row" classList={{ selected: props.selected, off: props.item.status.tone === "off" }}>
      <button type="button" class="integration-row-main" aria-current={props.selected ? "true" : undefined} onClick={() => props.open()}>
        <Mark kind={props.kind} logo={props.item.logo} icon={props.item.icon} />
        <span class="integration-row-text">
          <span class="integration-row-title">
            {props.item.title}
            <Show when={props.item.version}>{(version) => <code class="integration-version">v{version()}</code>}</Show>
          </span>
          <span class="integration-row-status" data-tone={props.item.status.tone}>
            <Show when={dotted(props.item.status.tone)}>
              <span class="integration-dot" aria-hidden="true" />
            </Show>
            {props.item.status.text}
          </span>
        </span>
      </button>
      <Show when={props.item.setEnabled !== undefined && props.item.enabled !== undefined}>
        <Toggle label={`${props.item.title} on`} checked={props.item.enabled!} onChange={(on) => props.item.setEnabled!(on)} />
      </Show>
    </div>
  );
}

/** What shows beside the list with nothing open: what the page is, and adding one. */
function Overview(props: { add: () => void }) {
  return (
    <div class="integrations-overview">
      <PlugIcon />
      <h2>Integrations</h2>
      <p class="muted">The MCP servers that give agents tools. Pick one to see and change it, or add one.</p>
      <div class="integrations-overview-kinds">
        <button type="button" class="button" onClick={() => props.add()}>
          <PlusIcon />
          Add an integration
        </button>
      </div>
    </div>
  );
}

/** A row of the Add dialog: an offer, or a kind's own form. */
interface Choice {
  readonly key: string;
  readonly kind: Kind;
  readonly offer?: IntegrationOffer;
}

/** An image, or `fallback` while there is none or it fails to load (an address that is gone, an image that is not one). */
function Picture(props: { src: string | undefined; fallback: JSX.Element }) {
  const [failed, setFailed] = createSignal<string>();
  return (
    <Show when={props.src !== undefined && props.src !== failed() ? props.src : undefined} fallback={props.fallback}>
      {(src) => <img src={src()} alt="" onError={() => setFailed(src())} />}
    </Show>
  );
}

/** A mark for the Add dialog's rows and the list's: a logo, an image, or the kind's icon. */
function Mark(props: { kind: Kind; logo?: Component | undefined; icon?: string | undefined }) {
  return (
    <span class="integration-icon" aria-hidden="true">
      <Show when={props.logo} fallback={<Picture src={props.icon} fallback={<props.kind.icon />} />}>
        {(logo) => <Isolated component={logo()} />}
      </Show>
    </span>
  );
}

/**
 * The Add dialog: one search over what every kind offers (or one kind's), each added by picking it, and a kind's own
 * form for one it does not offer. Arrows move, Enter picks.
 */
function AddDialog(props: { kinds: readonly Kind[]; only: string | undefined; added: (kind: string, id: string) => void; close: () => void }) {
  const kinds = () =>
    props.kinds.filter((kind) => (props.only === undefined || kind.id === props.only) && (kind.catalog !== undefined || kind.add !== undefined));
  // Read as the dialog opens, and dropped as it closes.
  const catalogs = new Map(kinds().map((kind) => [kind.id, kind.catalog?.()]));
  const [query, setQuery] = createSignal("");
  const [form, setForm] = createSignal<Kind>();
  const [busy, setBusy] = createSignal<string>();
  const [error, setError] = createSignal<string>();
  /** The row the arrows are on; none moved yet: the first not added. */
  const [moved, setActive] = createSignal<number>();
  const offersOf = (kind: Kind) => filterOffers(catalogs.get(kind.id)?.offers() ?? [], query());
  const customShown = (kind: Kind) => kind.add !== undefined && matchesQuery(query(), `${kind.add.label} ${kind.add.description ?? ""} ${kind.title} custom`);
  /** Every row that can be picked, in order: what the arrows move over. */
  const choices = createMemo((): readonly Choice[] =>
    kinds().flatMap((kind) => [
      ...offersOf(kind)
        .filter((offer) => offer.unavailable === undefined)
        .map((offer) => ({ key: `${kind.id}:${offer.id}`, kind, offer })),
      ...(customShown(kind) ? [{ key: `${kind.id}:`, kind }] : []),
    ]),
  );
  const active = () =>
    moved() ??
    Math.max(
      0,
      choices().findIndex((choice) => choice.offer?.added === undefined),
    );
  const activeKey = () => choices()[Math.min(active(), choices().length - 1)]?.key;
  const plugin = usePlugin();
  let list!: HTMLDivElement;
  const pick = plugin.action("add an integration", async (choice: Choice) => {
    const offer = choice.offer;
    if (offer === undefined) return setForm(choice.kind);
    if (offer.added !== undefined) return props.added(choice.kind.id, offer.added);
    if (busy() !== undefined) return;
    setBusy(choice.key);
    setError(undefined);
    try {
      props.added(choice.kind.id, await offer.add());
    } catch (cause) {
      setError(`Adding ${offer.title}: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setBusy(undefined);
    }
  });
  const keys = (event: KeyboardEvent) => {
    const count = choices().length;
    if (count === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = (Math.min(active(), count - 1) + (event.key === "ArrowDown" ? 1 : -1) + count) % count;
      setActive(next);
      list.querySelector(`[data-key="${CSS.escape(choices()[next]!.key)}"]`)?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter") {
      event.preventDefault();
      const choice = choices().find((candidate) => candidate.key === activeKey());
      if (choice !== undefined) pick(choice);
    }
  };
  const placeholder = () => {
    const titles = kinds().map((kind) => quiet(kind.title));
    return titles.length === 0 ? "Search" : `Add ${titles.length === 1 ? `one of the ${titles[0]}` : titles.join(" or ")}…`;
  };
  return (
    <Dialog label="Add an integration" onClose={props.close} class="integrations-add">
      {/* In an element of its own: the dialog takes its children once. */}
      <div class="integrations-add-body">
        <Show
          when={form()}
          keyed
          fallback={
            <>
              <label class="integrations-add-search">
                <SearchIcon />
                <input
                  data-autofocus
                  placeholder={placeholder()}
                  aria-label="Search what to add"
                  autocomplete="off"
                  spellcheck={false}
                  value={query()}
                  onInput={(event) => {
                    setQuery(event.currentTarget.value);
                    setActive(undefined);
                  }}
                  onKeyDown={keys}
                />
              </label>
              <Show when={error()}>{(message) => <p class="integration-error integrations-add-error">{message()}</p>}</Show>
              <div ref={list} class="integrations-add-list" role="listbox" aria-label="What to add">
                <For each={kinds()}>
                  {(kind) => {
                    const catalog = catalogs.get(kind.id);
                    const offers = createMemo(() => offersOf(kind));
                    const empty = () => offers().length === 0 && !customShown(kind) && catalog?.loading?.() !== true;
                    return (
                      <Show when={!empty()}>
                        <section class="integrations-add-group" aria-label={kind.title}>
                          <Show when={kinds().length > 1}>
                            <h3 class="integrations-add-heading">{kind.title}</h3>
                          </Show>
                          <For each={offers()}>
                            {(offer) => {
                              const key = `${kind.id}:${offer.id}`;
                              return (
                                <button
                                  type="button"
                                  data-key={key}
                                  class="integrations-add-row"
                                  classList={{ active: activeKey() === key }}
                                  role="option"
                                  aria-selected={activeKey() === key}
                                  disabled={offer.unavailable !== undefined}
                                  tabindex="-1"
                                  onMouseMove={() => {
                                    const index = choices().findIndex((choice) => choice.key === key);
                                    if (index >= 0) setActive(index);
                                  }}
                                  onClick={() => pick({ key, kind, offer })}
                                >
                                  <Mark kind={kind} logo={offer.logo} icon={offer.icon} />
                                  <span class="integrations-add-text">
                                    <span class="integrations-add-title">{offer.title}</span>
                                    <Show when={offer.description}>{(description) => <span class="integrations-add-detail">{description()}</span>}</Show>
                                  </span>
                                  <span class="integrations-add-state">
                                    <Show
                                      when={busy() === key}
                                      fallback={
                                        <Show when={offer.unavailable ?? (offer.added !== undefined ? "Added" : undefined)}>
                                          {(note) => (
                                            <>
                                              <Show when={offer.added !== undefined}>
                                                <CheckIcon />
                                              </Show>
                                              {note()}
                                            </>
                                          )}
                                        </Show>
                                      }
                                    >
                                      <Spinner />
                                      Adding…
                                    </Show>
                                  </span>
                                </button>
                              );
                            }}
                          </For>
                          <Show when={catalog?.loading?.()}>
                            <p class="integrations-add-note">
                              <Spinner />
                              Looking for more…
                            </p>
                          </Show>
                          <Show when={catalog?.problem?.()}>{(problem) => <p class="integrations-add-note">{problem()}</p>}</Show>
                          <Show when={customShown(kind)}>
                            <button
                              type="button"
                              data-key={`${kind.id}:`}
                              class="integrations-add-row"
                              classList={{ active: activeKey() === `${kind.id}:` }}
                              role="option"
                              aria-selected={activeKey() === `${kind.id}:`}
                              tabindex="-1"
                              onMouseMove={() => setActive(choices().findIndex((choice) => choice.key === `${kind.id}:`))}
                              onClick={() => setForm(kind)}
                            >
                              <span class="integration-icon" aria-hidden="true">
                                <PlusIcon />
                              </span>
                              <span class="integrations-add-text">
                                <span class="integrations-add-title">{kind.add!.label}…</span>
                                <Show when={kind.add!.description}>{(description) => <span class="integrations-add-detail">{description()}</span>}</Show>
                              </span>
                            </button>
                          </Show>
                        </section>
                      </Show>
                    );
                  }}
                </For>
                <Show when={kinds().every((kind) => offersOf(kind).length === 0 && !customShown(kind) && catalogs.get(kind.id)?.loading?.() !== true)}>
                  <p class="integrations-add-note">Nothing matches.</p>
                </Show>
              </div>
            </>
          }
        >
          {(kind) => (
            <div class="integrations-add-form">
              <div class="integrations-add-form-head">
                <button type="button" class="icon-button" aria-label="Back" data-tip="Back" onClick={() => setForm(undefined)}>
                  <ArrowLeftIcon />
                </button>
                <h2>{kind.add!.label}</h2>
              </div>
              <Contained
                slot={IntegrationKinds}
                item={kind}
                component={kind.add!.component}
                props={{ added: (id: string) => props.added(kind.id, id), cancel: () => setForm(undefined) }}
              />
            </div>
          )}
        </Show>
      </div>
    </Dialog>
  );
}

function IntegrationsPage(props: { slots: SlotsService; settings: SettingsService }) {
  const kinds = () => props.slots.list(IntegrationKinds);
  const [query, setQuery] = createSignal("");
  const params = () => props.settings.params();
  const open = (kind: string, item: string) => props.settings.setParams({ kind, item, add: undefined });
  const close = () => props.settings.setParams({ kind: undefined, item: undefined });
  const openKind = () => kinds().find((kind) => kind.id === params()["kind"]);
  const openItem = () => {
    const kind = openKind();
    const id = params()["item"];
    return kind === undefined || id === undefined ? undefined : kind.items().find((item) => item.id === id);
  };
  const add = (kind: string) => props.settings.setParams({ add: kind });
  return (
    <div class="integrations">
      <aside class="integrations-list" aria-label="Integrations">
        <div class="integrations-list-head">
          <SearchField value={query()} onInput={setQuery} placeholder="Filter" label="Filter integrations">
            <Show when={kinds().some(addable)}>
              <button type="button" class="icon-button" aria-label="Add an integration" data-tip="Add an integration" onClick={() => add(ALL)}>
                <PlusIcon />
              </button>
            </Show>
          </SearchField>
        </div>
        <div class="integrations-groups">
          <For each={kinds()}>
            {(kind) => {
              const shown = createMemo(() => filterItems(kind.items(), query()));
              return (
                <section class="integrations-group">
                  <h2 class="settings-group-title integrations-group-title">
                    <span>{kind.title}</span>
                  </h2>
                  <Show when={kind.problem?.()}>
                    {(problem) => (
                      <div class="callout callout-warn integrations-problem">
                        <AlertIcon />
                        <span>{problem()}</span>
                      </div>
                    )}
                  </Show>
                  <Show when={kind.loaded()} fallback={<p class="muted small integrations-note">Loading…</p>}>
                    <For each={shown()}>
                      {(item) => (
                        <Row
                          kind={kind}
                          item={item}
                          selected={params()["kind"] === kind.id && params()["item"] === item.id}
                          open={() => open(kind.id, item.id)}
                        />
                      )}
                    </For>
                    <Show when={shown().length === 0}>
                      <Show
                        when={query().trim() === "" && addable(kind)}
                        fallback={<p class="muted small integrations-note">{query().trim() === "" ? "None yet." : "None match."}</p>}
                      >
                        <button type="button" class="integrations-empty" onClick={() => add(kind.id)}>
                          <PlusIcon />
                          <span>No {quiet(kind.title)} yet. Add one</span>
                        </button>
                      </Show>
                    </Show>
                  </Show>
                </section>
              );
            }}
          </For>
        </div>
      </aside>
      <main class="integrations-detail">
        <Show when={openKind() !== undefined && openItem() !== undefined} fallback={<Overview add={() => add(ALL)} />}>
          <Show when={`${openKind()!.id}:${openItem()!.id}`} keyed>
            {(_key: string) => <Contained slot={IntegrationKinds} item={openKind()!} component={openKind()!.detail} props={{ id: openItem()!.id, close }} />}
          </Show>
        </Show>
      </main>
      <Show when={params()["add"]} keyed>
        {(only) => (
          <AddDialog
            kinds={kinds()}
            only={only === ALL ? undefined : only}
            added={(kindId, id) => open(kindId, id)}
            close={() => props.settings.setParams({ add: undefined })}
          />
        )}
      </Show>
    </div>
  );
}

/**
 * Settings › Integrations: every kind of integration (`IntegrationKinds`) in one list, filtered as you type, beside
 * the open item's details, and an Add dialog searching what every kind offers. The kinds' plugins draw the details and the forms;
 * a search of the settings finds each item too.
 */
export default defineWebPlugin({
  id: "integrations.page",
  styles,
  requires: { slots: Slots, settings: Settings },
  setup: ({ slots, settings }) => {
    const items = () => slots.list(IntegrationKinds).flatMap((kind) => kind.items());
    slots.add(SettingsSections, {
      id: IntegrationsSection,
      order: 22,
      title: "Integrations",
      icon: PlugIcon,
      badge: () => {
        const count = troubled(items());
        return count === 0 ? undefined : String(count);
      },
      body: () => <IntegrationsPage slots={slots} settings={settings} />,
    });
    // A search of the settings finds each item, which opens it here.
    slots.add(SettingsGroups, {
      id: `${IntegrationsSection}.items`,
      section: IntegrationsSection,
      title: "Integrations",
      entries: () =>
        slots.list(IntegrationKinds).flatMap((kind) =>
          kind.items().map((item) => ({
            text: `integration ${kind.title} ${item.title} ${item.status.text} ${item.keywords ?? ""}`,
            view: () => (
              <button type="button" class="integration-result" onClick={() => settings.open(IntegrationsSection, { kind: kind.id, item: item.id })}>
                <span class="integration-icon" aria-hidden="true">
                  <kind.icon />
                </span>
                <span>{item.title}</span>
                <span class="muted small">
                  {kind.title} · {item.status.text}
                </span>
              </button>
            ),
          })),
        ),
    });
  },
});
