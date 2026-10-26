import { For, Show, createEffect, createMemo, createUniqueId, on, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { listKey, quickKey, wrapStep } from "@lemma/web/keys";
import { createQuickHold } from "@lemma/web/quick-pick";
import type { SearchListProps } from "@lemma/look";

/** How many options PgUp and PgDn move. */
const PAGE = 8;

/**
 * A searchable list over the page, in the foundation's `.palette-*` classes: the backdrop, the panel, the field (a
 * combobox naming the active option), the rows, and the footer. The field keeps the focus; the rows take the keys
 * through it and the pointer on their own.
 */
export function SearchList(props: SearchListProps) {
  // Unique per instance: the page could show two lists.
  const listId = `search-list-${createUniqueId()}`;
  let field!: HTMLInputElement;
  let list: HTMLDivElement | undefined;
  const previous = document.activeElement as HTMLElement | null;
  const count = createMemo(() => props.rows.filter((row) => row.type === "option").length);
  const hold = createQuickHold();

  // The active option stays in view as it moves, and as the rows change under it (a page of them opened in place).
  createEffect(
    on([() => props.active, () => props.rows], ([index]) => {
      list?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
    }),
  );

  const onKeyDown = (event: KeyboardEvent) => {
    hold.track(event);
    if (event.isComposing) return;
    props.onKeyDown?.(event);
    if (event.defaultPrevented) return;
    const options = count();
    const keys = listKey(event);
    if (keys !== undefined) {
      event.preventDefault();
      if ("pick" in keys) props.onPick(keys.pick, true);
      else if (options > 0) props.onActive(wrapStep(props.active, keys.move, options));
    } else if (event.key === "PageDown" || event.key === "PageUp") {
      event.preventDefault();
      if (options > 0) props.onActive(event.key === "PageDown" ? Math.min(options - 1, props.active + PAGE) : Math.max(0, props.active - PAGE));
    } else if (event.key === "Enter") {
      event.preventDefault();
      props.onSubmit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      props.onEscape();
    } else if (event.key === "Tab") {
      // The focus stays in the field.
      event.preventDefault();
    }
  };

  onMount(() => field.focus());
  onCleanup(() => previous?.focus?.());

  return (
    <Portal>
      <div
        class="backdrop palette-backdrop"
        classList={{ behind: props.behind === true }}
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) props.onClose();
        }}
      >
        <div
          class={`palette ${props.class ?? ""}`}
          role="dialog"
          aria-modal="true"
          aria-label={props.label}
          aria-labelledby={props.labelledBy}
          onKeyDown={onKeyDown}
          onKeyUp={hold.track}
          onFocusOut={hold.track}
        >
          {props.heading}
          <div class="palette-input">
            {props.lead}
            <input
              ref={(element) => {
                field = element;
                props.field?.(element);
              }}
              type={props.secret === true ? "password" : "text"}
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={props.active >= 0 && props.active < count() ? `${listId}-${props.active}` : undefined}
              aria-label={props.fieldLabel}
              autocomplete="off"
              autocapitalize="off"
              spellcheck={false}
              placeholder={props.placeholder}
              // Read-only, not disabled: a disabled field drops the focus, and with it Escape and typing once it is not.
              readOnly={props.readOnly === true}
              value={props.value}
              onInput={(event) => props.onInput(event.currentTarget.value)}
            />
            {props.trail}
          </div>
          {props.detail}
          <Show when={props.rows.length > 0}>
            <div
              ref={(element) => {
                list = element;
                props.list?.(element);
              }}
              id={listId}
              class="palette-list"
              role="listbox"
              aria-label="Results"
            >
              <For each={props.rows}>
                {(row) =>
                  row.type === "heading" ? (
                    <div class="palette-section" role="presentation">
                      {row.label}
                    </div>
                  ) : row.type === "note" ? (
                    <div class="palette-note" role="presentation">
                      {row.label}
                    </div>
                  ) : (
                    <div
                      id={`${listId}-${row.index}`}
                      class={`palette-row ${row.class ?? ""}`}
                      role="option"
                      data-index={row.index}
                      data-active={String(row.index === props.active)}
                      data-quick-key={hold.held() ? quickKey(row.index) : undefined}
                      aria-selected={row.index === props.active}
                      onPointerMove={() => props.onActive(row.index)}
                      // The field keeps the focus, so the keys still reach the list.
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => props.onPick(row.index, false)}
                    >
                      {row.content()}
                    </div>
                  )
                }
              </For>
            </div>
          </Show>
          <Show when={props.empty}>{(text) => <div class="palette-empty">{text()}</div>}</Show>
          <Show when={props.footer}>
            <footer class="palette-foot">{props.footer}</footer>
          </Show>
        </div>
      </div>
    </Portal>
  );
}
