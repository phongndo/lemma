import { For } from "solid-js";
import { radioStep } from "@lemma/web/keys";
import type { SegmentedProps, SettingRowProps } from "@lemma/look";

/** A setting's name and explanation, with its control on the right. */
export function SettingRow(props: SettingRowProps) {
  return (
    <div class="setting-row">
      <div class="setting-text">
        <div class="setting-title">{props.title}</div>
        {props.description === undefined ? null : <div class="setting-desc">{props.description}</div>}
      </div>
      <div class="setting-control">{props.children}</div>
    </div>
  );
}

/**
 * A choice of a few options shown side by side: one Tab stop (the checked option, or the first while none is), whose
 * arrow keys, Home, and End move the choice. A key steps from the option focused, not the value, which a choice saved
 * elsewhere (the host's config) brings back only later.
 */
export function Segmented(props: SegmentedProps) {
  const checked = () =>
    Math.max(
      0,
      props.options.findIndex((option) => option.value === props.value),
    );
  const onKeyDown = (event: KeyboardEvent & { currentTarget: HTMLDivElement }) => {
    const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=radio]")];
    const focused = options.indexOf(document.activeElement as HTMLButtonElement);
    const next = radioStep(event.key, focused < 0 ? checked() : focused, props.options.length);
    if (next === undefined) return;
    event.preventDefault();
    props.onChange(props.options[next]!.value);
    options[next]?.focus();
  };
  return (
    <div class="segmented" role="radiogroup" aria-label={props.label} onKeyDown={onKeyDown}>
      <For each={props.options}>
        {(option, index) => (
          <button
            type="button"
            role="radio"
            aria-checked={props.value === option.value}
            tabIndex={index() === checked() ? 0 : -1}
            onClick={() => props.onChange(option.value)}
          >
            {option.label}
          </button>
        )}
      </For>
    </div>
  );
}
