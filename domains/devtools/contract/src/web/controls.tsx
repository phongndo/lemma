import { For } from "solid-js";
import type { Accessor, JSX } from "solid-js";
import { clearsOnEscape, rowKeys } from "./keys.ts";

/*
 * The pieces every panel's toolbar and table are made of, in the foundation's `dt-` vocabulary. Handlers bind to their
 * element (`on:click`), not through Solid's page-wide delegation, which runs when the module loads: this contract loads
 * without a page too, in the tests.
 */

/**
 * A panel's filter field (`.dt-filter`): the first one a panel draws is what "/" and Ctrl/Cmd+F focus. Escape in it
 * clears what is typed (`clearsOnEscape`) unless `onKeyDown` says otherwise.
 */
export function FilterField(props: {
  /** Its accessible name. */
  readonly label: string;
  readonly placeholder?: string;
  readonly value: string;
  readonly onInput: (value: string) => void;
  readonly onKeyDown?: (event: KeyboardEvent) => void;
  readonly type?: "search";
  readonly ref?: (input: HTMLInputElement) => void;
  /** A class beside `dt-filter`. */
  readonly class?: string;
  /** Before the field: an icon, or a word naming it. */
  readonly children?: JSX.Element;
}) {
  return (
    <label class={props.class === undefined ? "dt-filter" : `dt-filter ${props.class}`}>
      {props.children}
      <input
        ref={(input) => props.ref?.(input)}
        type={props.type}
        aria-label={props.label}
        placeholder={props.placeholder}
        autocomplete="off"
        spellcheck={false}
        value={props.value}
        on:input={(event) => props.onInput(event.currentTarget.value)}
        on:keydown={(event) =>
          (
            props.onKeyDown ??
            clearsOnEscape(
              () => props.value,
              () => props.onInput(""),
            )
          )(event)
        }
      />
    </label>
  );
}

/** A choice of one among a few in a toolbar: a `.dt-chip` each, pressed (`aria-pressed`) while it is the value. */
export function Chips<T extends string>(props: {
  readonly options: readonly { readonly id: T; readonly label: string }[];
  readonly value: T;
  readonly onChange: (value: T) => void;
}) {
  return (
    <For each={props.options}>
      {(option) => (
        <button class="dt-chip" aria-pressed={props.value === option.id} on:click={() => props.onChange(option.id)}>
          {option.label}
        </button>
      )}
    </For>
  );
}

export interface TableColumn {
  readonly title: string;
  readonly class?: string;
  /** Its width, when its cells' content does not set it. */
  readonly width?: string;
}

/**
 * A panel's table whose rows select (`.dt-table`, `role="grid"`), answering the keys as every panel's does (`rowKeys`).
 * A click on a row opens it (`onOpen`), or where nothing does, selects it, or clears the selection (`onClear`) when it
 * is the row selected. A click on a button or link in a row is that control's, as Enter on one is.
 */
export function SelectableTable<T>(props: {
  /** Its accessible name. */
  readonly label: string;
  /** A class beside `dt-table`. */
  readonly class?: string;
  readonly columns: readonly TableColumn[];
  readonly rows: readonly T[];
  /** A row's key: unique among the rows, and what `selected` and the handlers name it by. */
  readonly key: (row: T) => string;
  readonly selected: string | undefined;
  /** ↑ and ↓ select the row before or after. */
  readonly onSelect: (key: string) => void;
  /** Escape clears the selection: where the panel can close its details. */
  readonly onClear?: () => void;
  /** Enter or Space opens a row: one whose opening does more than select it. */
  readonly onOpen?: (key: string) => void;
  /** Shown in place of the rows while there are none. */
  readonly empty?: JSX.Element;
  /** A row's cells. */
  readonly children: (row: T, index: Accessor<number>) => JSX.Element;
}) {
  const click = (key: string) => {
    if (props.onOpen !== undefined) props.onOpen(key);
    else if (props.onClear !== undefined && props.selected === key) props.onClear();
    else props.onSelect(key);
  };
  return (
    <table
      class={props.class === undefined ? "dt-table" : `dt-table ${props.class}`}
      aria-label={props.label}
      role="grid"
      tabindex="0"
      on:keydown={(event) => rowKeys(props.onSelect, props.onClear, props.onOpen)(event)}
    >
      <thead>
        <tr>
          <For each={props.columns}>
            {(column) => (
              <th class={column.class} style={column.width === undefined ? undefined : { width: column.width }}>
                {column.title}
              </th>
            )}
          </For>
        </tr>
      </thead>
      <tbody>
        <For
          each={props.rows}
          fallback={
            props.empty === undefined ? undefined : (
              <tr>
                <td colSpan={props.columns.length} class="dt-muted">
                  {props.empty}
                </td>
              </tr>
            )
          }
        >
          {(row, index) => {
            const key = () => props.key(row);
            return (
              <tr
                data-row
                data-key={key()}
                data-selected={props.selected === key()}
                aria-selected={props.selected === key()}
                tabindex="-1"
                on:click={(event) => {
                  const control = (event.target as Element).closest("a, button");
                  if (control === null || !event.currentTarget.contains(control)) click(key());
                }}
              >
                {props.children(row, index)}
              </tr>
            );
          }}
        </For>
      </tbody>
    </table>
  );
}
