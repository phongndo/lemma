import { Deferred, Duration, Effect } from "effect";
import { HostError, InteractionError } from "@lemma/contracts";
import type { InteractionAnswer, InteractionRequest } from "@lemma/contracts";
import type { Handler } from "@lemma/core";
import type { Hub } from "./hub.ts";

interface Pending {
  readonly request: InteractionRequest;
  readonly answer: Deferred.Deferred<InteractionAnswer, InteractionError>;
}

/**
 * Answers `InteractionHook` on behalf of connected clients that answer
 * questions (`Host.Events`' `answers`). A request is broadcast to every
 * subscriber, watchers included (and replayed to clients that subscribe while
 * it is open); the first answer wins and every client then receives
 * `interaction-closed`. With no answering client attached the request passes
 * to the next handler. If every answering client stays away for `graceMs` the
 * request fails `Unavailable`, so a page reload does not abort a login.
 */
export interface Interactions {
  readonly handle: Handler<InteractionRequest, InteractionAnswer, InteractionError>;
  readonly answer: (id: string, answer: InteractionAnswer) => Effect.Effect<void, HostError>;
  readonly dismiss: (id: string) => Effect.Effect<void, HostError>;
  readonly open: () => Iterable<InteractionRequest>;
}

export const makeInteractions = (hub: () => Hub, graceMs: number): Interactions => {
  const pending = new Map<string, Pending>();

  const lookup = (id: string): Effect.Effect<Pending, HostError> =>
    Effect.suspend(() => {
      const found = pending.get(id);
      return found === undefined
        ? Effect.fail(new HostError({ code: "NotFound", message: `No open interaction "${id}"; it was answered, dismissed, or withdrawn`, subject: id }))
        : Effect.succeed(found);
    });

  const abandoned: Effect.Effect<never, InteractionError> = Effect.gen(function* () {
    while (true) {
      yield* hub().drained;
      yield* Effect.sleep(Duration.millis(graceMs));
      if ((yield* hub().count) === 0) {
        return yield* new InteractionError({ reason: "Unavailable", message: "Every client disconnected before answering" });
      }
    }
  });

  const mismatch = (request: InteractionRequest, answer: InteractionAnswer): string | undefined => {
    if (answer.type !== request.type) return `Interaction "${request.id}" is a ${request.type} question; got a ${answer.type} answer`;
    if (request.type === "select" && !request.options.some((option) => option.value === answer.value)) {
      return `"${answer.value}" is not one of the options of interaction "${request.id}"`;
    }
    return undefined;
  };

  return {
    open: () => Array.from(pending.values(), (entry) => entry.request),
    handle: (request, next) =>
      Effect.gen(function* () {
        if ((yield* hub().count) === 0) return yield* next(request);
        const entry: Pending = { request, answer: yield* Deferred.make<InteractionAnswer, InteractionError>() };
        pending.set(request.id, entry);
        yield* hub().broadcast({ type: "interaction", request });
        return yield* Deferred.await(entry.answer).pipe(
          Effect.raceFirst(abandoned),
          // Answered, dismissed, abandoned, or withdrawn by interrupting the asker: every client drops the dialog.
          Effect.ensuring(
            Effect.suspend(() => {
              pending.delete(request.id);
              return hub().broadcast({ type: "interaction-closed", id: request.id });
            }),
          ),
        );
      }),
    answer: (id, answer) =>
      Effect.gen(function* () {
        const entry = yield* lookup(id);
        const problem = mismatch(entry.request, answer);
        if (problem !== undefined) return yield* new HostError({ code: "Mismatch", message: problem, subject: id });
        pending.delete(id);
        yield* Deferred.succeed(entry.answer, answer);
      }),
    dismiss: (id) =>
      Effect.gen(function* () {
        const entry = yield* lookup(id);
        pending.delete(id);
        yield* Deferred.fail(entry.answer, new InteractionError({ reason: "Dismissed", message: `"${entry.request.title}" was dismissed` }));
      }),
  };
};
