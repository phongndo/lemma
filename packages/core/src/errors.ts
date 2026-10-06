import { Data, Duration, Schema } from "effect";
import type { Cause } from "effect";

export class CompositionError extends Data.TaggedError("CompositionError")<{
  readonly reason:
    | "InvalidId"
    | "DuplicatePlugin"
    | "DuplicateCapability"
    | "ReservedCapability"
    | "MissingCapability"
    | "DependencyCycle"
    | "InvalidConfig"
    | "InactiveDependency"
    | "CoreClosed";
  readonly message: string;
  readonly plugins: readonly string[];
  readonly capability?: string;
  /** Location inside the plugin's config for `InvalidConfig`. */
  readonly path?: readonly (string | number)[];
}> {}

/** A lifecycle step exceeded its limit. Appears as the cause of a `PluginFault` with `deadline: true`. */
export class DeadlineExceeded extends Data.TaggedError("DeadlineExceeded")<{
  readonly pluginId: string;
  readonly phase: "activate" | "dispose";
  readonly limit: Duration.Duration;
}> {
  override get message(): string {
    return `Plugin "${this.pluginId}" did not finish ${this.phase} within ${Duration.format(this.limit)}`;
  }
}

export class CapabilityMismatch extends Data.TaggedError("CapabilityMismatch")<{
  readonly pluginId: string;
  readonly missing: readonly string[];
  readonly undeclared: readonly string[];
}> {
  override get message(): string {
    return `Plugin "${this.pluginId}" exports do not match its declaration (missing: ${this.missing.join(", ") || "none"}; undeclared: ${this.undeclared.join(", ") || "none"})`;
  }
}

export class CoreClosed extends Data.TaggedError("CoreClosed")<{}> {
  override get message(): string {
    return "The core is closing or has closed";
  }
}

/** The closing caller's total wait expired; cleanup continues and the core stays closing. */
export class ShutdownTimeout extends Data.TaggedError("ShutdownTimeout")<{
  readonly limit: Duration.Duration;
}> {
  override get message(): string {
    return `Core shutdown did not finish within ${Duration.format(this.limit)}; cleanup is still pending`;
  }
}

export class EventError extends Data.TaggedError("EventError")<{
  readonly reason: "PointConflict" | "InvalidBuffer";
  readonly event: string;
  readonly message: string;
}> {}

export class HookError extends Data.TaggedError("HookError")<{
  readonly reason: "PointConflict" | "InvalidOrder" | "OwnerClosed" | "NextAlreadyCalled" | "InvocationEnded";
  readonly hook: string;
  readonly pluginId?: string;
  readonly message: string;
}> {}

export class RegistryError extends Data.TaggedError("RegistryError")<{
  readonly reason: "PointConflict" | "InvalidOrder" | "OwnerClosed" | "Conflict" | "MissingKey";
  readonly registry: string;
  readonly pluginId?: string;
  /** For a "Conflict": the key, and the plugin that holds it. */
  readonly key?: string;
  readonly holder?: string;
  readonly message: string;
}> {}

/** Where in a plugin's life a failure was observed. */
export const FaultPhase = Schema.Literals(["activate", "service", "observe", "background", "dispose"]);
export type FaultPhase = typeof FaultPhase.Type;

/**
 * Failures observed by lifecycle, observer, and background-work supervision are
 * attributed here. Hooks preserve their error channel and carry tracing attribution;
 * arbitrary capability calls are not intercepted.
 * The cause retains typed failures, defects,
 * and their stacks. `deadline` marks a step that ran out of time, which is
 * reported as such and never as a clean stop.
 */
export class PluginFault extends Data.TaggedError("PluginFault")<{
  readonly pluginId: string;
  readonly phase: FaultPhase;
  /** Hook name, event name, background task name, or service operation. */
  readonly operation?: string;
  readonly deadline?: boolean;
  readonly cause: Cause.Cause<unknown>;
}> {
  override get message(): string {
    const where = this.operation === undefined ? this.phase : `${this.phase} ${this.operation}`;
    return `Plugin "${this.pluginId}" failed during ${where}${this.deadline ? " (deadline exceeded)" : ""}`;
  }
}

/** A reported fault's sequence is monotonic within one core. Gaps reveal stream loss. */
export type ReportedFault = PluginFault & { readonly sequence: number };

/** A serializable, actionable message about a composition. Errors block; warnings do not. */
export class Diagnostic extends Schema.Class<Diagnostic>("@lemma/core/Diagnostic")({
  severity: Schema.Literals(["error", "warning"]),
  pluginId: Schema.optional(Schema.String),
  /** Location inside the plugin's config, when the problem is a config value. */
  path: Schema.optional(Schema.Array(Schema.Union([Schema.String, Schema.Number]))),
  message: Schema.String,
  suggestion: Schema.optional(Schema.String),
}) {}

/** Diagnostics for a failed change. Planning failures preserve the composition; exclusive activation failures may not. */
export class ReloadError extends Data.TaggedError("ReloadError")<{
  readonly diagnostics: readonly Diagnostic[];
}> {
  override get message(): string {
    return this.diagnostics.map((d) => `${d.severity}: ${d.message}`).join("\n");
  }
}
