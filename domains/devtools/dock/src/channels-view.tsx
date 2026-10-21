import { For, Show, createMemo, createSignal } from "solid-js";
import type { Accessor } from "solid-js";
import type { ChannelInfo } from "@lemma/contracts";
import { PLUGIN_PANEL } from "@lemma/devtools/web";
import type { DevtoolsService } from "@lemma/devtools/web";
import { XIcon } from "@lemma/look";
import { rowKeys } from "./rows.ts";

/* The Channels panel's view (see `channelsPanel`), loaded the first time the devtools draw one of their own panels. */

/**
 * What host plugins serve (`Channels`): each call and stream, and the plugin
 * whose channel answers for its id. Every domain is reached through these,
 * the web app's own calls included. A channel selected opens its details.
 */
export function ChannelsView(props: { devtools: DevtoolsService; channels: Accessor<readonly ChannelInfo[]> }) {
  const [query, setQuery] = createSignal("");
  const [selected, setSelected] = createSignal<string>();
  const shown = createMemo(() => {
    const words = query().trim().toLowerCase().split(/\s+/).filter(Boolean);
    return props.channels().filter((channel) => {
      const text = `${channel.id} ${channel.kind} ${channel.source} ${channel.title ?? ""}`.toLowerCase();
      return words.every((word) => text.includes(word));
    });
  });
  const chosen = () => props.channels().find((channel) => channel.id === selected());
  return (
    <div class="dt-scope" aria-label="Channels">
      <div class="dt-toolbar" role="toolbar" aria-label="Channels toolbar">
        <label class="dt-filter">
          <input
            placeholder="Filter: id, kind, or plugin"
            aria-label="Filter channels"
            autocomplete="off"
            spellcheck={false}
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
      </div>
      <div class="dt-split">
        <div class="dt-main" tabindex="-1">
          <table class="dt-table" aria-label="Channels" role="grid" tabindex="0" onKeyDown={rowKeys(setSelected, () => setSelected(undefined))}>
            <thead>
              <tr>
                <th>Channel</th>
                <th class="devtools-channels-kind">Kind</th>
                <th>Plugin</th>
                <th>Title</th>
              </tr>
            </thead>
            <tbody>
              <For
                each={shown()}
                fallback={
                  <tr>
                    <td colSpan={4} class="dt-muted">
                      {props.channels().length === 0 ? "No running host plugin serves one" : "No channels match"}
                    </td>
                  </tr>
                }
              >
                {(channel) => (
                  <tr
                    data-row
                    data-key={channel.id}
                    data-selected={selected() === channel.id}
                    aria-selected={selected() === channel.id}
                    tabindex="-1"
                    onClick={() => setSelected(selected() === channel.id ? undefined : channel.id)}
                  >
                    <td class="dt-code">{channel.id}</td>
                    <td class="dt-muted">{channel.kind}</td>
                    <td>
                      <button
                        class="dt-link"
                        onClick={(event) => {
                          event.stopPropagation();
                          props.devtools.show(PLUGIN_PANEL, `host:${channel.source}`);
                        }}
                      >
                        {channel.source}
                      </button>
                    </td>
                    <td>{channel.title ?? ""}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
        <Show when={chosen()} keyed>
          {(channel) => (
            <aside class="dt-details dt-side" aria-label="Channel details">
              <div class="dt-details-title">
                <strong class="dt-code">{channel.id}</strong>
                <span class="dt-muted">{channel.kind}</span>
                <button class="dt-close devtools-end" aria-label="Close details" onClick={() => setSelected(undefined)}>
                  <XIcon />
                </button>
              </div>
              <div class="dt-side-body">
                <p>{channel.title ?? channel.id}</p>
                <p class="dt-muted">{channel.description ?? "No description."}</p>
              </div>
            </aside>
          )}
        </Show>
      </div>
      <div class="dt-status" role="status">
        <span>{props.channels().length} channels</span>
        <span>{props.channels().filter((channel) => channel.kind === "stream").length} streams</span>
      </div>
    </div>
  );
}
