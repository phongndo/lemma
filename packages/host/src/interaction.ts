import { randomUUID } from "node:crypto";
import { Effect, Layer } from "effect";
import type { Context } from "effect";
import { Interaction, InteractionError, InteractionHook, InteractionOrigin } from "@lemma/contracts";
import type { InteractionAnswer, InteractionRequest } from "@lemma/contracts";
import { Hooks } from "@lemma/core";

type Answer<T extends InteractionRequest["type"]> = Extract<InteractionAnswer, { type: T }>["value"];

/**
 * `Interaction` over the core's hooks: every question becomes an
 * `InteractionHook` invocation with a fresh id and the asking fiber's
 * `InteractionOrigin`. Whichever UI or transport plugin is attached answers by
 * handling the hook; the terminal is reached only when nobody does, and fails
 * `Unavailable`.
 */
export function makeInteraction(hooks: Context.Service.Shape<typeof Hooks>): Context.Service.Shape<typeof Interaction> {
  const request = <T extends InteractionRequest["type"]>(request: Extract<InteractionRequest, { type: T }>): Effect.Effect<Answer<T>, InteractionError> =>
    InteractionOrigin.pipe(
      Effect.flatMap((origin) => hooks.invoke(InteractionHook, origin === undefined ? request : { ...request, origin }, unavailable)),
      // An answerer that breaks the protocol is no usable answerer: callers recover as if nobody were attached.
      Effect.flatMap((answer) =>
        answer.type === request.type
          ? Effect.succeed(answer.value as Answer<T>)
          : Effect.fail(
              new InteractionError({
                reason: "Unavailable",
                message: `"${request.title}" is a ${request.type} question but was answered as ${answer.type}`,
              }),
            ),
      ),
      Effect.catchTags({
        HookError: (error) => new InteractionError({ reason: "Unavailable", message: error.message }),
        CoreClosed: (error) => new InteractionError({ reason: "Unavailable", message: error.message }),
      }),
    );

  return {
    confirm: (title, detail) => request({ type: "confirm", id: randomUUID(), title, ...(detail === undefined ? {} : { detail }) }),
    ask: (title, options) =>
      request({
        type: "ask",
        id: randomUUID(),
        title,
        ...(options?.placeholder === undefined ? {} : { placeholder: options.placeholder }),
        ...(options?.secret === undefined ? {} : { secret: options.secret }),
        ...(options?.kind === undefined ? {} : { kind: options.kind }),
      }),
    select: <V extends string>(
      title: string,
      options: readonly { readonly value: V; readonly label: string; readonly description?: string }[],
      detail?: string,
    ) =>
      request({ type: "select", id: randomUUID(), title, ...(detail === undefined ? {} : { detail }), options }).pipe(
        Effect.filterOrFail(
          (value): value is V => options.some((option) => option.value === value),
          (value) => new InteractionError({ reason: "Unavailable", message: `Selected "${value}" is not one of the options offered for "${title}"` }),
        ),
      ),
  };
}

/** `Interaction` built from the core's `Hooks`, for the host's `provide`. */
export const interactionLayer: Layer.Layer<Interaction, never, Hooks> = Layer.effect(Interaction, Effect.map(Hooks, makeInteraction));

const unavailable = (request: InteractionRequest): Effect.Effect<never, InteractionError> =>
  Effect.fail(new InteractionError({ reason: "Unavailable", message: `No client is attached to answer "${request.title}"` }));
