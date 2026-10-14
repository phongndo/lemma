import { Result } from "effect";
import { CompositionError } from "../errors.ts";
import type { PluginState } from "../core.ts";
import type { Plugin } from "../plugin.ts";
import { plan } from "./graph.ts";

/** A plugin and its raw (undecoded) config. */
export interface Member {
  readonly plugin: Plugin;
  readonly config?: unknown;
}

/** What runs now, as a change compares it with what is asked for. */
export interface Running {
  readonly instances: ReadonlyMap<string, { readonly plugin: Plugin; readonly rawConfig: unknown; readonly state: PluginState }>;
  /** Ids in dependency order. */
  readonly order: readonly string[];
}

/** A planned change: what runs after it, and what it starts, restarts, and stops to get there. */
export interface Change {
  readonly ordered: readonly Plugin[];
  readonly configs: ReadonlyMap<string, unknown>;
  readonly providers: ReadonlyMap<string, string>;
  readonly raw: ReadonlyMap<string, unknown>;
  /** Started or replaced: new, a different definition or config, forced, or depending on one of these. */
  readonly changed: ReadonlySet<string>;
  /** Running now and absent from `members`. */
  readonly stops: readonly string[];
}

/**
 * Plans applying `members` in place of `running`: the one decision of what a
 * change touches, which applying it and asking what it would touch
 * (`Loader.affected`) both use. Fails with every planning problem, or with a
 * changed plugin requiring a capability from an unchanged provider that is
 * not active.
 */
export function planChange(
  members: readonly Member[],
  running: Running,
  force: ReadonlySet<string>,
  providedKeys: readonly string[],
): Result.Result<Change, readonly [CompositionError, ...CompositionError[]]> {
  const raw = new Map(members.map((member) => [member.plugin.id, member.config]));
  const planned = plan(
    members.map((member) => member.plugin),
    (id) => raw.get(id),
    providedKeys,
  );
  if (Result.isFailure(planned)) return Result.fail(planned.failure);
  const { ordered, configs, providers } = planned.success;
  const { instances } = running;
  const changed = new Set<string>();
  const errors: CompositionError[] = [];
  for (const plugin of ordered) {
    const instance = instances.get(plugin.id);
    const dependsOnChanged = plugin.requires.some((tag) => {
      const provider = providers.get(tag.key);
      return provider !== undefined && changed.has(provider);
    });
    if (!instance || instance.plugin !== plugin || !deepEqual(instance.rawConfig, raw.get(plugin.id)) || force.has(plugin.id) || dependsOnChanged) {
      changed.add(plugin.id);
      for (const tag of plugin.requires) {
        const provider = providers.get(tag.key);
        if (provider !== undefined && !changed.has(provider) && instances.get(provider)?.state !== "active") {
          errors.push(
            new CompositionError({
              reason: "InactiveDependency",
              capability: tag.key,
              plugins: [plugin.id, provider],
              message: `Plugin "${plugin.id}" requires "${tag.key}" from "${provider}", which is not active; restart "${provider}" first`,
            }),
          );
        }
      }
    }
  }
  if (errors.length) return Result.fail(errors as [CompositionError, ...CompositionError[]]);
  return Result.succeed({ ordered, configs, providers, raw, changed, stops: running.order.filter((id) => !raw.has(id)) });
}

/** Structural equality for config data (JSON-like values); other objects compare by reference. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((value, index) => deepEqual(value, (b as unknown[])[index]));
  if (Object.getPrototypeOf(a) !== Object.prototype || Object.getPrototypeOf(b) !== Object.prototype) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}
