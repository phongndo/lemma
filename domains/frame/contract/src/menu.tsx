import { For, Show, createSignal } from "solid-js";
import { Contained } from "@lemma/web";
import type { Slot, SlotItem } from "@lemma/web";
import type { MenuAction } from "./index.ts";

/**
 * A menu's items for one subject, as `menu-item` buttons grouped by `section`.
 * An item with a `confirm` text arms on the first pick, showing the text, and
 * runs on the second. Draw it inside a popover; `close` closes it.
 */
export function ActionMenu<Subject, Control>(props: {
  readonly subject: Subject;
  readonly control: Control;
  /** The slot the actions are items of, so one whose icon throws is named. */
  readonly slot: Slot<any>;
  readonly actions: readonly MenuAction<Subject, Control>[];
  readonly close: () => void;
}) {
  const [armed, setArmed] = createSignal<MenuAction<Subject, Control> | undefined>();
  return (
    <For each={props.actions}>
      {(action, index) => {
        const confirm = () => action.confirm?.(props.subject);
        return (
          <>
            <Show when={action.section && index() > 0}>
              <div class="menu-sep" role="separator" />
            </Show>
            <button
              class="menu-item"
              classList={{ "menu-danger": action.danger === true }}
              role="menuitem"
              // A native listener, not Solid's delegated one: a contract loads outside a page too (tests, the host), where delegation would reach for `window`.
              on:click={() => {
                if (confirm() !== undefined && armed() !== action) {
                  setArmed(() => action);
                  return;
                }
                props.close();
                action.run(props.subject, props.control);
              }}
            >
              <Show when={action.icon}>{(icon) => <Contained slot={props.slot} item={action as unknown as SlotItem<unknown>} component={icon()} />}</Show>
              <span class="menu-label">{armed() === action ? confirm() : action.label(props.subject)}</span>
            </button>
          </>
        );
      }}
    </For>
  );
}
