import { Order, Result, Schema, SchemaIssue, Scope } from "effect";
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

/** What is wrong with the application's capabilities: one the runtime supplies itself, or one listed twice. */
export function applicationProblems(provided: readonly string[]): CompositionError[] {
  const seen = new Set<string>();
  return provided.flatMap((key) => {
    if (reserved.has(key))
      return [
        new CompositionError({
          reason: "ReservedCapability",
          message: `The application cannot provide runtime capability "${key}"`,
          plugins: [],
          capability: key,
        }),
      ];
    if (seen.has(key))
      return [
        new CompositionError({
          reason: "DuplicateCapability",
          message: `The application lists capability "${key}" more than once`,
          plugins: [],
          capability: key,
        }),
      ];
    seen.add(key);
    return [];
  });
}

/**
 * Validate a whole composition before executing any plugin code. Every problem
 * is collected so a reload can report them all at once; the first is enough to
 * reject a fixed composition. `providedKeys` are the application's: present
 * for every plugin, and provided by none.
 */
export function plan(
  plugins: readonly Plugin[],
  rawConfigs: (id: string) => unknown,
  providedKeys: readonly string[] = [],
): Result.Result<Planned, readonly [CompositionError, ...CompositionError[]]> {
  const errors: CompositionError[] = applicationProblems(providedKeys);
  const provided = new Set(providedKeys);
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
      if (provided.has(tag.key)) {
        errors.push(
          new CompositionError({
            reason: "ReservedCapability",
            message: `Plugin "${plugin.id}" cannot provide "${tag.key}": the application provides it`,
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

  // The versions of the contracts the plugins implement, and whether each plugin uses the version implemented.
  const implemented = new Map<string, { readonly version: number; readonly by: string }[]>();
  for (const plugin of byId.values()) {
    for (const spec of plugin.implements ?? []) {
      const parsed = parseContract(spec);
      if (parsed === undefined) {
        errors.push(malformedContract(plugin.id, spec, "implements"));
        continue;
      }
      implemented.set(parsed.name, [...(implemented.get(parsed.name) ?? []), { version: parsed.version, by: plugin.id }]);
    }
  }
  for (const plugin of byId.values()) {
    for (const spec of plugin.uses ?? []) {
      const parsed = parseContract(spec);
      if (parsed === undefined) {
        errors.push(malformedContract(plugin.id, spec, "uses"));
        continue;
      }
      const other = (implemented.get(parsed.name) ?? []).find((each) => each.by !== plugin.id && each.version !== parsed.version);
      if (other === undefined) continue;
      errors.push(
        new CompositionError({
          reason: "IncompatibleContract",
          message: `Plugin "${plugin.id}" is written for version ${parsed.version} of contract "${parsed.name}", but "${other.by}" implements version ${other.version}`,
          plugins: [plugin.id],
          contract: { name: parsed.name, uses: parsed.version, implemented: other.version, by: other.by },
        }),
      );
    }
  }

  const configs = new Map<string, unknown>();
  for (const plugin of byId.values()) {
    if (!plugin.config) continue;
    // Absent config decodes as an empty object so all-optional schemas need no row.
    const result = Schema.decodeUnknownResult(plugin.config)(rawConfigs(plugin.id) ?? {});
    if (Result.isFailure(result)) {
      const path = SchemaIssue.makeFormatterStandardSchemaV1()(result.failure.issue).issues[0]?.path?.filter(
        (segment): segment is string | number => typeof segment === "string" || typeof segment === "number",
      );
      errors.push(
        new CompositionError({
          reason: "InvalidConfig",
          message: `Invalid config for plugin "${plugin.id}":\n${result.failure.message}`,
          plugins: [plugin.id],
          ...(path === undefined ? {} : { path }),
        }),
      );
    } else {
      configs.set(plugin.id, result.success);
    }
  }

  const dependencies = new Map<Plugin, readonly Plugin[]>();
  for (const plugin of byId.values()) {
    const required = new Set<Plugin>();
    for (const tag of plugin.requires) {
      if (builtins.has(tag.key) || provided.has(tag.key)) continue;
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

  if (errors.length) return Result.fail(errors as [CompositionError, ...CompositionError[]]);
  return Result.succeed({
    ordered,
    configs,
    providers: new Map([...providers].map(([key, plugin]) => [key, plugin.id])),
  });
}

const byPluginId = Order.mapInput(Order.String, (plugin: Plugin) => plugin.id);

/** A contract version, `name@version` with a whole-number version; undefined when `spec` is not one. */
function parseContract(spec: unknown): { readonly name: string; readonly version: number } | undefined {
  if (typeof spec !== "string") return undefined;
  const match = /^(.+)@(\d+)$/.exec(spec);
  return match === null ? undefined : { name: match[1]!, version: Number(match[2]) };
}

function malformedContract(pluginId: string, spec: unknown, field: "uses" | "implements"): CompositionError {
  return new CompositionError({
    reason: "IncompatibleContract",
    message: `Plugin "${pluginId}" ${field} ${JSON.stringify(spec)}, which is not name@version (a whole-number version)`,
    plugins: [pluginId],
    contract: { name: String(spec) },
  });
}
