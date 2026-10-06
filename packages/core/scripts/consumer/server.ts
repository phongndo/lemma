import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Context, Deferred, Effect, Fiber, Layer, Schema } from "effect";
import { definePlugin, makeLoader, PluginContext } from "@lemma/core";
import type { Plugin } from "@lemma/core";
import { finish, record } from "./budgets.js";

class Greeting extends Context.Tag("http/Greeting")<Greeting, string>() {}
let dispatch: (path: string) => Promise<string>;
let address = "";
let listenerClosed = false;

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let crash!: Deferred.Deferred<void>;
      const provider = definePlugin({
        id: "greeting",
        provides: [Greeting],
        config: Schema.Struct({ value: Schema.String }),
        layer: ({ value }) =>
          Layer.scoped(
            Greeting,
            Effect.gen(function* () {
              const owner = yield* PluginContext;
              crash = yield* Deferred.make<void>();
              yield* owner.background("connection", Deferred.await(crash).pipe(Effect.zipRight(Effect.fail("connection lost"))), { required: true });
              return value;
            }),
          ),
      });
      const http = definePlugin({
        id: "http",
        layer: Layer.scopedDiscard(
          Effect.acquireRelease(
            Effect.promise(
              () =>
                new Promise<ReturnType<typeof createServer>>((resolve, reject) => {
                  const server = createServer((request, response) => {
                    void dispatch(request.url ?? "/").then(
                      (value) => response.end(value),
                      () => {
                        response.statusCode = 503;
                        response.end("unavailable");
                      },
                    );
                  });
                  server.once("error", reject);
                  server.listen(0, "127.0.0.1", () => {
                    const bound = server.address();
                    assert.ok(bound && typeof bound !== "string");
                    address = `http://127.0.0.1:${bound.port}`;
                    resolve(server);
                  });
                }),
            ),
            (server) =>
              Effect.promise(
                () =>
                  new Promise<void>((resolve, reject) => {
                    server.close((error) => {
                      listenerClosed = true;
                      if (error) reject(error);
                      else resolve();
                    });
                    server.closeIdleConnections();
                  }),
              ),
          ),
        ),
      });
      const definitions: Record<string, Plugin> = { greeting: provider, http };
      const composition = (value: string) => ({ plugins: { greeting: { config: { value } }, http: {} } });
      const loader = yield* makeLoader({ source: { resolve: (id) => Effect.succeed(definitions[id]!) }, composition: composition("old") });
      dispatch = (path) =>
        Effect.runPromise(
          loader.core.run(
            Effect.gen(function* () {
              const greeting = yield* Greeting;
              if (path === "/hold") {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
              }
              return greeting;
            }),
          ),
        );
      const request = (path = "/") =>
        Effect.promise(async () => {
          const response = await fetch(address + path);
          return { status: response.status, body: await response.text() };
        });
      const held = yield* Effect.fork(request("/hold"));
      yield* Deferred.await(entered);
      const reload = yield* Effect.fork(loader.apply(composition("new")));
      // Probe new requests while the previous request keeps its old capability.
      yield* request().pipe(Effect.repeat({ until: (result) => result.body === "new" }), Effect.timeout("2 seconds"));
      yield* Deferred.succeed(release, undefined);
      const old = yield* Fiber.join(held);
      assert.deepEqual(old, { status: 200, body: "old" });
      yield* Fiber.join(reload);
      yield* Deferred.succeed(crash, undefined);
      yield* loader.core.inspect.pipe(
        Effect.repeat({ until: (snapshot) => snapshot.plugins.find((p) => p.id === "greeting")?.state === "failed" }),
        Effect.timeout("2 seconds"),
      );
      assert.equal((yield* request()).status, 503);
      yield* loader.core.restart("greeting");
      assert.deepEqual(yield* request(), { status: 200, body: "new" });
      // Serial loopback requests: five warmups, then 100 individual latency samples.
      // This measures the consumer end to end, separately from batch microbenchmarks.
      const latencies: number[] = [];
      for (let n = 0; n < 105; n++) {
        const started = performance.now();
        assert.equal((yield* request()).status, 200);
        if (n >= 5) latencies.push(performance.now() - started);
      }
      latencies.sort((a, b) => a - b);
      record("httpP99Ms", latencies[98]!);
      record("httpRequestsPerSecond", 100_000 / latencies.reduce((sum, value) => sum + value, 0));
    }),
  ),
);
assert.equal(listenerClosed, true);
await assert.rejects(fetch(address));
console.log("HTTP consumer: in-flight replacement, failure, recovery, and listener cleanup passed.");
finish("http");
