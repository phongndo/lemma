import { Context, Data, Schema } from "effect";
import type { Effect } from "effect";
import { Hook } from "@lemma/core";

/**
 * Who is asking, so a client answers only the questions it caused: `session:<id>`
 * inside a turn, `login:<provider>` during a login, or the `origin` a client
 * passed with `Command.Run`. `Interaction` copies it onto each request.
 */
export const InteractionOrigin: Context.Reference<string | undefined> = Context.Reference<string | undefined>("lemma/InteractionOrigin", {
  defaultValue: () => undefined,
});

/**
 * Questions for the human, answered by whichever client is attached. The
 * plugin providing `Interaction` runs `InteractionHook`; UI and transport
 * plugins answer by handling it. Interrupting the asking fiber withdraws the
 * question (a login callback that arrives first cancels a paste-the-code prompt).
 */
export const InteractionRequest = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("confirm"),
    id: Schema.String,
    origin: Schema.optional(Schema.String),
    title: Schema.String,
    detail: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("ask"),
    id: Schema.String,
    origin: Schema.optional(Schema.String),
    title: Schema.String,
    placeholder: Schema.optional(Schema.String),
    secret: Schema.optional(Schema.Boolean),
    /**
     * `sign-in-code`: the code or address a sign-in page ends on, pasted when
     * the browser cannot reach the host's callback (on another machine). It
     * races that callback, which withdraws it.
     */
    kind: Schema.optional(Schema.Literal("sign-in-code")),
  }),
  Schema.Struct({
    type: Schema.Literal("select"),
    id: Schema.String,
    origin: Schema.optional(Schema.String),
    title: Schema.String,
    /** What the choice is about, shown with the title (a command to approve, say). */
    detail: Schema.optional(Schema.String),
    options: Schema.Array(Schema.Struct({ value: Schema.String, label: Schema.String, description: Schema.optional(Schema.String) })),
  }),
]);
export type InteractionRequest = typeof InteractionRequest.Type;

export const InteractionAnswer = Schema.Union([
  Schema.Struct({ type: Schema.Literal("confirm"), value: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal("ask"), value: Schema.String }),
  Schema.Struct({ type: Schema.Literal("select"), value: Schema.String }),
]);
export type InteractionAnswer = typeof InteractionAnswer.Type;

export class InteractionError extends Data.TaggedError("InteractionError")<{
  readonly reason: "Unavailable" | "Dismissed";
  readonly message: string;
}> {}

export const InteractionHook = Hook.make<InteractionRequest, InteractionAnswer, InteractionError>("lemma/interaction.request");

export class Interaction extends Context.Service<
  Interaction,
  {
    readonly confirm: (title: string, detail?: string) => Effect.Effect<boolean, InteractionError>;
    readonly ask: (
      title: string,
      options?: { readonly placeholder?: string; readonly secret?: boolean; readonly kind?: "sign-in-code" },
    ) => Effect.Effect<string, InteractionError>;
    readonly select: <V extends string>(
      title: string,
      options: readonly { readonly value: V; readonly label: string; readonly description?: string }[],
      detail?: string,
    ) => Effect.Effect<V, InteractionError>;
  }
>()("lemma/Interaction") {}
