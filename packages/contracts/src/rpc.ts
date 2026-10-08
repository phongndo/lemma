import { Rpc, RpcGroup } from "effect/rpc";
import { Schema } from "effect";
import { ChannelInfo } from "./channels.ts";
import { ConfigScope, NoticePayload, PluginChange, UiComposition } from "./host.ts";
import { InspectorInfo } from "./inspectors.ts";
import { InteractionAnswer, InteractionRequest } from "./interaction.ts";
import { HostError, HostInfo, PluginStatus, ReloadResult } from "./status.ts";

/**
 * What the runtime tells its clients on `Host.Events`: its notices, the
 * questions it asks for plugins, and what changed of the plugins, the channels
 * they serve, and the web app's composition. A subsystem streams its own
 * changes on a channel of its own (`agent.activity`, `sessions.changes`).
 * Losable but for the questions: a slow client loses the oldest of the rest.
 */
export const RuntimeEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("notice"), notice: NoticePayload }),
  /** A question for whoever answers it first (`Interaction.Answer`); never dropped. */
  Schema.Struct({ type: Schema.Literal("interaction"), request: InteractionRequest }),
  /** Answered, dismissed, or withdrawn: every client drops it. */
  Schema.Struct({ type: Schema.Literal("interaction-closed"), id: Schema.String }),
  Schema.Struct({ type: Schema.Literal("plugins-changed"), plugins: Schema.Array(PluginStatus) }),
  /**
   * The channels that answer changed: one came or went, or another contribution
   * took over an id (a reload, an override). A client whose stream ended
   * `Withdrawn`, or whose open found nothing, opens it again when its id is listed.
   */
  Schema.Struct({ type: Schema.Literal("channels-changed"), channels: Schema.Array(ChannelInfo) }),
  Schema.Struct({ type: Schema.Literal("ui-changed"), ui: UiComposition }),
]);
export type RuntimeEvent = typeof RuntimeEvent.Type;

/**
 * The runtime's remote surface, served by the transport and used by every
 * client: the host's own calls, its events, the questions it asks, the web
 * app's composition, and the channels host plugins serve (`Channel.*`),
 * through which every subsystem is reached. Errors reach clients as
 * `HostError`.
 *
 * While the host starts, the requests that answer from what plugins
 * contribute (`Channel.*`, `Host.Inspectors`, `Host.Inspect`) wait until its
 * plugins are up, so a client that has just found the host reaches what they
 * serve; one still waiting at the transport's startup timeout fails
 * `Unavailable`, whose `subject` is what the request names, if anything.
 */
export class RuntimeRpcs extends RpcGroup.make(
  Rpc.make("Host.Info", { success: HostInfo }),
  /**
   * The runtime's events from now on: `{ type: "subscribed" }` first, once
   * the subscriber has joined, then each `RuntimeEvent`, starting with the
   * questions still open. A client that must see the effects of its own next
   * call (a question a command asks) waits for `subscribed`: a call's reply is
   * no such sign, since the host handles a connection's calls concurrently.
   */
  Rpc.make("Host.Events", { success: Schema.Union([Schema.Struct({ type: Schema.Literal("subscribed") }), RuntimeEvent]), stream: true }),
  /** Every known plugin, enabled or not. */
  Rpc.make("Host.Plugins", { success: Schema.Array(PluginStatus) }),
  /** What host plugins let you look into (see `Inspectors`); waits while the host starts. */
  Rpc.make("Host.Inspectors", { success: Schema.Array(InspectorInfo), error: HostError }),
  /**
   * One inspector's snapshot: plain JSON, `null` for none. Waits while the
   * host starts. Fails `NotFound`, `Unavailable` (still starting, naming the
   * inspector), or `Failed` when the inspector fails or dies, or its snapshot
   * is not JSON.
   */
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

  /** Questions still waiting on an answer, so a client can show them without resubscribing. */
  Rpc.make("Interaction.List", { success: Schema.Array(InteractionRequest) }),
  Rpc.make("Interaction.Answer", { payload: { id: Schema.String, answer: InteractionAnswer }, error: HostError }),
  Rpc.make("Interaction.Dismiss", { payload: { id: Schema.String }, error: HostError }),

  /**
   * What host plugins serve (`Channels`): the channel that answers for each
   * id. A client reaches one by id with its payload and results as JSON;
   * `@lemma/client` encodes and decodes them with a declaration's schemas.
   * Waits while the host starts.
   */
  Rpc.make("Channel.List", { success: Schema.Array(ChannelInfo), error: HostError }),
  /**
   * Calls a channel. `payload` is its payload schema's JSON form (absent is
   * `null`, what `Schema.Void` takes), and the result is its success schema's
   * JSON form. The call that answers for the id when the request arrives
   * serves it; one in flight when its plugin stops or is replaced finishes on
   * that instance before the instance's finalizers run. Fails with a
   * `HostError` whose `subject` is the channel, unless the handler's domain
   * error names its own (a session, a path): `NotFound` (no call answers for
   * the id, as when its plugin has gone), `InvalidPayload`, the handler's
   * domain error's code (its `reason` or tag), `Failed` (any other failure, a
   * defect, or a result its success schema cannot send), `Withdrawn` (its
   * plugin left while it waited on that plugin, see `CallLifetime`, or it was
   * still running at the plugin's dispose deadline and was interrupted: call
   * again to reach the replacement), or `Unavailable` (the host still
   * starting at the transport's startup timeout, as above; a handler's domain
   * error may be `Unavailable` too).
   */
  Rpc.make("Channel.Call", { payload: { id: Schema.String, payload: Schema.optional(Schema.Unknown) }, success: Schema.Unknown, error: HostError }),
  /**
   * Opens a channel stream: its elements, encoded as for `Channel.Call`, until
   * it ends. Fails as `Channel.Call` does, except that it ends `Withdrawn` as
   * soon as its plugin stops or is replaced, or another plugin's channel takes
   * over its id, whether or not the client is reading, and is stopped before
   * that plugin's finalizers run: open it again to reach whatever answers for
   * the id now. It ends with the connection and nothing resumes it, so a
   * client reopens it when it reconnects and receives what the channel sends
   * from then on.
   */
  Rpc.make("Channel.Open", {
    payload: { id: Schema.String, payload: Schema.optional(Schema.Unknown) },
    success: Schema.Unknown,
    error: HostError,
    stream: true,
  }),
) {}
