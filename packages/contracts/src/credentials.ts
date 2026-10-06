import { Context, Data, Schema } from "effect";
import type { Effect } from "effect";
import type { Awaitable } from "@lemma/core";

/**
 * One credential per provider id, stored in `auth.json` (mode 0600). The shape
 * matches pi-ai's `Credential`, so provider auth flows store it unchanged.
 */
export const ApiKeyCredential = Schema.Struct({
  type: Schema.Literal("api_key"),
  key: Schema.optional(Schema.String),
  /** Provider-scoped settings such as account or gateway ids. */
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

/** OAuth providers add their own fields (account ids, per-account base URLs); they are preserved. */
export const OAuthCredential = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.Literal("oauth"),
    access: Schema.String,
    refresh: Schema.String,
    /** Epoch milliseconds. */
    expires: Schema.Number,
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

export const Credential = Schema.Union([ApiKeyCredential, OAuthCredential]);
export type Credential = typeof Credential.Type;

export class CredentialError extends Data.TaggedError("CredentialError")<{
  readonly provider?: string;
  readonly reason: "Io" | "Corrupt" | "Locked";
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Credential storage. `modify` is the only write path: it runs `update` with the
 * current value under a lock (in-process and across processes), so a token
 * refresh and a concurrent login cannot overwrite each other. Returning
 * `undefined` leaves the entry unchanged.
 */
export class Credentials extends Context.Service<
  Credentials,
  {
    readonly read: (provider: string) => Effect.Effect<Credential | undefined, CredentialError>;
    /** Provider ids and credential types; never secrets. */
    readonly list: Effect.Effect<readonly { readonly provider: string; readonly type: Credential["type"] }[], CredentialError>;
    readonly modify: <E>(
      provider: string,
      /** Returns the new entry (or `undefined` to leave it), a promise of it, or an Effect (`Awaitable`). */
      update: (current: Credential | undefined) => Awaitable<Credential | undefined, E>,
    ) => Effect.Effect<Credential | undefined, CredentialError | E>;
    readonly remove: (provider: string) => Effect.Effect<void, CredentialError>;
  }
>()("lemma/Credentials") {}
