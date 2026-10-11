import { Cause, Context, Effect } from "effect";
import { PluginStopped } from "./errors.ts";
import { PluginContext } from "./hooks.ts";
import { current } from "./internal/current.ts";

/** Whose an error nothing handled was (see `reportUnhandled`). */
export type Unhandled =
  /** A call a stopped plugin made, refused (`PluginStopped`): expected, and no fault. */
  | { readonly kind: "stopped"; readonly pluginId: string }
  /** Raised by this plugin's work: reported as its fault. */
  | { readonly kind: "fault"; readonly pluginId: string }
  /** Raised by no plugin's work that can be told. */
  | { readonly kind: "unknown" };

/**
 * Reports an error nothing handled (a process's `unhandledRejection` or `uncaughtException`, a page's
 * `unhandledrejection`) as a fault of the plugin whose work raised it, so it shows with that plugin's faults rather than
 * end the process. Where the runtime has async-local storage (Node.js), a callback's context follows the timers and
 * promises it starts, so a throw from a plugin's stray `setTimeout` is still its own; elsewhere only a refused call is
 * told apart. The fault does not stop the plugin.
 */
export function reportUnhandled(error: unknown): Unhandled {
  if (error instanceof PluginStopped) return { kind: "stopped", pluginId: error.pluginId };
  const context = current()?.context;
  const plugin = context === undefined ? undefined : Context.getOrUndefined(context, PluginContext);
  if (plugin === undefined) return { kind: "unknown" };
  Effect.runFork(plugin.fault("unhandled", Cause.die(error)));
  return { kind: "fault", pluginId: plugin.id };
}
