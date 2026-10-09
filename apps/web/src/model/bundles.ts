import type { BundleStatus, PluginStatus } from "@lemma/contracts/runtime";

/** A feature selects members by id, without making their implementations dependencies of the settings page. */
export function bundleState(bundle: BundleStatus, host: readonly PluginStatus[], ui: readonly PluginStatus[], uiApplied = true) {
  const unavailable = (ids: readonly string[], plugins: readonly PluginStatus[]) =>
    ids.filter((id) => {
      const plugin = plugins.find((candidate) => candidate.id === id);
      return plugin === undefined || !plugin.enabled || plugin.state !== "active" || plugin.problem !== undefined;
    });
  const missing = [...unavailable(bundle.host, host).map((id) => `host:${id}`), ...unavailable(bundle.ui, ui).map((id) => `web:${id}`)];
  // An unselected feature can share active members with another selection or an explicit override.
  return { label: !uiApplied ? "UI not applied" : !bundle.enabled ? "Off" : missing.length > 0 ? "Incomplete" : "On", missing };
}
