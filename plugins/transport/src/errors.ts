import { Cause } from "effect";
import { HostError } from "@lemma/contracts";
import type { PluginInfo, PluginStatus } from "@lemma/contracts";
import type { Diagnostic } from "@lemma/core";

interface Tagged {
  readonly _tag: string;
  readonly reason?: unknown;
  readonly message?: unknown;
  readonly sessionId?: unknown;
  readonly provider?: unknown;
  readonly pluginId?: unknown;
  readonly tool?: unknown;
  readonly path?: unknown;
  readonly command?: unknown;
  readonly server?: unknown;
  readonly diagnostics?: readonly Diagnostic[];
}

const isTagged = (error: unknown): error is Tagged => typeof error === "object" && error !== null && typeof (error as Tagged)._tag === "string";

const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

export const formatDiagnostic = (diagnostic: Diagnostic): string =>
  `${diagnostic.severity}${diagnostic.pluginId === undefined ? "" : ` [${diagnostic.pluginId}]`}: ${diagnostic.message}` +
  (diagnostic.suggestion === undefined ? "" : ` (${diagnostic.suggestion})`);

/**
 * Domain errors cross the wire as `HostError`. `code` is the error's `reason`
 * when it has one (`Busy`, `NotFound`), else its tag (`ReloadError`,
 * `CoreClosed`); `subject` is the session, provider, plugin, tool, workspace
 * path, command, or MCP server concerned.
 * A `ReloadError`'s diagnostics become the message, one per line, and the
 * plugin they all name (if one) the subject.
 */
export const toHostError = (error: unknown): HostError => {
  if (error instanceof HostError) return error;
  if (!isTagged(error)) return new HostError({ code: "Unknown", message: error instanceof Error ? error.message : String(error) });
  const code = text(error.reason) ?? error._tag;
  const named = new Set(error.diagnostics?.map((diagnostic) => diagnostic.pluginId));
  const subject =
    text(error.sessionId) ??
    text(error.provider) ??
    text(error.pluginId) ??
    text(error.tool) ??
    text(error.path) ??
    text(error.command) ??
    text(error.server) ??
    (named.size === 1 ? text([...named][0]) : undefined);
  const message = error.diagnostics?.length ? error.diagnostics.map(formatDiagnostic).join("\n") : (text(error.message) ?? code);
  return new HostError({ code, message, ...(subject === undefined ? {} : { subject }) });
};

/** A plugin the core has not loaded (turned off, or waiting on one that is) reports `state: "disabled"`. */
export const toPluginStatus = (info: PluginInfo): PluginStatus => {
  const fault = info.fault;
  const cause = fault === undefined ? undefined : Cause.squash(fault.cause);
  return {
    id: info.id,
    ...(info.version === undefined ? {} : { version: info.version }),
    source: info.source,
    ...(info.shadows === undefined ? {} : { shadows: info.shadows }),
    enabled: info.enabled,
    ...(info.scope === undefined ? {} : { scope: info.scope }),
    ...(info.locked === undefined ? {} : { locked: info.locked }),
    provides: info.provides,
    requires: info.requires,
    state: info.state ?? "disabled",
    ...(fault === undefined
      ? {}
      : {
          fault: {
            phase: fault.phase,
            ...(fault.operation === undefined ? {} : { operation: fault.operation }),
            message: `${fault.message}: ${cause instanceof Error ? cause.message : String(cause)}`,
          },
        }),
    ...(info.haltedBy === undefined ? {} : { haltedBy: info.haltedBy }),
    ...(info.configFields === undefined ? {} : { configFields: info.configFields }),
    ...(info.config === undefined ? {} : { config: info.config }),
    ...(info.configScope === undefined ? {} : { configScope: info.configScope }),
    ...(info.hooks === undefined ? {} : { hooks: info.hooks }),
    ...(info.observes === undefined ? {} : { observes: info.observes }),
    ...(info.contributes === undefined ? {} : { contributes: info.contributes }),
    ...(info.faults === undefined ? {} : { faults: info.faults }),
  };
};
