import { Schema } from "effect";

/** What a client says it is when it subscribes to the host's events (`Host.Events`): `cli`, `web`, `desktop`, or a name of its own. */
export const ClientHello = Schema.Struct({
  kind: Schema.String,
  version: Schema.optional(Schema.String),
});
export type ClientHello = typeof ClientHello.Type;

/** A client attached to the host now: one subscription to its events (a web app's tab, a desktop window, a CLI command that watches). */
export const ClientInfo = Schema.Struct({
  kind: Schema.String,
  version: Schema.optional(Schema.String),
  /** Epoch milliseconds. */
  since: Schema.Number,
  /** Whether it answers the host's questions. */
  answers: Schema.Boolean,
});
export type ClientInfo = typeof ClientInfo.Type;
