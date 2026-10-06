import { Deferred, Effect, Exit, Layer, Scope } from "effect";
import { definePlugin, makeCore } from "../../src/index.ts";

// The parent enforces a process watchdog. Intentionally unfinished finalizers die
// with this fixture process after the public shutdown result has been checked.
await Effect.runPromise(
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const plugin = definePlugin({ id: "stuck", layer: Layer.effectDiscard(Effect.addFinalizer(() => Effect.never)) });
    const core = yield* Scope.provide(
      makeCore(process.argv[2] === "plugin" ? [plugin] : [], {
        shutdownTimeout: "40 millis",
        deadlines: { dispose: "20 millis" },
      }),
      scope,
    );
    if (process.argv[2] === "task") {
      const entered = yield* Deferred.make<void>();
      yield* Effect.forkDetach(core.run(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never), Effect.ensuring(Effect.never))));
      yield* Deferred.await(entered);
    }
    const exit = yield* Effect.exit(Effect.uninterruptible(Scope.close(scope, Exit.void)));
    console.log(JSON.stringify({ exit: exit._tag, state: (yield* core.inspect).state }));
  }),
);
process.exit(0);
