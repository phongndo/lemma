// The host plugin is built by the app with a closure over its loader, so this
// package exports the factory rather than a ready plugin instance.
export { hostPlugin } from "./plugin.ts";
export type { HostControlService } from "./plugin.ts";
export { resolvePaths } from "./paths.ts";
export type { PathsService } from "./paths.ts";
export { HOST_PLUGIN_ID, isTrusted, loadComposition, patchConfig, projectPluginsDir, readConfigText, updateConfig } from "./config.ts";
export type { ConfigSection } from "./config.ts";
export { listUiFiles, projectUiDir, userUiDir } from "./ui.ts";
export { catalog, faultHistory, faultMessage, resolveComposition, restartedBy, withReplacements } from "./catalog.ts";
export type { KnownPlugin, Resolved } from "./catalog.ts";
export { planComposition } from "./planner.ts";
export type { Plan, PlanInput } from "./planner.ts";
export { compositionInfo } from "./composition.ts";
export { watchConfig, watchUi } from "./watch.ts";
