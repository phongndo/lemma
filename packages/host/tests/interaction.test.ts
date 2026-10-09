import { describe, expect, test } from "vitest";
import { Deferred, Effect, Exit, Fiber, Layer } from "effect";
import { Interaction, InteractionError, InteractionHook, InteractionOrigin } from "@lemma/contracts";
import type { InteractionAnswer, InteractionRequest } from "@lemma/contracts";
import { definePlugin, makeCore, PluginContext } from "@lemma/core";
import type { Plugin } from "@lemma/core";
import { interactionLayer } from "../src/interaction.ts";

/** A UI stand-in: answers every request with the scripted function, recording what it saw. */
function answerer(answer: (request: InteractionRequest) => Effect.Effect<InteractionAnswer, InteractionError>) {
  const seen: InteractionRequest[] = [];
  const plugin = definePlugin({
    id: "ui",
    layer: Layer.effectDiscard(
      Effect.flatMap(PluginContext, (owner) =>
        owner.on(InteractionHook, (request) => {
          seen.push(request);
          return answer(request);
        }),
      ),
    ),
  });
  return { plugin, seen };
}

const scripted = (request: InteractionRequest): Effect.Effect<InteractionAnswer> => {
  switch (request.type) {
    case "confirm":
      return Effect.succeed({ type: "confirm", value: true });
    case "ask":
      return Effect.succeed({ type: "ask", value: request.secret ? "sk-secret" : "plain" });
    case "select":
      return Effect.succeed({ type: "select", value: request.options[1]!.value });
  }
};

/** `Interaction` as the host provides it: the application's, over the core's hooks. */
const provide = { provides: [Interaction], layer: interactionLayer } as const;

const run = <A, E>(plugins: readonly Plugin[], body: Effect.Effect<A, E, Interaction>) =>
  Effect.runPromise(Effect.scoped(Effect.flatMap(makeCore(plugins, { provide }), (core) => core.run(body))));

describe("interaction", () => {
  test("routes each question through InteractionHook with a unique id and returns the typed answer", async () => {
    const ui = answerer(scripted);
    await run(
      [ui.plugin],
      Effect.gen(function* () {
        const ask = yield* Interaction;
        expect(yield* ask.confirm("Delete?", "Everything")).toBe(true);
        expect(yield* ask.ask("Key", { secret: true })).toBe("sk-secret");
        expect(yield* ask.ask("Name", { placeholder: "you" })).toBe("plain");
        const picked: "a" | "b" = yield* ask.select(
          "Model",
          [
            { value: "a", label: "A" },
            { value: "b", label: "B" },
          ],
          "For this session",
        );
        expect(picked).toBe("b");
      }),
    );
    expect(ui.seen.map((request) => request.type)).toEqual(["confirm", "ask", "ask", "select"]);
    expect(new Set(ui.seen.map((request) => request.id)).size).toBe(4);
    expect(ui.seen[0]).toEqual({ type: "confirm", id: ui.seen[0]!.id, title: "Delete?", detail: "Everything" });
    expect(ui.seen[1]).toMatchObject({ title: "Key", secret: true });
    expect(ui.seen[2]).toEqual({ type: "ask", id: ui.seen[2]!.id, title: "Name", placeholder: "you" });
    expect(ui.seen[3]).toMatchObject({ title: "Model", detail: "For this session" });
  });

  test("marks each question with the asking fiber's origin", async () => {
    const ui = answerer(scripted);
    await run(
      [ui.plugin],
      Effect.gen(function* () {
        const ask = yield* Interaction;
        yield* ask.confirm("Unattributed?");
        yield* Effect.provideService(ask.confirm("From the turn?"), InteractionOrigin, "session:s1");
      }),
    );
    expect(ui.seen[0]).not.toHaveProperty("origin");
    expect(ui.seen[1]).toMatchObject({ title: "From the turn?", origin: "session:s1" });
  });

  test("fails Unavailable with no answerer", async () => {
    const error = await run([], Effect.flatMap(Interaction, (ask) => ask.confirm("Continue?")).pipe(Effect.flip));
    expect(error).toMatchObject({ _tag: "InteractionError", reason: "Unavailable" });
    expect(error.message).toContain("Continue?");
  });

  test("a plugin asking while it activates hears Unavailable from nobody, rather than waiting on its own start", async () => {
    const answers: string[] = [];
    const asking = definePlugin({
      id: "asking",
      requires: { ask: Interaction },
      setup: function* ({ ask }) {
        answers.push(yield* ask.confirm("Set up?").pipe(Effect.match({ onFailure: (error) => error.reason, onSuccess: () => "answered" })));
      },
    });
    await run([asking], Effect.void);
    expect(answers).toEqual(["Unavailable"]);
  });

  test("passes an answerer's Dismissed through", async () => {
    const ui = answerer(() => Effect.fail(new InteractionError({ reason: "Dismissed", message: "closed" })));
    const error = await run([ui.plugin], Effect.flatMap(Interaction, (ask) => ask.ask("Name?")).pipe(Effect.flip));
    expect(error).toMatchObject({ reason: "Dismissed" });
  });

  test("rejects an answer of the wrong type or an option that was not offered", async () => {
    const wrongType = answerer(() => Effect.succeed({ type: "ask", value: "yes" }));
    const mismatch = await run([wrongType.plugin], Effect.flatMap(Interaction, (ask) => ask.confirm("Sure?")).pipe(Effect.flip));
    expect(mismatch).toMatchObject({ reason: "Unavailable" });
    expect(mismatch.message).toContain("confirm");

    const unknownOption = answerer(() => Effect.succeed({ type: "select", value: "z" }));
    const rejected = await run(
      [unknownOption.plugin],
      Effect.flatMap(Interaction, (ask) => ask.select("Pick", [{ value: "a", label: "A" }])).pipe(Effect.flip),
    );
    expect(rejected).toMatchObject({ reason: "Unavailable" });
    expect(rejected.message).toContain('"z"');
  });

  test("interrupting the asker interrupts the answerer", async () => {
    const withdrawn = Effect.runSync(Deferred.make<void>());
    const asked = Effect.runSync(Deferred.make<void>());
    const ui = answerer(() =>
      Deferred.succeed(asked, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Deferred.succeed(withdrawn, undefined)),
      ),
    );
    await run(
      [ui.plugin],
      Effect.gen(function* () {
        const ask = yield* Interaction;
        const fiber = yield* Effect.forkChild(ask.ask("Paste the code"));
        yield* Deferred.await(asked);
        yield* Fiber.interrupt(fiber);
        expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true);
        yield* Deferred.await(withdrawn);
      }),
    );
  });
});
