import { For, Match, Show, Switch, createSignal } from "solid-js";
import type { ConfigField } from "@lemma/contracts";
import { configEdit, configText } from "../model/config.ts";
import type { ConfigFormProps } from "../ui/contracts.ts";
import { Toggle } from "../ui/parts.tsx";

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
    const edit = configEdit(field, value(field), text);
    if (edit === undefined) return;
    if ("error" in edit) setErrors((all) => ({ ...all, [field.key]: edit.error }));
    else void save(field, edit.value);
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
                    value={field.secret ? "" : configText(value(field))}
                    placeholder={
                      field.secret
                        ? props.config?.secretsSet.includes(field.key)
                          ? "Set · type to replace"
                          : "Not set"
                        : field.default === undefined
                          ? field.type === "strings"
                            ? "Comma-separated"
                            : "Not set"
                          : configText(field.default)
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
                    value={configText(value(field))}
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
                  data-tip={field.default === undefined ? "Unset" : `Back to ${configText(field.default)}`}
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
