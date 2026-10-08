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
 * A question for the human, as `InteractionHook` carries it: `id` is fresh for
 * each question, and `origin` is the asking fiber's `InteractionOrigin`.
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

/**
 * How a question reaches the human: UI and transport plugins answer by
 * handling it, and a handler with nobody to ask passes it on. The terminal,
 * reached when nobody answers, fails `Unavailable`. Interrupting the asking
 * fiber interrupts the handler chain, which withdraws the question (a login
 * callback that arrives first cancels a paste-the-code prompt; the transport
 * then tells clients to close it).
 */
export const InteractionHook = Hook.make<InteractionRequest, InteractionAnswer, InteractionError>("lemma/interaction.request");

/**
 * Questions for the human, provided by the host itself. Each runs
 * `InteractionHook` with a fresh id and the asking fiber's
 * `InteractionOrigin`; whichever client is attached answers by handling the
 * hook, so the service knows nothing about how a question is shown. Callers
 * see only `InteractionError`:
 *
 * - `Unavailable` when nobody answers, the hook or the core fails, or the
 *   answer breaks the protocol (it is not of the question's type, or a
 *   `select` answer is not one of the options offered), naming the question.
 *   An answerer that breaks the protocol is no usable answerer rather than a
 *   defect, so a login flow or a tool recovers as when nobody is attached.
 * - `Dismissed` when the human closes the question.
 *
 * The core closes hooks before it disposes plugins and the application's
 * services, so a plugin finalizer that asks gets `Unavailable`.
 */
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
