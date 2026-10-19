export { checkComposition, makeCore } from "./core.ts";
export type { ApplicationServices, Core, CoreOptions, CoreSnapshot, PluginSnapshot, PluginState, RestartOptions } from "./core.ts";
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
export { schemaCheck } from "./checks.ts";
export { Hook, Hooks, PluginContext } from "./hooks.ts";
export type {
  BackgroundOptions,
  FaultOptions,
  HandlerStep,
  Handler,
  HookCheck,
  HookOptions,
  HookSummary,
  InvokeOptions,
  Next,
  PhaseOptions,
  PluginIdentity,
  Summary,
} from "./hooks.ts";
export { makeLoader } from "./loader.ts";
export { Admitted, Registries, Registry } from "./registries.ts";
export type { AdmittedWork, ContributeOptions, Contribution, RegistryOptions } from "./registries.ts";
export type { RegistrySnapshot } from "./internal/registries.ts";
export type { Composition, Loader, LoaderOptions, PluginEntry, PluginSource, ReloadReport } from "./loader.ts";
export { assert, AssertionError, Verify } from "./assert.ts";
export { awaitable, fail, isExpectedFailure } from "./awaitable.ts";
export { reportUnhandled } from "./unhandled.ts";
export { makeSpanCollector } from "./trace.ts";
export type { SpanCollector, SpanRecord } from "./trace.ts";
export type { Unhandled } from "./unhandled.ts";
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
