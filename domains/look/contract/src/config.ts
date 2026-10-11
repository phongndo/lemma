import { parseConfigValue } from "@lemma/contracts";
import type { ConfigField } from "@lemma/contracts";

/** A config value as a settings field shows it: a list as comma-separated text, no value as none. */
export const configText = (value: unknown): string => (value === undefined ? "" : Array.isArray(value) ? value.join(", ") : String(value));

/**
 * What text typed into a settings field saves (`ConfigFormProps.onSave`):
 * the text read as the field's type, as `lemma plugins config` reads it
 * (`parseConfigValue`), or `null` for a cleared field, unsetting it back to
 * its default; nothing when that changes nothing (a blank secret keeps the one
 * set); an error when the text is not of the field's type. `current` is the
 * field's value now (`ConfigValues.values`).
 */
export function configEdit(field: ConfigField, current: unknown, text: string): { readonly value: unknown } | { readonly error: string } | undefined {
  if (field.secret) {
    if (text === "") return undefined;
  } else if (text.trim() === "") return current !== undefined && current !== field.default ? { value: null } : undefined;
  const parsed = parseConfigValue(field, text);
  if ("error" in parsed) return parsed;
  return JSON.stringify(parsed.value) === JSON.stringify(current) ? undefined : parsed;
}
