import { Cause, Effect, Exit, Fiber, Option, Scope, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { Events, makeCore } from "@lemma/core";
import { Agent, QueueChanged } from "@lemma/agent";
import { Sessions } from "@lemma/sessions";
import { makeSessionsPlugin } from "@lemma/sessions-files";
import tools from "@lemma/tools-registry";
import { SimDisk, seededRandom } from "@lemma/testing";
import type { FileSystem } from "@lemma/contracts/fs";
import { MAX_QUEUED, makeAgentPlugin } from "../src/index.ts";
import { readJournals } from "../src/state.ts";
import { fakeLlm, hang, host, paths, testTools, text, waitFor } from "./fakes.ts";

/*
 * The agent's journal on a disk that loses power (SimDisk, whose crash keeps only what was synced: a rename, or a new
 * directory, survives only once its directory is synced). A prompt queued behind a running turn is accepted once the
 * queue has changed (`QueueChanged`): from then on a crash keeps it. A withdrawn one stays withdrawn. Each seed
 * crashes at once after the change, so every write the change made is as unsynced as it can be.
 */

const HOME = "/lemma";
const SEEDS = Number(process.env.SEEDS ?? 24);

/** A host on `fs`: the sessions store, the agent, and a model that plays `scripts`. */
const start = (fs: FileSystem, scripts: Parameters<typeof fakeLlm>[0]) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const llm = fakeLlm(scripts);
    const core = yield* makeCore(
      [paths(HOME, HOME), host(), makeSessionsPlugin({ fs }), tools, testTools().plugin, llm.plugin, makeAgentPlugin({ fs })],
      // A stopping agent cuts its turns off at once, as the crash would.
      { configs: { "agent.loop": { stopGrace: 0 } } },
    ).pipe(Scope.provide(scope));
    return { scope, core };
  });

/** Runs `effect` until `QueueChanged` shows the session's queue as `matches` says. */
const changingQueue = <A, E, R>(sessionId: string, matches: (requestIds: readonly string[]) => boolean, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const events = yield* Events;
    const heard = yield* Stream.runHead(
      events.stream(QueueChanged).pipe(Stream.filter((change) => change.sessionId === sessionId && matches(change.queue.map((prompt) => prompt.requestId)))),
    ).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    const fiber = yield* Effect.forkChild(effect);
    yield* Fiber.join(heard);
    return fiber;
  });

describe("the journal on a disk that loses power", () => {
  it("keeps a queued prompt once its queue change is heard, and a withdrawn one out", async () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const disk = new SimDisk(seededRandom(seed));
      const queued = await Effect.runPromise(
        Effect.gen(function* () {
          const first = yield* start(disk.mount(), [hang("thinking")]);
          const [sessionId, withdrawn] = yield* first.core.run(
            Effect.gen(function* () {
              const { id } = yield* (yield* Sessions).create();
              const agent = yield* Agent;
              yield* Effect.forkChild(agent.prompt(id, text("first"), { requestId: "a" }));
              yield* waitFor(agent.busy(id), (busy) => busy);
              yield* changingQueue(id, (queue) => queue.includes("b"), agent.prompt(id, text("second"), { requestId: "b" }));
              yield* changingQueue(id, (queue) => queue.includes("c"), agent.prompt(id, text("third"), { requestId: "c" }));
              return [id, yield* agent.withdraw(id, "c")] as const;
            }),
          );
          expect(withdrawn).toBe(true);
          // The power goes: the process is gone, and what it had not synced with it.
          disk.crash();
          yield* Scope.close(first.scope, Exit.void);
          const after = disk.mount();
          const journals = yield* readJournals({ home: HOME, fs: after });
          // The resumed turn asks the model again, which never answers: the queue waits behind it.
          const second = yield* start(after, [hang("thinking again")]);
          const queue = yield* second.core.run(Effect.flatMap(Agent, (agent) => agent.queue(sessionId)));
          yield* Scope.close(second.scope, Exit.void);
          return { journal: journals.get(sessionId), queue: queue.map((prompt) => prompt.requestId) };
        }),
      );
      expect(
        queued.journal?.turn?.prompts.map((prompt) => prompt.requestId),
        `seed ${seed}`,
      ).toEqual(["a"]);
      expect(
        queued.journal?.queue.map((prompt) => prompt.requestId),
        `seed ${seed}`,
      ).toEqual(["b"]);
      expect(queued.queue, `seed ${seed}`).toEqual(["b"]);
    }
  });
});

/** `fs` with the agent's state directory refusing writes while `failing.on` holds, as a full disk would. */
const failingState = (fs: FileSystem) => {
  const failing = { on: false };
  const refused = (path: string) => failing.on && path.startsWith(`${HOME}/agent`);
  const full = () => Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
  const wrapped: FileSystem = {
    ...fs,
    open: (path, flags, mode) => (refused(path) && flags !== "r" ? Promise.reject(full()) : fs.open(path, flags, mode)),
    rename: (from, to) => (refused(to) ? Promise.reject(full()) : fs.rename(from, to)),
    rm: (path, options) => (refused(path) ? Promise.reject(full()) : fs.rm(path, options)),
  };
  return { fs: wrapped, failing };
};

describe("a change the journal cannot record", () => {
  const run = <A, E>(body: (failing: { on: boolean }, sessionId: string) => Effect.Effect<A, E, Agent | Sessions | Events>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { fs, failing } = failingState(new SimDisk(seededRandom(1)).mount());
        const running = yield* start(fs, [hang("thinking")]);
        const result = yield* running.core.run(
          Effect.flatMap(
            Effect.flatMap(Sessions, (store) => store.create()),
            ({ id }) => body(failing, id),
          ),
        );
        yield* Scope.close(running.scope, Exit.void);
        return result;
      }),
    );

  it("is not made: a prompt that cannot start its turn or join the queue fails Io, and the queue is as it was", async () => {
    const seen = await run((failing, id) =>
      Effect.gen(function* () {
        const agent = yield* Agent;
        failing.on = true;
        const unstarted = yield* Effect.flip(agent.prompt(id, text("first"), { requestId: "a" }));
        const idle = !(yield* agent.busy(id));
        const logged = (yield* (yield* Sessions).events(id)).length;
        failing.on = false;
        yield* Effect.forkChild(agent.prompt(id, text("first"), { requestId: "a" }));
        yield* waitFor(agent.busy(id), (busy) => busy);
        failing.on = true;
        const unqueued = yield* Effect.flip(agent.prompt(id, text("second"), { requestId: "b" }));
        const queue = (yield* agent.queue(id)).map((prompt) => prompt.requestId);
        failing.on = false;
        // Retried with its id once the disk has room, it joins the queue.
        yield* changingQueue(id, (requestIds) => requestIds.includes("b"), agent.prompt(id, text("second"), { requestId: "b" }));
        return {
          unstarted: unstarted.reason,
          idle,
          logged,
          unqueued: unqueued.reason,
          queue,
          after: (yield* agent.queue(id)).map((prompt) => prompt.requestId),
        };
      }),
    );
    expect(seen).toEqual({ unstarted: "Io", idle: true, logged: 0, unqueued: "Io", queue: [], after: ["b"] });
  });

  it("is not made: a withdrawal fails Io, and the prompt stays queued", async () => {
    const seen = await run((failing, id) =>
      Effect.gen(function* () {
        const agent = yield* Agent;
        yield* Effect.forkChild(agent.prompt(id, text("first"), { requestId: "a" }));
        yield* waitFor(agent.busy(id), (busy) => busy);
        yield* changingQueue(id, (requestIds) => requestIds.includes("b"), agent.prompt(id, text("second"), { requestId: "b" }));
        failing.on = true;
        const refused = yield* Effect.flip(agent.withdraw(id, "b"));
        failing.on = false;
        return { refused: refused.reason, queue: (yield* agent.queue(id)).map((prompt) => prompt.requestId), withdrawn: yield* agent.withdraw(id, "b") };
      }),
    );
    expect(seen).toEqual({ refused: "Io", queue: ["b"], withdrawn: true });
  });

  it("is not made: a promotion fails Io, and the prompt stays a follow-up", async () => {
    const seen = await run((failing, id) =>
      Effect.gen(function* () {
        const agent = yield* Agent;
        yield* Effect.forkChild(agent.prompt(id, text("first"), { requestId: "a" }));
        yield* waitFor(agent.busy(id), (busy) => busy);
        yield* changingQueue(id, (requestIds) => requestIds.includes("b"), agent.prompt(id, text("second"), { requestId: "b" }));
        failing.on = true;
        const refused = yield* Effect.flip(agent.promote(id, "b"));
        failing.on = false;
        const modes = (yield* agent.queue(id)).map((prompt) => prompt.mode);
        return { refused: refused.reason, modes, promoted: yield* agent.promote(id, "b"), after: (yield* agent.queue(id)).map((prompt) => prompt.mode) };
      }),
    );
    expect(seen).toEqual({ refused: "Io", modes: ["follow-up"], promoted: true, after: ["steer"] });
  });
});

describe("a withdrawal whose caller gives up while it is written", () => {
  it("still takes the prompt out, and answers the prompt's caller", async () => {
    const seen = await Effect.runPromise(
      Effect.gen(function* () {
        const disk = new SimDisk(seededRandom(1)).mount();
        // The session's journal writes wait at the gate while it is shut: the withdrawal is mid-write when its caller goes.
        let shut: string | undefined;
        let reach!: () => void;
        let open!: () => void;
        const reached = new Promise<void>((resolve) => (reach = resolve));
        const opened = new Promise<void>((resolve) => (open = resolve));
        const fs: FileSystem = {
          ...disk,
          open: async (path, flags, mode) => {
            if (shut !== undefined && path.startsWith(`${HOME}/agent/${shut}.json`) && flags !== "r") {
              reach();
              await opened;
            }
            return disk.open(path, flags, mode);
          },
        };
        const running = yield* start(fs, [hang("thinking")]);
        const seen = yield* running.core.run(
          Effect.gen(function* () {
            const { id } = yield* (yield* Sessions).create();
            const agent = yield* Agent;
            yield* Effect.forkChild(agent.prompt(id, text("first"), { requestId: "a" }));
            yield* waitFor(agent.busy(id), (busy) => busy);
            const queued = yield* changingQueue(id, (requestIds) => requestIds.includes("b"), agent.prompt(id, text("second"), { requestId: "b" }));
            shut = id;
            const withdrawing = yield* Effect.forkChild(agent.withdraw(id, "b"));
            yield* Effect.promise(() => reached);
            // Its caller gives up while the journal is written (the interruption delivered while the write waits), then the
            // write goes on.
            const interrupting = yield* Effect.forkChild(Fiber.interrupt(withdrawing));
            for (let turn = 0; turn < 10; turn++) yield* Effect.yieldNow;
            open();
            yield* Fiber.join(interrupting);
            // Answered, not left waiting: a hang fails the test with a timeout.
            const answer = yield* Fiber.await(queued).pipe(Effect.timeout("2 seconds"));
            const failure = Exit.isFailure(answer) ? Option.getOrUndefined(Cause.findErrorOption(answer.cause)) : undefined;
            return {
              answer: Exit.isSuccess(answer) ? "placed" : (failure?.reason ?? "died"),
              queue: (yield* agent.queue(id)).map((prompt) => prompt.requestId),
            };
          }),
        );
        yield* Scope.close(running.scope, Exit.void);
        return seen;
      }),
    );
    expect(seen).toEqual({ answer: "Retracted", queue: [] });
  });
});

describe("a session's queue", () => {
  it(`holds ${MAX_QUEUED} prompts: one more fails Busy`, async () => {
    const reason = await Effect.runPromise(
      Effect.gen(function* () {
        const running = yield* start(new SimDisk(seededRandom(1)).mount(), [hang("thinking")]);
        const reason = yield* running.core.run(
          Effect.gen(function* () {
            const { id } = yield* (yield* Sessions).create();
            const agent = yield* Agent;
            yield* Effect.forkChild(agent.prompt(id, text("first")));
            yield* waitFor(agent.busy(id), (busy) => busy);
            for (let n = 0; n < MAX_QUEUED; n++) yield* Effect.forkChild(agent.prompt(id, text(`queued ${n}`), { requestId: `q${n}` }));
            yield* waitFor(agent.queue(id), (queue) => queue.length === MAX_QUEUED);
            return (yield* Effect.flip(agent.prompt(id, text("one more")))).reason;
          }),
        );
        yield* Scope.close(running.scope, Exit.void);
        return reason;
      }),
    );
    expect(reason).toBe("Busy");
  });
});
