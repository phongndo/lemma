import { Schema } from "effect";
import { ConfigField, ConfigValues } from "./config.ts";
import { CompositionInfo, ConfigScope, FaultRecord, faultMessage, HookUse, PluginSource, RegistryUse } from "./host.ts";
import type { PluginInfo } from "./host.ts";

/*
 * The host as clients see it, apart from the domain calls in `HostRpcs`: who it
 * is, what its plugins are doing, and what a reload changed. Kept out of
 * `rpc.ts`, which reaches every domain's contracts, so the runtime contracts
 * (`@lemma/contracts/runtime`) reach none.
 */

/**
 * An error as clients receive it. Domain errors map to `HostError` at the
 * boundary; `code` keeps the original tag or reason so clients can branch on it.
 */
export class HostError extends Schema.TaggedError<HostError>()("HostError", {
  code: Schema.String,
  message: Schema.String,
  /** Plugin, session, or provider the error concerns, when known. */
  subject: Schema.optional(Schema.String),
}) {}

/**
 * One plugin the host knows, as clients see it. `enabled` is the config files'
 * choice; `state` is the core's, `disabled` when the plugin is not loaded. A
 * plugin can be enabled yet unloaded when a capability it requires comes from a
 * plugin that is off: `haltedBy` then names that plugin.
 */
export const PluginStatus = Schema.Struct({
  id: Schema.String,
  version: Schema.optional(Schema.String),
  source: PluginSource,
  /** A local plugin with a bundled plugin's id runs instead of it. */
  shadows: Schema.optional(Schema.Boolean),
  enabled: Schema.Boolean,
  /** The config file whose row sets `enabled`; absent when neither does. */
  scope: Schema.optional(ConfigScope),
  /** Why this plugin cannot be turned off: it is pinned by the app, or a pinned plugin needs what it provides. */
  locked: Schema.optional(Schema.String),
  /** Capability keys. */
  provides: Schema.Array(Schema.String),
  requires: Schema.Array(Schema.String),
  state: Schema.Literals(["pending", "activating", "active", "draining", "closed", "failed", "disabled"]),
  fault: Schema.optional(Schema.Struct({ phase: Schema.String, operation: Schema.optional(Schema.String), message: Schema.String })),
  /** The plugin whose failure or absence keeps this one from running. */
  haltedBy: Schema.optional(Schema.String),
  /** Why it is left out though enabled: it does not decode its config, is written for another API, or failed to start with the host. */
  problem: Schema.optional(Schema.String),
  /** Its settings form, projected from its config Schema; absent when it takes no config. */
  configFields: Schema.optional(Schema.Array(ConfigField)),
  /** The config it runs with, as the form shows it. */
  config: Schema.optional(ConfigValues),
  /** The config file whose row sets `config`; absent when neither does. */
  configScope: Schema.optional(ConfigScope),
  /** Hooks its running instance intercepts. */
  hooks: Schema.optional(Schema.Array(HookUse)),
  /** Events its running instance observes. */
  observes: Schema.optional(Schema.Array(Schema.String)),
  /** Registries its running instance contributes to, with how many items. */
  contributes: Schema.optional(Schema.Array(RegistryUse)),
  /** Its recent faults, newest first, across restarts. */
  faults: Schema.optional(Schema.Array(FaultRecord)),
});
export type PluginStatus = typeof PluginStatus.Type;

/** A plugin as clients see it: its fault in a line, and `disabled` when the core has not loaded it (off, or waiting on one that is). */
export const toPluginStatus = (info: PluginInfo): PluginStatus => {
  const { fault, state, ...rest } = info;
  return {
    ...rest,
    state: state ?? "disabled",
    ...(fault === undefined
      ? {}
      : { fault: { phase: fault.phase, ...(fault.operation === undefined ? {} : { operation: fault.operation }), message: faultMessage(fault) } }),
  };
};

/** What a reload or configure changed, as clients report it. */
export const ReloadResult = Schema.Struct({
  started: Schema.Array(Schema.String),
  restarted: Schema.Array(Schema.String),
  stopped: Schema.Array(Schema.String),
  /** Plugins the change left failed or halted (`ReloadReport.failed`). */
  failed: Schema.optional(Schema.Array(Schema.String)),
  /** Applied after the reply, because it restarts the transport; see `ConfigureReport`. */
  deferred: Schema.optional(Schema.Boolean),
});
export type ReloadResult = typeof ReloadResult.Type;

/**
 * What a reload or config change did, in a phrase (`started x; restarted y; failed z`), leaving out
 * `except`, the plugin the caller already names; undefined when it changed nothing.
 */
export const describeReload = (result: Pick<ReloadResult, "started" | "restarted" | "stopped" | "failed">, except?: string): string | undefined => {
  const phrase = (verb: string, ids: readonly string[] | undefined) => {
    const named = (ids ?? []).filter((id) => id !== except);
    return named.length > 0 ? `${verb} ${named.join(", ")}` : "";
  };
  const parts = [
    phrase("started", result.started),
    phrase("restarted", result.restarted),
    phrase("stopped", result.stopped),
    phrase("failed", result.failed),
  ].filter(Boolean);
  return parts.length > 0 ? parts.join("; ") : undefined;
};

/** Sent with `Host.Events` to receive `{ type: "subscribed" }` first. */
export const SUBSCRIBED_HEADER = "lemma-subscribed";

export const HostInfo = Schema.Struct({
  version: Schema.String,
  cwd: Schema.String,
  home: Schema.String,
  composition: CompositionInfo,
  /** What the host provides itself, by capability key (`HostControl.runtime`): a plugin requiring one needs no plugin for it. */
  runtime: Schema.Array(Schema.String),
});
export type HostInfo = typeof HostInfo.Type;

/**
 * The version of what the host serves on the wire (`HostRpcs`, `ChannelRpcs`, and their encoding, which Effect's RPC
 * owns): 3 since it serves channels, 2 since Lemma moved to Effect 4, 1 before (a host whose `/api/health` names
 * none). A client and a host speaking different versions cannot talk, so a client whose calls fail asks `/api/health`
 * to say why.
 */
export const HOST_PROTOCOL = 3;
