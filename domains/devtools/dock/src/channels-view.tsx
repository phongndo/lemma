import { Show, createMemo, createSignal } from "solid-js";
import type { Accessor } from "solid-js";
import type { ChannelInfo } from "@lemma/contracts";
import { FilterField, PLUGIN_PANEL, SelectableTable } from "@lemma/devtools/web";
import type { DevtoolsService } from "@lemma/devtools/web";
import { Details } from "./parts.tsx";

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
        <FilterField label="Filter channels" placeholder="Filter: id, kind, or plugin" value={query()} onInput={setQuery} />
      </div>
      <div class="dt-split">
        <div class="dt-main" tabindex="-1">
          <SelectableTable
            label="Channels"
            columns={[{ title: "Channel" }, { title: "Kind", class: "devtools-channels-kind" }, { title: "Plugin" }, { title: "Title" }]}
            rows={shown()}
            key={(channel) => channel.id}
            selected={selected()}
            onSelect={setSelected}
            onClear={() => setSelected(undefined)}
            empty={props.channels().length === 0 ? "No running host plugin serves one" : "No channels match"}
          >
            {(channel) => (
              <>
                <td class="dt-code">{channel.id}</td>
                <td class="dt-muted">{channel.kind}</td>
                <td>
                  <button class="dt-link dt-code" onClick={() => props.devtools.show(PLUGIN_PANEL, `host:${channel.source}`)}>
                    {channel.source}
                  </button>
                </td>
                <td>{channel.title ?? ""}</td>
              </>
            )}
          </SelectableTable>
        </div>
        <Show when={chosen()} keyed>
          {(channel) => (
            <Details
              label="Channel details"
              title={
                <>
                  <strong class="dt-code">{channel.id}</strong>
                  <span class="dt-muted">{channel.kind}</span>
                </>
              }
              onClose={() => setSelected(undefined)}
            >
              <p>{channel.title ?? channel.id}</p>
              <p class="dt-muted">{channel.description ?? "No description."}</p>
            </Details>
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
