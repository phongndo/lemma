import { bundleEnabled } from "@lemma/composition";
import type { BundleStatus, PluginRow } from "@lemma/contracts/runtime";
import type { LoadedComposition } from "./config.ts";

/** Public metadata excludes defaults, which may hold secret config. */
export function bundleStatuses(loaded: Pick<LoadedComposition, "bundleDefinitions" | "bundles" | "bundleEnabledIn" | "rows" | "ui">): readonly BundleStatus[] {
  const customized = (row: PluginRow | undefined) => row !== undefined && (row.enabled !== undefined || row.config !== undefined || row.required !== undefined);
  return loaded.bundleDefinitions.map((manifest) => ({
    id: manifest.id,
    title: manifest.title,
    ...(manifest.description === undefined ? {} : { description: manifest.description }),
    host: manifest.host,
    ui: manifest.ui,
    enabled: bundleEnabled(manifest, loaded.bundles[manifest.id]),
    customized: manifest.host.some((id) => customized(loaded.rows[id])) || manifest.ui.some((id) => customized(loaded.ui.plugins[id])),
    ...(loaded.bundleEnabledIn[manifest.id] === undefined ? {} : { scope: loaded.bundleEnabledIn[manifest.id] }),
  }));
}
