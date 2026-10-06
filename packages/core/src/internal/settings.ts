import { Clock, Context, Layer, Random, References, Schedule, Tracer } from "effect";

/**
 * Effect's runtime settings: references a caller sets for the work it runs
 * (clock, random source, console, config provider, tracer, log level and
 * annotations, error reporters, metric attributes, scheduler), as opposed to
 * services. Effect 3 kept them per fiber, outside any context; Effect 4 keeps
 * them in the context, so the core passes them on and leaves them out
 * explicitly. Every reference the `effect` module exports is one
 * (tests/settings.test.ts checks). Those of modules the core does not use
 * otherwise are named by key, which keeps the modules out of a browser bundle
 * (Metric alone is 8 kB).
 */
export const runtimeSettings: ReadonlySet<string> = new Set([
  ...Object.values(References as Record<string, unknown>).flatMap((value) => (Context.isKey(value) && Context.isReference(value) ? [value.key] : [])),
  Clock.Clock.key,
  Random.Random.key,
  "effect/Console",
  "effect/ConfigProvider",
  "effect/ErrorReporter/CurrentErrorReporters",
  "effect/Metric/CurrentMetricAttributes",
  "effect/Metric/MetricRegistry",
  "effect/Metric/FiberRuntimeMetrics",
  "effect/ExecutionPlan/CurrentMetadata",
  Schedule.CurrentMetadata.key,
]);

/** Keys a captured context leaves behind: the trace it was captured in, and the memo map of the Layer build that ran then. */
const transient: ReadonlySet<string> = new Set([Tracer.ParentSpan.key, Layer.CurrentMemoMap.key]);

/**
 * A captured context's services, for work that runs later on someone else's
 * fiber: settings belong to that fiber, trace ancestry to that invocation,
 * and a Layer build's memo map to that build.
 */
export function servicesOf<R>(context: Context.Context<R>): Context.Context<R> {
  const map = context.mapUnsafe;
  if (![...map.keys()].some((key) => transient.has(key) || runtimeSettings.has(key))) return context;
  return Context.makeUnsafe<R>(new Map([...map].filter(([key]) => !transient.has(key) && !runtimeSettings.has(key))));
}
