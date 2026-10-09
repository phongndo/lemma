import { Diagnostic } from "@lemma/core";
import type { BundleManifest, BundleRow, PluginRow } from "@lemma/contracts/runtime";

export interface BundleInput {
  readonly manifests: readonly BundleManifest[];
  readonly rows: Readonly<Record<string, BundleRow>>;
  /** Explicit per-plugin rows always win, including an entire config object. */
  readonly plugins: Readonly<Record<string, PluginRow>>;
  readonly ui: Readonly<Record<string, PluginRow>>;
}

export interface BundleExpansion {
  readonly plugins: Readonly<Record<string, PluginRow>>;
  readonly ui: Readonly<Record<string, PluginRow>>;
  /** An error means neither expansion may be applied. */
  readonly diagnostics: readonly Diagnostic[];
}

/** Whether the bundle is selected, independent of whether its members can run. */
export const bundleEnabled = (manifest: BundleManifest, row: BundleRow | undefined): boolean => row?.enabled ?? manifest.enabledByDefault ?? true;

/**
 * Authoring metadata expanded into ordinary rows before either runtime plans.
 * Bundles have no lifecycle and provide no capability. A shared member stays
 * enabled while any owner is selected; no selected owner produces an explicit
 * off row (the ordinary planner otherwise enables every known plugin).
 *
 * Selected members deliberately have no generated `enabled: true`: the
 * planner must still let a user's alternative provider replace a bundled one
 * by capability. Explicit rows then win. Bundle config defaults merge at the
 * top level, with equal values accepted and conflicts diagnosed rather than
 * resolved by order. An explicit config replaces all bundle config defaults,
 * just as a project's config replaces the user's. App defaults still apply
 * underneath when the existing planner runs.
 */
export function expandBundles(input: BundleInput): BundleExpansion {
  const diagnostics: Diagnostic[] = [];
  const error = (message: string, pluginId?: string) =>
    diagnostics.push(new Diagnostic({ severity: "error", message, ...(pluginId === undefined ? {} : { pluginId }) }));
  const manifests = [...input.manifests].sort((a, b) => compare(a.id, b.id));
  const seen = new Set<string>();
  for (const manifest of manifests) {
    if (!manifest.id.trim()) error("A bundle has an empty id");
    if (seen.has(manifest.id)) error(`Bundle "${manifest.id}" is defined more than once`);
    seen.add(manifest.id);
    for (const [section, members] of [
      ["plugins", manifest.host],
      ["ui", manifest.ui],
    ] as const) {
      for (const [id, defaults] of Object.entries(manifest.defaults?.[section] ?? {})) {
        if (!members.includes(id)) error(`Bundle "${manifest.id}" sets defaults for "${section}.${id}", which is not one of its members`, id);
        if (defaults.enabled !== undefined)
          error(`Bundle "${manifest.id}" sets an enabled default for "${section}.${id}"; select the bundle or use an explicit plugin row instead`, id);
      }
    }
  }
  for (const id of Object.keys(input.rows).sort(compare)) {
    if (!seen.has(id)) error(`The bundle row for "${id}" names no bundle; remove it or add its definition`);
  }

  const expand = (section: "plugins" | "ui", explicit: Readonly<Record<string, PluginRow>>): Readonly<Record<string, PluginRow>> => {
    const owners = new Map<string, BundleManifest[]>();
    for (const manifest of manifests) {
      for (const id of new Set(section === "plugins" ? manifest.host : manifest.ui)) {
        const previous = owners.get(id) ?? [];
        previous.push(manifest);
        owners.set(id, previous);
      }
    }
    const result: Record<string, PluginRow> = Object.create(null);
    for (const [id, all] of [...owners].sort(([a], [b]) => compare(a, b))) {
      const selected = all.filter((manifest) => bundleEnabled(manifest, input.rows[manifest.id]));
      const row = Object.hasOwn(explicit, id) ? explicit[id] : undefined;
      const generated: { enabled?: boolean; required?: boolean; config?: unknown } = {};
      if (selected.length === 0) {
        generated.enabled = false;
        if (row?.required === true && row.enabled === undefined)
          error(`Bundle selection would turn off required plugin "${section}.${id}"; keep a bundle selected or explicitly change the plugin row`, id);
      }
      const defaults = selected.flatMap((manifest) => {
        const value = manifest.defaults?.[section]?.[id];
        return value === undefined ? [] : [{ owner: manifest.id, value }];
      });
      const choose = (field: string, values: readonly { owner: string; value: unknown }[]): unknown => {
        if (values.length === 0) return undefined;
        const first = values[0]!;
        if (values.some((entry) => canonical(entry.value) !== canonical(first.value))) {
          error(
            `Bundles ${values.map((entry) => `"${entry.owner}"`).join(" and ")} disagree on "${section}.${id}.${field}"; set an explicit plugin row to resolve it`,
            id,
          );
          return undefined;
        }
        return first.value;
      };
      if (row?.required === undefined) {
        const required = choose(
          "required",
          defaults.filter(({ value }) => value.required !== undefined).map(({ owner, value }) => ({ owner, value: value.required })),
        );
        if (required !== undefined) generated.required = required as boolean;
      }
      if (row?.config === undefined) {
        const configs = defaults.filter(({ value }) => value.config !== undefined).map(({ owner, value }) => ({ owner, value: value.config }));
        if (configs.length > 0 && configs.every(({ value }) => isRecord(value))) {
          const config: Record<string, unknown> = Object.create(null);
          const fields = new Set(configs.flatMap(({ value }) => Object.keys(value as Record<string, unknown>)));
          for (const field of [...fields].sort(compare)) {
            const value = choose(
              `config.${field}`,
              configs
                .filter(({ value }) => Object.hasOwn(value as object, field))
                .map(({ owner, value }) => ({ owner, value: (value as Record<string, unknown>)[field] })),
            );
            if (value !== undefined) config[field] = value;
          }
          generated.config = config;
        } else if (configs.length > 0) {
          const config = choose("config", configs);
          if (config !== undefined) generated.config = config;
        }
      }
      result[id] = { ...generated, ...row };
    }
    for (const [id, row] of Object.entries(explicit)) if (!owners.has(id)) result[id] = row;
    return result;
  };
  const plugins = expand("plugins", input.plugins);
  const ui = expand("ui", input.ui);
  return { plugins, ui, diagnostics };
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
/** Config comes from JSON: compare objects independently of insertion order, retaining array order. */
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort(compare)
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
};
