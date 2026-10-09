import { Cause, Effect, Option, Result } from "effect";
import type { Scope } from "effect";
import type { Core, CoreOptions } from "./core.ts";
import { Diagnostic, ReloadError } from "./errors.ts";
import type { PluginFault } from "./errors.ts";
import { makeRuntime, PlanError, toReloadError } from "./internal/runtime.ts";
import type { Member, PartialStart } from "./internal/runtime.ts";
import type { Capability, Plugin } from "./plugin.ts";

/** One row of a composition, keyed by plugin id. Config is validated by the plugin's schema. */
export interface PluginEntry {
  readonly enabled?: boolean;
  readonly config?: unknown;
}

/** Pure data: which plugins run and how they are configured. Reading files is the host's job. */
export interface Composition {
  readonly plugins: Readonly<Record<string, PluginEntry>>;
}

/** Maps ids to definitions. The host decides what an id means: a bundled map, an npm package, a path. */
export interface PluginSource {
  readonly resolve: (id: string) => Effect.Effect<Plugin, Diagnostic>;
}

export interface ReloadReport {
  readonly started: readonly string[];
  readonly stopped: readonly string[];
  readonly restarted: readonly string[];
  readonly unchanged: readonly string[];
  /** Dependents of a restarted plugin that could not activate and were left failed or halted. Always empty for `apply`. */
  readonly failed: readonly string[];
  /** In-flight `core.run` work on the previous composition that outlived the drain deadline and was interrupted. */
  readonly interrupted: number;
  /** Dispose faults of replaced or stopped instances. The change still applied. */
  readonly faults: readonly PluginFault[];
}

export interface LoaderOptions<Provides extends readonly Capability[] = readonly Capability[]> extends Pick<
  CoreOptions<Provides, unknown>,
  "deadlines" | "shutdownTimeout" | "provide"
> {
  readonly source: PluginSource;
  readonly composition: Composition;
  /**
   * Starts the first composition with what can start: a plugin that fails to
   * activate is left `failed` (its fault in `core.inspect`, its dependents
   * halted, restartable) and the rest run. Only `required` plugins, and the
   * plugins they need, must activate, or the loader fails as without this.
   * `apply` stays all or nothing: it has a running composition to keep.
   */
  readonly partialStart?: { readonly required?: readonly string[] };
}

/**
 * Runs a composition described by data and changes it at runtime.
 *
 * `apply` plans the whole change first and reports every problem at once. Only
 * plugins whose definition or config changed (and their dependents) are touched.
 * Replacements start in a staging scope while the old instances keep serving;
 * then old instances stop admitting work, in-flight work drains, and they close.
 * Staging failures preserve the running composition, except for `exclusive`
 * plugins: they stop before their replacement starts and remain failed if it
 * cannot activate. Disposal faults after a swap are returned in the report.
 *
 * `apply` changes plugins only: the application's services (`provide`) are
 * fixed for the loader's life, built before its first composition starts and
 * released after its last plugin is disposed.
 */
export interface Loader {
  /** Compositions are checked when planned, so the core's capabilities are not statically typed. */
  readonly core: Core<any>;
  readonly composition: Effect.Effect<Composition>;
  readonly apply: (next: Composition) => Effect.Effect<ReloadReport, ReloadError>;
}

export function makeLoader<const Provides extends readonly Capability[] = readonly []>(
  options: LoaderOptions<Provides>,
): Effect.Effect<Loader, ReloadError, Scope.Scope> {
  return Effect.gen(function* () {
    const runtime = yield* makeRuntime(options).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause as Cause.Cause<never>);
        const error = Option.getOrUndefined(Cause.findErrorOption(cause));
        if (error instanceof PlanError) return Effect.fail(toReloadError(error));
        // Not a plugin's: the diagnostic names none.
        const message = `The application's services failed to build:\n${Cause.pretty(cause)}`;
        return Effect.fail(new ReloadError({ diagnostics: [new Diagnostic({ severity: "error", message })] }));
      }),
    );
    let current = options.composition;

    const resolve = (composition: Composition): Effect.Effect<readonly Member[], ReloadError> =>
      Effect.gen(function* () {
        const members: Member[] = [];
        const diagnostics: Diagnostic[] = [];
        for (const [id, entry] of Object.entries(composition.plugins)) {
          if (entry.enabled === false) continue;
          const resolved = yield* Effect.result(options.source.resolve(id));
          if (Result.isFailure(resolved)) {
            const diagnostic = resolved.failure;
            diagnostics.push(diagnostic.pluginId === undefined ? new Diagnostic({ ...diagnostic, pluginId: id }) : diagnostic);
          } else if (resolved.success.id !== id) {
            diagnostics.push(
              new Diagnostic({
                severity: "error",
                pluginId: id,
                message: `Source resolved "${id}" to a plugin whose id is "${resolved.success.id}"`,
                suggestion: `Fix the source mapping or the plugin's id`,
              }),
            );
          } else {
            members.push({ plugin: resolved.success, ...(entry.config === undefined ? {} : { config: entry.config }) });
          }
        }
        if (diagnostics.length) return yield* new ReloadError({ diagnostics });
        return members;
      });

    const apply = (next: Composition, partial?: PartialStart): Effect.Effect<ReloadReport, ReloadError> =>
      Effect.gen(function* () {
        const members = yield* resolve(next);
        const report = yield* runtime
          .apply(
            members,
            () => {
              current = next;
            },
            partial,
          )
          .pipe(Effect.mapError(toReloadError));
        return report;
      });

    const partial = options.partialStart === undefined ? undefined : { required: new Set(options.partialStart.required ?? []) };
    yield* apply(options.composition, partial).pipe(Effect.onError(() => runtime.shutdown));
    return { core: runtime.core, composition: Effect.sync(() => current), apply: (next) => apply(next) };
  });
}
