import { expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Context, Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect";
import { definePlugin, makeCore } from "../src/index.ts";
import { waitFor } from "./support.ts";

test("stuck task and plugin finalizers cannot hang the closing caller", () => {
  for (const mode of ["task", "plugin"]) {
    const output = execFileSync(process.execPath, [fileURLToPath(new URL("./fixtures/shutdown.ts", import.meta.url)), mode], {
      timeout: 2000,
      encoding: "utf8",
    });
    expect(JSON.parse(output)).toMatchObject({ exit: "Failure", state: "closing" });
  }
});

test("timed-out work retains resources until it finishes and cleanup runs exactly once", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      let disposed = 0;
      const plugin = definePlugin({
        id: "resource",
        layer: Layer.effectDiscard(
          Effect.addFinalizer(() =>
            Effect.sync(() => {
              disposed++;
            }),
          ),
        ),
      });
      const scope = yield* Scope.make();
      const core = yield* Scope.provide(makeCore([plugin], { shutdownTimeout: "20 millis" }), scope);
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const work = yield* Effect.forkDetach(
        core.run(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never), Effect.ensuring(Deferred.await(release)))),
      );
      yield* Deferred.await(entered);
      const result = yield* Effect.exit(Scope.close(scope, Exit.void));
      expect(Exit.isFailure(result)).toBe(true);
      expect((yield* core.inspect).shutdownFault?._tag).toBe("ShutdownTimeout");
      expect((yield* core.inspect).state).toBe("closing");
      expect(disposed).toBe(0);
      expect(Exit.isFailure(yield* Effect.exit(core.run(Effect.void)))).toBe(true);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.await(work);
      yield* waitFor(core.inspect, (snapshot) => snapshot.state === "closed");
      yield* Effect.exit(Scope.close(scope, Exit.void));
      expect(disposed).toBe(1);
    }),
  );
});

test("a dependent's disposal deadline retains its provider until actual cleanup finishes", async () => {
  class Resource extends Context.Service<Resource, string>()("shutdown/Resource") {}
  await Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const release = yield* Deferred.make<void>();
      const disposed: string[] = [];
      const provider = definePlugin({
        id: "provider",
        provides: [Resource],
        layer: Layer.effect(
          Resource,
          Effect.acquireRelease(Effect.succeed("resource"), () =>
            Effect.sync(() => {
              disposed.push("provider");
            }),
          ),
        ),
      });
      const dependent = definePlugin({
        id: "dependent",
        requires: [Resource],
        layer: Layer.effectDiscard(
          Effect.gen(function* () {
            yield* Resource;
            yield* Effect.addFinalizer(() =>
              Deferred.await(release).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    disposed.push("dependent");
                  }),
                ),
              ),
            );
          }),
        ),
      });
      const core = yield* Scope.provide(makeCore([provider, dependent], { deadlines: { dispose: "20 millis" }, shutdownTimeout: "1 second" }), scope);
      expect(Exit.isFailure(yield* Effect.exit(Scope.close(scope, Exit.void)))).toBe(true);
      expect((yield* core.inspect).plugins.find((p) => p.id === "dependent")?.fault).toMatchObject({ phase: "dispose", deadline: true });
      expect((yield* core.inspect).state).toBe("closing");
      expect(disposed).toEqual([]);
      yield* Deferred.succeed(release, undefined);
      yield* waitFor(core.inspect, (snapshot) => snapshot.state === "closed");
      expect(disposed).toEqual(["dependent", "provider"]);
    }),
  );
});
