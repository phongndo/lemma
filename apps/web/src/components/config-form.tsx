import { For, Match, Show, Switch, createSignal } from "solid-js";
import { parseConfigValue } from "@lemma/contracts";
import type { ConfigField } from "@lemma/contracts";
import type { ConfigFormProps } from "../ui/contracts.ts";
import { Toggle } from "../ui/parts.tsx";

const show = (value: unknown): string => (value === undefined ? "" : Array.isArray(value) ? value.join(", ") : String(value));

/**
 * A plugin's settings, projected from its config Schema: a control per
 * field, saved one field at a time (`null` unsets a field, back to its
 * default). Nested fields are edited in the config file; secrets are never
 * shown, only replaced.
 */
export function ConfigForm(props: ConfigFormProps) {
  const [saving, setSaving] = createSignal<string>();
  const [errors, setErrors] = createSignal<Readonly<Record<string, string>>>({});
  const value = (field: ConfigField) => props.config?.values[field.key];
  const save = async (field: ConfigField, next: unknown) => {
    setErrors((all) => ({ ...all, [field.key]: "" }));
    setSaving(field.key);
    try {
      await props.onSave({ [field.key]: next });
    } finally {
      setSaving(undefined);
    }
  };
  /** Text typed into a field: parsed as its type, saved when it changed, unset when cleared. */
  const commit = (field: ConfigField, text: string) => {
    if (text.trim() === "" && !field.secret) {
      if (value(field) !== undefined && value(field) !== field.default) void save(field, null);
      return;
    }
    if (field.secret && text === "") return;
    const parsed = parseConfigValue(field, text);
    if ("error" in parsed) {
      setErrors((all) => ({ ...all, [field.key]: parsed.error }));
      return;
    }
    if (JSON.stringify(parsed.value) !== JSON.stringify(value(field))) void save(field, parsed.value);
  };
  const resettable = (field: ConfigField) =>
    !field.secret && field.type !== "other" && value(field) !== undefined && JSON.stringify(value(field)) !== JSON.stringify(field.default);
  const busy = () => props.disabled === true || saving() !== undefined;
  return (
    <div class="config-form">
      <For each={props.fields}>
        {(field) => (
          <div class="config-field">
            <div class="config-text">
              <label class="config-title" for={`config-${field.key}`}>
                {field.title}
                <span class="config-key">{field.key}</span>
              </label>
              <Show when={field.description}>
                <span class="config-desc">{field.description}</span>
              </Show>
              <Show when={errors()[field.key]}>
                <span class="config-error">{errors()[field.key]}</span>
              </Show>
            </div>
            <div class="config-control">
              <Switch
                fallback={
                  <input
                    id={`config-${field.key}`}
                    class="field"
                    type={field.secret ? "password" : field.type === "number" || field.type === "integer" ? "number" : "text"}
                    autocomplete="off"
                    spellcheck={false}
                    disabled={busy()}
                    value={field.secret ? "" : show(value(field))}
                    placeholder={
                      field.secret
                        ? props.config?.secretsSet.includes(field.key)
                          ? "Set · type to replace"
                          : "Not set"
                        : field.default === undefined
                          ? field.type === "strings"
                            ? "Comma-separated"
                            : "Not set"
                          : show(field.default)
                    }
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                    }}
                    onBlur={(event) => commit(field, event.currentTarget.value)}
                  />
                }
              >
                <Match when={field.type === "boolean"}>
                  <Toggle label={field.title} checked={value(field) === true} disabled={busy()} onChange={(checked) => void save(field, checked)} />
                </Match>
                <Match when={field.type === "enum"}>
                  <select
                    id={`config-${field.key}`}
                    class="field"
                    disabled={busy()}
                    value={show(value(field))}
                    onChange={(event) => void save(field, event.currentTarget.value)}
                  >
                    <Show when={value(field) === undefined}>
                      <option value="">Not set</option>
                    </Show>
                    <For each={field.options}>{(option) => <option value={option}>{option}</option>}</For>
                  </select>
                </Match>
                <Match when={field.type === "other"}>
                  <span class="muted small">Edit in {props.file}</span>
                </Match>
              </Switch>
              <Show when={resettable(field)}>
                <button
                  class="link-button small"
                  disabled={busy()}
                  onClick={() => void save(field, null)}
                  data-tip={field.default === undefined ? "Unset" : `Back to ${show(field.default)}`}
                >
                  Reset
                </button>
              </Show>
            </div>
          </div>
        )}
      </For>
      <p class="config-note muted small">Saved to {props.file}.</p>
    </div>
  );
}
