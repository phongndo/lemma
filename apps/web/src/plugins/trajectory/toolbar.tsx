import { For, Show } from "solid-js";
import { formatDuration } from "@lemma/contracts";
import { XIcon } from "../../ui/parts.tsx";
import type { View, TypeFilter } from "./state.ts";

/** The filter toolbar: the search, the kinds of record, and the timeline's options. */
export function createToolbar(view: View) {
  const {
    equalDurations,
    setEqualDurations,
    groupTurns,
    setGroupTurns,
    typeFilter,
    setTypeFilter,
    query,
    setQuery,
    sort,
    range,
    setRange,
    zoom,
    setZoom,
    stuck,
    follow,
    refs,
  } = view;

  const TYPES: readonly { id: TypeFilter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "user", label: "User" },
    { id: "assistant", label: "Model" },
    { id: "tool", label: "Tool" },
    { id: "system", label: "System" },
    { id: "error", label: "Errors" },
  ];

  function Toolbar() {
    return (
      <div class="dt-toolbar" role="toolbar" aria-label="Trajectory toolbar">
        <label class="dt-filter">
          <svg class="icon" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path d="M2 3h12l-4.5 5.5V13l-3 1.5V8.5z" />
          </svg>
          <input
            ref={(el) => {
              refs.filterInput = el;
            }}
            type="search"
            placeholder="Filter  (is:error  tool:bash  turn:2  -text)"
            aria-label="Filter trajectory"
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
            spellcheck={false}
          />
        </label>
        <span class="dt-sep" />
        <For each={TYPES}>
          {(type) => (
            <button class="dt-chip" aria-pressed={typeFilter() === type.id} onClick={() => setTypeFilter(type.id)}>
              {type.label}
            </button>
          )}
        </For>
        <span class="dt-sep" />
        <label class="dt-check" data-tip="Group rows under their turn">
          <input type="checkbox" checked={groupTurns()} onChange={(event) => setGroupTurns(event.currentTarget.checked)} />
          Group by turn
        </label>
        <label class="dt-check" data-tip="Every record gets the same width in the overview and waterfall">
          <input type="checkbox" checked={equalDurations()} onChange={(event) => setEqualDurations(event.currentTarget.checked)} />
          Equal widths
        </label>
        <Show when={zoom().start > 0 || zoom().end < 1}>
          <button class="dt-chip trj-accent" onClick={() => setZoom({ start: 0, end: 1 })} data-tip="Show the whole thread (or double-click the overview)">
            Reset zoom
          </button>
        </Show>
        <Show when={range()}>
          {(r) => (
            <button class="dt-chip trj-accent" onClick={() => setRange(undefined)} data-tip="Clear the selected time range">
              {formatDuration(r().to - r().from)} range <XIcon />
            </button>
          )}
        </Show>
        <Show when={!stuck() && sort().key === "time"}>
          <span class="dt-sep" />
          <button class="dt-chip" onClick={follow} data-tip="Show the newest record and keep it in view">
            ↓ Follow
          </button>
        </Show>
      </div>
    );
  }

  return { Toolbar };
}
