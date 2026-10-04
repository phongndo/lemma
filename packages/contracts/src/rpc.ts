import { Rpc, RpcGroup } from "@effect/rpc";
import { Schema } from "effect";
import { AgentView, PromptContent, QueuedPrompt, TurnOptions, WhenBusy } from "./agent.ts";
import { CommandInfo, CommandResult } from "./commands.ts";
import { ConfigField, ConfigValues } from "./config.ts";
import { CompositionInfo, ConfigScope, FaultRecord, HookUse, NoticePayload, PluginChange, PluginSource, RegistryUse, UiComposition } from "./host.ts";
import { InspectorInfo } from "./inspectors.ts";
import { InteractionAnswer, InteractionRequest } from "./interaction.ts";
import { AuthType, CustomProviderSpec, ModelInfo, ProviderInfo, StreamEvent, Usage } from "./llm.ts";
import { SessionEvent, SessionInfo } from "./sessions.ts";
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
export const PluginStatus = Schema.Struct({
  id: Schema.String,
  version: Schema.optional(Schema.String),
  source: PluginSource,
  shadows: Schema.optional(Schema.Boolean),
  enabled: Schema.Boolean,
  scope: Schema.optional(ConfigScope),
  locked: Schema.optional(Schema.String),
  provides: Schema.Array(Schema.String),
  requires: Schema.Array(Schema.String),
  state: Schema.Literal("pending", "activating", "active", "draining", "closed", "failed", "disabled"),
  fault: Schema.optional(Schema.Struct({ phase: Schema.String, operation: Schema.optional(Schema.String), message: Schema.String })),
  /** The plugin whose failure or absence keeps this one from running. */
  haltedBy: Schema.optional(Schema.String),
  configFields: Schema.optional(Schema.Array(ConfigField)),
  config: Schema.optional(ConfigValues),
  configScope: Schema.optional(ConfigScope),
  hooks: Schema.optional(Schema.Array(HookUse)),
  observes: Schema.optional(Schema.Array(Schema.String)),
  contributes: Schema.optional(Schema.Array(RegistryUse)),
  faults: Schema.optional(Schema.Array(FaultRecord)),
});
export type PluginStatus = typeof PluginStatus.Type;

/** What a reload or configure changed, as clients report it. */
export const ReloadResult = Schema.Struct({
  started: Schema.Array(Schema.String),
  restarted: Schema.Array(Schema.String),
  stopped: Schema.Array(Schema.String),
  /** Applied after the reply, because it restarts the transport; see `ConfigureReport`. */
  deferred: Schema.optional(Schema.Boolean),
});
export type ReloadResult = typeof ReloadResult.Type;

/** Everything a client reacts to, multiplexed on one subscription. Losable: clients repair gaps from `Session.Events`. */
export const HostEvent = Schema.Union(
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
    reason: Schema.Literal("done", "cancelled", "error", "max-steps"),
  }),
  Schema.Struct({ type: Schema.Literal("interaction"), request: InteractionRequest }),
  Schema.Struct({ type: Schema.Literal("interaction-closed"), id: Schema.String }),
  Schema.Struct({ type: Schema.Literal("notice"), notice: NoticePayload }),
  Schema.Struct({ type: Schema.Literal("plugins-changed"), plugins: Schema.Array(PluginStatus) }),
  Schema.Struct({ type: Schema.Literal("commands-changed"), commands: Schema.Array(CommandInfo) }),
  Schema.Struct({ type: Schema.Literal("ui-changed"), ui: UiComposition }),
);
export type HostEvent = typeof HostEvent.Type;

export const HostInfo = Schema.Struct({
  version: Schema.String,
  cwd: Schema.String,
  home: Schema.String,
  composition: CompositionInfo,
});
export type HostInfo = typeof HostInfo.Type;

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
    payload: { plugins: Schema.Record({ key: Schema.String, value: PluginChange }), scope: Schema.optional(ConfigScope) },
    success: ReloadResult,
    error: HostError,
  }),

  /** The web app's `ui` rows and UI files; it plans and runs that composition itself. */
  Rpc.make("Ui.Composition", { success: UiComposition }),
  /** Write `ui` rows into the user or project config file; clients apply them on `ui-changed`. */
  Rpc.make("Ui.Configure", {
    payload: { plugins: Schema.Record({ key: Schema.String, value: PluginChange }), scope: Schema.optional(ConfigScope) },
    success: UiComposition,
    error: HostError,
  }),
) {}
