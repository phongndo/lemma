import { Context, Data, Schema } from "effect";
import type { Effect } from "effect";
import { Hook, schemaCheck } from "@lemma/core";
import { ConfigField } from "./config.ts";

/**
 * Who is asking, so a client answers only the questions it caused: `session:<id>`
 * inside a turn, or the `origin` a client passed to `commands.run` (a CLI
 * command's own). `Interaction` copies it onto each request.
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
  /**
   * Several values at once, as a plugin's settings are asked for: its `fields` are a settings form's
   * (`describeConfig` of the asker's Schema), so a client draws it as it draws one, and answers with the values by
   * field key (`{ type: "form", value }`), which the asker decodes with its Schema.
   */
  Schema.Struct({
    type: Schema.Literal("form"),
    id: Schema.String,
    origin: Schema.optional(Schema.String),
    title: Schema.String,
    detail: Schema.optional(Schema.String),
    fields: Schema.Array(ConfigField),
  }),
]);
export type InteractionRequest = typeof InteractionRequest.Type;

export const InteractionAnswer = Schema.Union([
  Schema.Struct({ type: Schema.Literal("confirm"), value: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal("ask"), value: Schema.String }),
  Schema.Struct({ type: Schema.Literal("select"), value: Schema.String }),
  Schema.Struct({ type: Schema.Literal("form"), value: Schema.Record(Schema.String, Schema.Unknown) }),
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
 *
 * @composition a chain: the first handler that can ask someone answers without `next`; one with nobody to ask passes
 * it on, and the terminal fails `Unavailable`. A handler that fails fails the question. Checked: what a handler hands
 * on is an `InteractionRequest`, what it returns an `InteractionAnswer`.
 */
export const InteractionHook = Hook.make<InteractionRequest, InteractionAnswer, InteractionError>("lemma/interaction.request", {
  check: { input: schemaCheck(InteractionRequest), output: schemaCheck(InteractionAnswer) },
});

/**
 * Questions for the human, provided by the host itself. Each runs
 * `InteractionHook` with a fresh id and the asking fiber's
 * `InteractionOrigin`; whichever client is attached answers by handling the
 * hook, so the service knows nothing about how a question is shown. Callers
 * see only `InteractionError`:
 *
 * - `Unavailable` when nobody answers, the hook or the core fails, or the
 *   answer breaks the protocol (it is not of the question's type, a
 *   `select` answer is not one of the options offered, or a `form` answer does
 *   not decode with its Schema), naming the question.
 *   An answerer that breaks the protocol is no usable answerer rather than a
 *   defect, so a login flow or a tool recovers as when nobody is attached.
 * - `Dismissed` when the human closes the question.
 *
 * When the core shuts down it closes hooks before it disposes plugins and the
 * application's services, so a finalizer that asks then gets `Unavailable`. A
 * plugin replaced by a reload can still ask from its finalizer.
 */
export class Interaction extends Context.Service<
  Interaction,
  {
    readonly confirm: (title: string, detail?: string) => Effect.Effect<boolean, InteractionError>;
    readonly ask: (title: string, options?: { readonly placeholder?: string; readonly secret?: boolean }) => Effect.Effect<string, InteractionError>;
    readonly select: <V extends string>(
      title: string,
      options: readonly { readonly value: V; readonly label: string; readonly description?: string }[],
      detail?: string,
    ) => Effect.Effect<V, InteractionError>;
    /**
     * Asks for the fields of `schema`, a struct, as a settings form shows them: each property a field, titled and
     * described by its annotations, defaults filled in. Only what a settings form edits can be answered (text,
     * numbers, booleans, a choice, a list of strings); give anything else a default.
     */
    readonly form: <A>(title: string, schema: Schema.Codec<A, any>, detail?: string) => Effect.Effect<A, InteractionError>;
  }
>()("lemma/Interaction") {}
