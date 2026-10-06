import { Rpc, RpcGroup } from "effect/rpc";
import { Schema } from "effect";
import { AgentView, PromptContent, QueuedPrompt, TurnOptions, WhenBusy } from "./agent.ts";
import { CommandInfo, CommandResult } from "./commands.ts";
import { ConfigField, ConfigValues } from "./config.ts";
import { FileSearchOptions, FileSearchResult } from "./files.ts";
import {
  CompositionInfo,
  ConfigScope,
  FaultRecord,
  faultMessage,
  HookUse,
  NoticePayload,
  PluginChange,
  PluginSource,
  RegistryUse,
  UiComposition,
} from "./host.ts";
import type { PluginInfo } from "./host.ts";
import { InspectorInfo } from "./inspectors.ts";
import { InteractionAnswer, InteractionRequest } from "./interaction.ts";
import { AuthType, CustomProviderSpec, ModelInfo, ProviderInfo, StreamEvent, Usage } from "./llm.ts";
import { SessionEvent, SessionInfo, TurnEndReason } from "./sessions.ts";
import { DirectoryListing, GitBranch, WorkspaceStatus } from "./workspace.ts";

/**
 * The host's remote surface, served by the transport plugin and consumed by
 * every client. Domain errors map to `HostError` at the boundary; `code` keeps
 * the original tag or reason so clients can branch on it.
 */
export class HostError extends Schema.TaggedError<HostError>()("HostError", {
  code: Schema.String,
  message: Schema.String,
  /** Plugin, session, or provider the error concerns, when known. */
  subject: Schema.optional(Schema.String),
}) {}

/** `PluginInfo` for the wire: the fault flattened to text, and "disabled" for a plugin the core has not loaded. */
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

/** Everything a client reacts to, multiplexed on one subscription. Losable: clients repair gaps from `Session.Events`. */
export const HostEvent = Schema.Union([
  /**
   * The first event of a subscription that asked for it with the `SUBSCRIBED_HEADER` header: from here on it
   * receives everything, interaction requests included. A client waits for it before acting on what the subscription
   * should see (an answer a command's question needs). Opt-in, so a client from before it never receives it.
   */
  Schema.Struct({ type: Schema.Literal("subscribed") }),
  Schema.Struct({ type: Schema.Literal("session-appended"), sessionId: Schema.String, event: SessionEvent }),
  Schema.Struct({ type: Schema.Literal("session-changed"), info: SessionInfo }),
  Schema.Struct({ type: Schema.Literal("session-removed"), sessionId: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("delta"),
    sessionId: Schema.String,
    turnId: Schema.String,
    stepId: Schema.String,
    seq: Schema.optional(Schema.Number),
    event: StreamEvent,
  }),
  Schema.Struct({
    type: Schema.Literal("tool-output"),
    sessionId: Schema.String,
    toolCallId: Schema.String,
    chunk: Schema.String,
    offset: Schema.optional(Schema.Number),
  }),
  Schema.Struct({ type: Schema.Literal("turn-started"), sessionId: Schema.String, turnId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("queue-changed"), sessionId: Schema.String, queue: Schema.Array(QueuedPrompt), revision: Schema.Number }),
  Schema.Struct({
    type: Schema.Literal("turn-ended"),
    sessionId: Schema.String,
    turnId: Schema.String,
    usage: Usage,
    reason: TurnEndReason,
  }),
  Schema.Struct({ type: Schema.Literal("interaction"), request: InteractionRequest }),
  Schema.Struct({ type: Schema.Literal("interaction-closed"), id: Schema.String }),
  Schema.Struct({ type: Schema.Literal("notice"), notice: NoticePayload }),
  Schema.Struct({ type: Schema.Literal("plugins-changed"), plugins: Schema.Array(PluginStatus) }),
  Schema.Struct({ type: Schema.Literal("commands-changed"), commands: Schema.Array(CommandInfo) }),
  Schema.Struct({ type: Schema.Literal("models-changed") }),
  Schema.Struct({ type: Schema.Literal("ui-changed"), ui: UiComposition }),
]);
export type HostEvent = typeof HostEvent.Type;

export const HostInfo = Schema.Struct({
  version: Schema.String,
  cwd: Schema.String,
  home: Schema.String,
  composition: CompositionInfo,
});
export type HostInfo = typeof HostInfo.Type;

/**
 * The version of `HostRpcs`'s encoding on the wire, which Effect's RPC owns: 2 since Lemma moved to Effect 4, 1
 * before (a host whose `/api/health` names none). A client and a host speaking different versions cannot talk, so a
 * client whose calls fail asks `/api/health` to say why.
 */
export const HOST_PROTOCOL = 2;

export class HostRpcs extends RpcGroup.make(
  Rpc.make("Session.List", { payload: { cwd: Schema.optional(Schema.String) }, success: Schema.Array(SessionInfo), error: HostError }),
  Rpc.make("Session.Get", { payload: { sessionId: Schema.String }, success: SessionInfo, error: HostError }),
  Rpc.make("Session.Create", { payload: { cwd: Schema.optional(Schema.String) }, success: SessionInfo, error: HostError }),
  Rpc.make("Session.Events", {
    payload: { sessionId: Schema.String, after: Schema.optional(Schema.Number) },
    success: Schema.Array(SessionEvent),
    error: HostError,
  }),
  Rpc.make("Session.Checkout", { payload: { sessionId: Schema.String, eventId: Schema.String }, success: SessionInfo, error: HostError }),
  Rpc.make("Session.SetTitle", { payload: { sessionId: Schema.String, title: Schema.String }, success: SessionInfo, error: HostError }),
  Rpc.make("Session.Mark", {
    payload: { sessionId: Schema.String, pinned: Schema.optional(Schema.Boolean), archived: Schema.optional(Schema.Boolean) },
    success: SessionInfo,
    error: HostError,
  }),
  /** Fails `Busy` while a turn runs in it. */
  Rpc.make("Session.Delete", { payload: { sessionId: Schema.String }, error: HostError }),

  /** Returns when the turn that places the prompt ends (see `Agent.prompt`): call it again with the same `requestId` to wait again. */
  Rpc.make("Agent.Prompt", {
    payload: {
      sessionId: Schema.String,
      content: PromptContent,
      options: Schema.optional(TurnOptions),
      requestId: Schema.optional(Schema.String),
      whenBusy: Schema.optional(WhenBusy),
    },
    error: HostError,
  }),
  Rpc.make("Agent.Cancel", { payload: { sessionId: Schema.String } }),
  Rpc.make("Agent.Running", { success: Schema.Array(Schema.String) }),
  Rpc.make("Agent.Queue", { payload: { sessionId: Schema.String }, success: Schema.Array(QueuedPrompt) }),
  /** False when the prompt was no longer queued. */
  Rpc.make("Agent.Withdraw", { payload: { sessionId: Schema.String, requestId: Schema.String }, success: Schema.Boolean }),
  /** What a client joining now shows of the session beyond its log: model output and tool output so far, and the queue. */
  Rpc.make("Agent.View", { payload: { sessionId: Schema.String }, success: AgentView }),

  Rpc.make("Llm.Providers", { success: Schema.Array(ProviderInfo), error: HostError }),
  Rpc.make("Llm.Models", { payload: { available: Schema.optional(Schema.Boolean) }, success: Schema.Array(ModelInfo), error: HostError }),
  /** Drives the provider's login flow; its questions arrive as `interaction` events and its progress as `notice` events. */
  Rpc.make("Llm.Login", { payload: { provider: Schema.String, type: AuthType }, error: HostError }),
  Rpc.make("Llm.Logout", { payload: { provider: Schema.String }, error: HostError }),
  Rpc.make("Llm.AddCustom", { payload: { spec: CustomProviderSpec }, success: Schema.String, error: HostError }),
  Rpc.make("Llm.RemoveCustom", { payload: { provider: Schema.String }, error: HostError }),
  Rpc.make("Llm.SetLogo", { payload: { provider: Schema.String, svg: Schema.optional(Schema.String) }, error: HostError }),

  /** Questions still waiting on an answer, so a client can show them without resubscribing. */
  Rpc.make("Interaction.List", { success: Schema.Array(InteractionRequest) }),
  Rpc.make("Interaction.Answer", { payload: { id: Schema.String, answer: InteractionAnswer }, error: HostError }),
  Rpc.make("Interaction.Dismiss", { payload: { id: Schema.String }, error: HostError }),

  Rpc.make("Workspace.Status", { payload: { path: Schema.String }, success: WorkspaceStatus }),
  Rpc.make("Workspace.Browse", { payload: { partialPath: Schema.String }, success: DirectoryListing }),
  Rpc.make("Workspace.CreateDirectory", { payload: { path: Schema.String }, success: WorkspaceStatus, error: HostError }),
  Rpc.make("Workspace.CreateWorktree", {
    payload: { path: Schema.String, branch: Schema.String, base: Schema.optional(Schema.String) },
    success: WorkspaceStatus,
    error: HostError,
  }),
  Rpc.make("Workspace.Branches", { payload: { path: Schema.String }, success: Schema.Array(GitBranch), error: HostError }),
  Rpc.make("Workspace.Checkout", {
    payload: { path: Schema.String, branch: Schema.String, create: Schema.optional(Schema.Boolean) },
    success: WorkspaceStatus,
    error: HostError,
  }),

  /** Entries in `cwd` matching `query`, best first (see `FileSearcher`). */
  Rpc.make("Files.Search", {
    payload: { cwd: Schema.String, query: Schema.String, ...FileSearchOptions.fields },
    success: FileSearchResult,
    error: HostError,
  }),

  Rpc.make("Command.List", { success: Schema.Array(CommandInfo) }),
  /**
   * Returns when the command ends; its questions arrive as `interaction` events
   * carrying `origin`, when given. `cwd` defaults to the host's.
   */
  Rpc.make("Command.Run", {
    payload: { id: Schema.String, cwd: Schema.optional(Schema.String), sessionId: Schema.optional(Schema.String), origin: Schema.optional(Schema.String) },
    success: CommandResult,
    error: HostError,
  }),

  Rpc.make("Host.Info", { success: HostInfo }),
  Rpc.make("Host.Events", { success: HostEvent, stream: true }),
  /** Every known plugin, enabled or not. */
  Rpc.make("Host.Plugins", { success: Schema.Array(PluginStatus) }),
  /** What host plugins let you look into (see `Inspectors`). */
  Rpc.make("Host.Inspectors", { success: Schema.Array(InspectorInfo) }),
  /** One inspector's snapshot: plain JSON. */
  Rpc.make("Host.Inspect", { payload: { id: Schema.String }, success: Schema.Unknown, error: HostError }),
  /** A failed or halted plugin and its dependents; `force` also replaces a running one. */
  Rpc.make("Host.RestartPlugin", { payload: { pluginId: Schema.String, force: Schema.optional(Schema.Boolean) }, error: HostError }),
  /** Re-read config files and apply the composition; diagnostics come back as the error message. */
  Rpc.make("Host.Reload", { success: ReloadResult, error: HostError }),
  /** Write plugin rows (`enabled`, `config`, `values`) into the user or project config file and apply; a rejected change is undone. */
  Rpc.make("Host.Configure", {
    payload: { plugins: Schema.Record(Schema.String, PluginChange), scope: Schema.optional(ConfigScope) },
    success: ReloadResult,
    error: HostError,
  }),

  /** The web app's `ui` rows and UI files; it plans and runs that composition itself. */
  Rpc.make("Ui.Composition", { success: UiComposition }),
  /** Write `ui` rows into the user or project config file; clients apply them on `ui-changed`. */
  Rpc.make("Ui.Configure", {
    payload: { plugins: Schema.Record(Schema.String, PluginChange), scope: Schema.optional(ConfigScope) },
    success: UiComposition,
    error: HostError,
  }),
) {}
