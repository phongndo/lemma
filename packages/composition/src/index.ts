export { catalog, faultHistory, resolveComposition, restartedBy, withReplacements } from "./catalog.ts";
export type { KnownPlugin, Resolved } from "./catalog.ts";
export { planComposition } from "./planner.ts";
export type { LocalPlugin, Plan, PlanInput } from "./planner.ts";
export { bundleEnabled, expandBundles } from "./bundles.ts";
export type { BundleInput, BundleExpansion } from "./bundles.ts";
