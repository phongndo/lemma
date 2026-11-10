import { Deferred, Effect, Fiber } from "effect";
import { expect, test } from "vitest";
import { definePlugin, Hooks, makeCore } from "@lemma/core";
import { AgentInputHook } from "../../src/agent.ts";
import { makeInputDecisions } from "../../src/kit/input.ts";

test("keeps an in-flight input decision when completed answers fill its cache", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        let pendingCalls = 0;
        const plugin = definePlugin({
          id: "input",
          setup: function* (_, owner) {
            yield* owner.on(AgentInputHook, (input) =>
              Effect.gen(function* () {
                if (input.options.requestId === "pending") {
                  pendingCalls++;
                  yield* Deferred.succeed(started, undefined);
                  yield* Deferred.await(finish);
                }
                return { kind: "handle" as const, message: "handled" };
              }),
            );
          },
        });
        const core = yield* makeCore([plugin]);
        yield* core.run(
          Effect.gen(function* () {
            const decisions = makeInputDecisions(yield* Hooks);
            const content = [{ type: "text" as const, text: "hello" }];
            const first = yield* Effect.forkChild(decisions.decide("s", content, { requestId: "pending" }));
            yield* Deferred.await(started);
            for (let i = 0; i < 1024; i++) yield* decisions.decide("s", content, { requestId: `done-${i}` });
            const retry = yield* Effect.forkChild(decisions.decide("s", content, { requestId: "pending" }));
            yield* Deferred.succeed(finish, undefined);
            expect(yield* Fiber.join(retry)).toEqual(yield* Fiber.join(first));
            expect(pendingCalls).toBe(1);
          }),
        );
      }),
    ),
  ));
