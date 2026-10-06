export { checkComposition, makeCore } from "./core.ts";
export type { Core, CoreOptions, CoreSnapshot, PluginSnapshot, PluginState, RestartOptions } from "./core.ts";
export type { ReportedFault } from "./errors.ts";
export {
  CapabilityMismatch,
  CompositionError,
  CoreClosed,
  DeadlineExceeded,
  Diagnostic,
  EventError,
  FaultPhase,
  HookError,
  PluginFault,
  PluginStopped,
  RegistryError,
  ReloadError,
  ShutdownTimeout,
} from "./errors.ts";
export { Event, Events } from "./events.ts";
export type { Observer, ObserveOptions } from "./events.ts";
export { Hook, Hooks, PluginContext } from "./hooks.ts";
export type { BackgroundOptions, FaultOptions, Handler, HookOptions, Next, PluginIdentity } from "./hooks.ts";
export { makeLoader } from "./loader.ts";
export { Registries, Registry } from "./registries.ts";
export type { ContributeOptions, Contribution, RegistryOptions } from "./registries.ts";
export type { RegistrySnapshot } from "./internal/registries.ts";
export type { Composition, Loader, LoaderOptions, PluginEntry, PluginSource, ReloadReport } from "./loader.ts";
export { awaitable, fail, isExpectedFailure } from "./awaitable.ts";
export type { Awaitable } from "./awaitable.ts";
export { configSchema } from "./config.ts";
export type { ConfigDefaults, ConfigInput, ConfigOf, ConfigValue } from "./config.ts";
export { definePlugin } from "./plugin.ts";
export type {
  BuiltIns,
  Capabilities,
  Capability,
  Deadlines,
  Plugin,
  PluginLayer,
  PluginSetup,
  Provided,
  Services,
  SetupDefinition,
  SetupResult,
} from "./plugin.ts";
export type { EventSnapshot } from "./internal/events.ts";
export type { HookSnapshot } from "./internal/hooks.ts";
