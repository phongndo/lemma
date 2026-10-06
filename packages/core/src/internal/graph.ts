import { Either, Order, ParseResult, Schema, Scope } from "effect";
import { CompositionError } from "../errors.ts";
import { Events } from "../events.ts";
import { Hooks, PluginContext } from "../hooks.ts";
import { Registries } from "../registries.ts";
import type { Plugin } from "../plugin.ts";

const builtins = new Set<string>([Hooks.key, PluginContext.key, Events.key, Registries.key]);
const reserved = new Set([...builtins, Scope.Scope.key]);

interface Planned {
  /** Dependency order; independent plugins use code-unit id order. */
  readonly ordered: readonly Plugin[];
  /** Decoded config per plugin id (absent for plugins without a schema). */
  readonly configs: ReadonlyMap<string, unknown>;
  /** Provider plugin id per capability key. */
  readonly providers: ReadonlyMap<string, string>;
}

/**
 * Validate a whole composition before executing any plugin code. Every problem
 * is collected so a reload can report them all at once; the first is enough to
 * reject a fixed composition.
 */
export function plan(
  plugins: readonly Plugin[],
  rawConfigs: (id: string) => unknown,
): Either.Either<Planned, readonly [CompositionError, ...CompositionError[]]> {
  const errors: CompositionError[] = [];
  const byId = new Map<string, Plugin>();
  const providers = new Map<string, Plugin>();

  for (const plugin of plugins) {
    if (!plugin.id || plugin.id.trim() !== plugin.id) {
      errors.push(
        new CompositionError({
          reason: "InvalidId",
          message: "Plugin ids must be nonempty and have no surrounding whitespace",
          plugins: [plugin.id],
        }),
      );
      continue;
    }
    if (byId.has(plugin.id)) {
      errors.push(
        new CompositionError({
          reason: "DuplicatePlugin",
          message: `Duplicate plugin id "${plugin.id}"`,
          plugins: [plugin.id],
        }),
      );
      continue;
    }
    byId.set(plugin.id, plugin);
    for (const tag of plugin.provides) {
      if (reserved.has(tag.key)) {
        errors.push(
          new CompositionError({
            reason: "ReservedCapability",
            message: `Plugin "${plugin.id}" cannot provide runtime capability "${tag.key}"`,
            plugins: [plugin.id],
            capability: tag.key,
          }),
        );
        continue;
      }
      const previous = providers.get(tag.key);
      if (previous) {
        errors.push(
          new CompositionError({
            reason: "DuplicateCapability",
            message: `Capability "${tag.key}" is provided by both "${previous.id}" and "${plugin.id}"; select one provider`,
            plugins: [previous.id, plugin.id],
            capability: tag.key,
          }),
        );
        continue;
      }
      providers.set(tag.key, plugin);
    }
  }

  const configs = new Map<string, unknown>();
  for (const plugin of byId.values()) {
    if (!plugin.config) continue;
    // Absent config decodes as an empty object so all-optional schemas need no row.
    const result = Schema.decodeUnknownEither(plugin.config)(rawConfigs(plugin.id) ?? {});
    if (Either.isLeft(result)) {
      const path = ParseResult.ArrayFormatter.formatErrorSync(result.left)[0]?.path.filter(
        (segment): segment is string | number => typeof segment !== "symbol",
      );
      errors.push(
        new CompositionError({
          reason: "InvalidConfig",
          message: `Invalid config for plugin "${plugin.id}":\n${ParseResult.TreeFormatter.formatErrorSync(result.left)}`,
          plugins: [plugin.id],
          ...(path === undefined ? {} : { path }),
        }),
      );
    } else {
      configs.set(plugin.id, result.right);
    }
  }

  const dependencies = new Map<Plugin, readonly Plugin[]>();
  for (const plugin of byId.values()) {
    const required = new Set<Plugin>();
    for (const tag of plugin.requires) {
      if (builtins.has(tag.key)) continue;
      const provider = providers.get(tag.key);
      if (!provider) {
        errors.push(
          new CompositionError({
            reason: "MissingCapability",
            message: `Plugin "${plugin.id}" requires missing capability "${tag.key}"`,
            plugins: [plugin.id],
            capability: tag.key,
          }),
        );
        continue;
      }
      required.add(provider);
    }
    dependencies.set(plugin, [...required].sort(byPluginId));
  }

  const ordered: Plugin[] = [];
  const visited = new Set<Plugin>();
  const visiting = new Set<Plugin>();
  // Iterative DFS avoids JS stack depth limits on large compositions.
  for (const start of [...byId.values()].sort(byPluginId)) {
    if (visited.has(start)) continue;
    const stack: { plugin: Plugin; index: number }[] = [{ plugin: start, index: 0 }];
    visiting.add(start);
    while (stack.length) {
      const frame = stack[stack.length - 1]!;
      const dependency = dependencies.get(frame.plugin)![frame.index++];
      if (dependency) {
        if (visiting.has(dependency)) {
          const first = stack.findIndex((entry) => entry.plugin === dependency);
          const cycle = [...stack.slice(first).map((entry) => entry.plugin.id), dependency.id];
          errors.push(
            new CompositionError({
              reason: "DependencyCycle",
              message: `Plugin dependency cycle: ${cycle.join(" -> ")}`,
              plugins: cycle,
            }),
          );
          // Skip the back edge so the remaining graph is still reported.
          continue;
        }
        if (!visited.has(dependency)) {
          visiting.add(dependency);
          stack.push({ plugin: dependency, index: 0 });
        }
      } else {
        stack.pop();
        visiting.delete(frame.plugin);
        visited.add(frame.plugin);
        ordered.push(frame.plugin);
      }
    }
  }

  if (errors.length) return Either.left(errors as [CompositionError, ...CompositionError[]]);
  return Either.right({
    ordered,
    configs,
    providers: new Map([...providers].map(([key, plugin]) => [key, plugin.id])),
  });
}

const byPluginId = Order.mapInput(Order.string, (plugin: Plugin) => plugin.id);
