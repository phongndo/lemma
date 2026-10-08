import { For } from "solid-js";
import type { ConfigField } from "@lemma/contracts";
import { configEdit, configText } from "../model/config.ts";
import type { ConfigFormProps, IconName, IconProps, SearchFieldProps, ToggleProps } from "./contracts.ts";

/*
 * The plain fallbacks of the parts the always-on plugins draw (`shell`,
 * `pages`, `settings`, and `plugins-page`), which `ui/contracts.ts` declares
 * with each part: what renders while no plugin provides it, so with `kit` off
 * the page that turns it back on still searches, switches, and configures. Native
 * markup, with no styling beyond the foundation's base styles. Handlers bind
 * to their element (`on:input`), not through Solid's page-wide delegation
 * (`onInput`), which runs when the module loads: the contracts that declare
 * these load without a page too, in the tests.
 */

/** A checkbox. It shows the value it is given, not the click: a change may not take (a confirmation asked first, a failure). */
export function ToggleFallback(props: ToggleProps) {
  return (
    <input
      type="checkbox"
      aria-label={props.label}
      checked={props.checked}
      disabled={props.disabled}
      on:change={(event) => {
        const checked = event.currentTarget.checked;
        event.currentTarget.checked = props.checked;
        props.onChange(checked);
      }}
    />
  );
}

/** A search input, then the page's controls. Escape with text in it clears it, and goes no further. */
export function SearchFieldFallback(props: SearchFieldProps) {
  return (
    <div>
      <input
        ref={(input) => props.ref?.(input)}
        type="search"
        placeholder={props.placeholder}
        aria-label={props.label}
        value={props.value}
        on:input={(event) => props.onInput(event.currentTarget.value)}
        on:keydown={(event) => {
          if (event.key === "Escape" && props.value !== "") {
            event.preventDefault();
            event.stopPropagation();
            props.onInput("");
          } else props.onKeyDown?.(event);
        }}
      />
      {props.children}
    </div>
  );
}

/**
 * A text input per setting, read as `lemma plugins config` reads it (`configEdit`):
 * saved when it changes, unset when cleared, and refused, saying why, when it
 * is not of the setting's type. Settings a form does not edit are left to the
 * config file.
 */
export function ConfigFormFallback(props: ConfigFormProps) {
  const value = (field: ConfigField) => props.config?.values[field.key];
  const commit = (field: ConfigField, input: HTMLInputElement) => {
    const edit = configEdit(field, value(field), input.value);
    if (edit === undefined) return;
    if ("error" in edit) {
      input.setCustomValidity(edit.error);
      input.reportValidity();
    } else void props.onSave({ [field.key]: edit.value });
  };
  return (
    <div>
      <For each={props.fields.filter((field) => field.type !== "other")}>
        {(field) => (
          <p>
            <label>
              {field.title}{" "}
              <input
                type={field.secret ? "password" : "text"}
                autocomplete="off"
                disabled={props.disabled}
                value={field.secret ? "" : configText(value(field))}
                placeholder={field.secret ? (props.config?.secretsSet.includes(field.key) ? "Set" : "Not set") : configText(field.default)}
                on:input={(event) => event.currentTarget.setCustomValidity("")}
                on:change={(event) => commit(field, event.currentTarget)}
              />
            </label>
          </p>
        )}
      </For>
      <p>Saved to {props.file}, where any other setting is edited.</p>
    </div>
  );
}

const GLYPHS: Readonly<Record<IconName, string>> = {
  plus: "+",
  stop: "■",
  send: "↑",
  chevron: "›",
  "chevron-down": "▾",
  check: "✓",
  x: "×",
  key: "⚷",
  puzzle: "◇",
  copy: "⊡",
  code: "</>",
  image: "▣",
  alert: "!",
  sidebar: "◧",
  menu: "☰",
  log: "≡",
  refresh: "↻",
  external: "↗",
  file: "▯",
  folder: "▭",
  "folder-open": "▱",
  filter: "▽",
  search: "⚲",
  "folder-plus": "+",
  "pen-square": "✎",
  gear: "⚙",
  "git-branch": "⎇",
  worktree: "⊞",
  laptop: "▬",
  star: "☆",
  more: "⋯",
  pin: "⊙",
  archive: "▤",
  trash: "⌫",
  pencil: "✎",
  brain: "※",
  chat: "▢",
  trajectory: "⋮",
  command: "⌘",
  terminal: ">_",
  hammer: "⚒",
  sliders: "⚌",
  palette: "◐",
  "arrow-left": "←",
  spinner: "…",
};

/** The icon as a text glyph, hidden from assistive technology as the icons are: the control it marks carries the name. */
export function IconFallback(props: IconProps) {
  return <span aria-hidden="true">{GLYPHS[props.name]}</span>;
}
