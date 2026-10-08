import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Duration, Effect, Queue } from "effect";
import type { Cause, Scope } from "effect";
import type { RpcClientError } from "effect/rpc";
import type { HostError } from "@lemma/contracts";
import { readDiscovery } from "@lemma/contracts/discovery";
import { pathsPlugin } from "@lemma/contracts/testing";
import { makeCore } from "@lemma/core";
import type { Core, Plugin } from "@lemma/core";
import commands from "../../commands/src/index.ts";
import transport from "../../transport/src/index.ts";
import { fakeAgent, fakeHostControl, fakeInteraction, fakeLlm, fakeSessions, fakeWorkspace } from "../../transport/tests/fakes.ts";
import type { ControlHolder } from "../../transport/tests/fakes.ts";
import { connect, makeHolder } from "../../transport/tests/harness.ts";
import type { Client } from "../../transport/tests/harness.ts";

export type { Client } from "../../transport/tests/harness.ts";
export { hostError } from "../../transport/tests/harness.ts";

/** What the transport requires besides what a test runs, by the id of the plugin that would provide it: its own tests' stand-ins. */
const standIns = (holder: ControlHolder): Record<string, readonly Plugin[]> => ({
  sessions: [fakeSessions],
  agent: [fakeAgent],
  llm: [fakeLlm, fakeInteraction],
  host: [fakeHostControl(holder)],
  workspace: [fakeWorkspace],
  commands: [commands],
});

/**
 * Runs `plugins` (given a fresh home) behind the transport, as a host does,
 * and hands `body` a client connected over a WebSocket: what it calls and
 * opens goes through the transport's channel serving, the way any client's
 * requests do. `Paths` is the home's unless `plugins` has a `paths` plugin.
 */
export const served = <A, E>(
  plugins: (home: string) => readonly Plugin[],
  body: (client: Client, core: Core<any>) => Effect.Effect<A, E, Scope.Scope>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const home = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "lemma-served-"))),
          (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
        );
        const own = plugins(home);
        const ids = new Set(own.map((plugin) => plugin.id));
        // The transport holds requests until the composition is up, which the host control says once it has the core.
        const holder = yield* makeHolder;
        const missing = Object.entries(standIns(holder)).flatMap(([id, standIn]) => (ids.has(id) ? [] : standIn));
        const core = yield* makeCore([transport, ...(ids.has("paths") ? [] : [pathsPlugin(home)]), ...own, ...missing], {
          configs: { transport: { port: 0 } },
        });
        yield* Deferred.succeed(holder.core, core);
        const found = yield* readDiscovery(home);
        if (found === undefined) return yield* Effect.die(new Error("the transport wrote no discovery file"));
        return yield* body(yield* connect(found.url, found.token, "websocket"), core);
      }).pipe(Effect.timeout(Duration.seconds(20))),
    ),
  );

/** A channel's answer, as JSON (`Channel.Call`). */
export const call = (client: Client, id: string, payload?: unknown) => client["Channel.Call"](payload === undefined ? { id } : { id, payload });

/** A channel stream opened (`Channel.Open`): its elements, as JSON, taken one at a time, or how it ended in their place. */
export const open = (client: Client, id: string, payload?: unknown) =>
  Effect.map(
    client["Channel.Open"](payload === undefined ? { id } : { id, payload }, { asQueue: true }),
    (elements: Queue.Dequeue<unknown, HostError | RpcClientError.RpcClientError | Cause.Done>) => ({
      next: Queue.take(elements).pipe(Effect.timeout(Duration.seconds(5)), Effect.orDie),
      end: Effect.exit(Queue.take(elements).pipe(Effect.timeout(Duration.seconds(5)))),
    }),
  );

/** Takes elements until those taken satisfy `enough`. */
export const collect = (stream: { readonly next: Effect.Effect<unknown> }, enough: (seen: readonly any[]) => boolean): Effect.Effect<any[]> => {
  const loop = (seen: unknown[]): Effect.Effect<unknown[]> =>
    enough(seen) ? Effect.succeed(seen) : Effect.flatMap(stream.next, (element) => loop([...seen, element]));
  return loop([]);
};
