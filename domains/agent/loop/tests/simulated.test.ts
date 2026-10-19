import * as fs from "node:fs/promises";
import { Cause, Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeCore } from "@lemma/core";
import { Agent } from "@lemma/agent";
import { nodeFileSystem } from "@lemma/contracts/fs";
import type { FileHandle, FileSystem } from "@lemma/contracts/fs";
import { makeSessionsPlugin } from "@lemma/sessions-files";
import tools from "@lemma/tools-registry";
import { Schema } from "effect";
import { ToolResult } from "@lemma/tools";
import type { Tool } from "@lemma/tools";
import { makeAgentPlugin } from "../src/index.ts";
import {
  call,
  failWith,
  fakeLlm,
  gated,
  hang,
  host,
  log,
  newSession,
  ofType,
  paths,
  reply,
  runAgent,
  tempDir,
  testTools,
  text,
  useTools,
  waitFor,
} from "./fakes.ts";
import type { AgentSetup } from "./fakes.ts";
import { Deferred } from "effect";

/*
 * What the harness simulation (`@lemma/sim`) found, each pinned by a test of its own: a seed replays a run only at the
 * commit that drew it, so a bug a seed found is kept found here.
 */

let dir: string;
beforeEach(async () => {
  dir = await tempDir();
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const run = <A, E>(setup: AgentSetup, body: Parameters<typeof runAgent<A, E>>[2]) =>
  runAgent(dir, { ...setup, config: { stopGrace: 0, ...setup.config } }, body);

const HOUR = 60 * 60 * 1000;

describe("the wall clock going back", () => {
  it("never makes a resumed turn wait for a retry longer than a retry could", async () => {
    // A rate limit asks for ten minutes, at ten hours past the epoch; the next host's clock reads the epoch.
    const id = await run({ testClock: true, scripts: [failWith("Rate limited", { kind: "rate-limit", retryAfterMs: 10 * 60 * 1000 })] }, () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(10 * HOUR);
        const { id } = yield* newSession;
        yield* Effect.forkChild((yield* Agent).prompt(id, text("go")));
        yield* TestClock.withLive(waitFor(log(id), (events) => ofType(events, "attempt").length > 0));
        return id;
      }),
    );
    await run({ testClock: true, scripts: [reply("done")] }, ({ requests }) =>
      Effect.gen(function* () {
        // Ten hours back, the logged retry time is ten hours and ten minutes away: the wait stops at fifteen minutes.
        yield* TestClock.withLive(waitFor(log(id), (events) => ofType(events, "custom").some((data) => data.kind === "agent.resumed")));
        yield* TestClock.adjust("16 minutes");
        yield* TestClock.withLive(waitFor(log(id), (events) => ofType(events, "turn-end").length > 0));
        expect(requests).toHaveLength(1);
      }),
    );
  });

  it("never takes a queue's revision back across a restart, though the journal is gone and the clock went back", async () => {
    const before = await run({ testClock: true, scripts: [reply("done")] }, () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(10 * HOUR);
        const { id } = yield* newSession;
        const agent = yield* Agent;
        yield* agent.prompt(id, text("go"));
        return { id, revision: (yield* agent.view(id)).queueRevision };
      }),
    );
    // The session is idle, so its journal is gone; and the next host's clock reads the epoch. Its instance number is
    // the next: its revisions start past every one the last could have told.
    const after = await run({ testClock: true, scripts: [] }, () => Effect.flatMap(Agent, (agent) => agent.view(before.id)));
    expect(after.queueRevision).toBeGreaterThan(before.revision);
  });
});

describe("a withdrawn prompt", () => {
  it("sent again with its request id is refused, by this host and the next", async () => {
    const gate = Effect.runSync(Deferred.make<void>());
    const seen = await run({ scripts: [gated(gate, reply("first"))] }, () =>
      Effect.gen(function* () {
        const { id } = yield* newSession;
        const agent = yield* Agent;
        yield* Effect.forkChild(agent.prompt(id, text("first")));
        yield* waitFor(agent.busy(id), (busy) => busy);
        const queued = yield* Effect.forkChild(Effect.flip(agent.prompt(id, text("second"), { requestId: "b" })));
        yield* waitFor(agent.queue(id), (queue) => queue.length === 1);
        const withdrawn = yield* agent.withdraw(id, "b");
        const again = yield* Effect.flip(agent.prompt(id, text("second"), { requestId: "b" }));
        return { id, withdrawn, first: (yield* Fiber.join(queued)).reason, again: again.reason };
      }),
    );
    expect(seen).toMatchObject({ withdrawn: true, first: "Retracted", again: "Retracted" });
    const next = await run({ scripts: [reply("first")] }, () =>
      Effect.flip(Effect.flatMap(Agent, (agent) => agent.prompt(seen.id, text("second"), { requestId: "b" }))),
    );
    expect(next.reason).toBe("Retracted");
  });
});

/** Runs until its call is aborted, as a long command a restart cuts off does. */
const slow: Tool<Record<string, never>> = {
  name: "slow",
  description: "Takes a while.",
  input: Schema.Struct({}),
  execute: (_, { signal }) =>
    new Promise((resolve) => signal.addEventListener("abort", () => resolve(new ToolResult({ content: [{ type: "text", text: "aborted" }] })), { once: true })),
};

/** `fs` whose session file refuses the first line holding each of `markers`, as a disk that fills up at that moment. */
const refusingOnce = (...markers: readonly string[]): FileSystem => {
  const left = new Set(markers);
  const wrap = (handle: FileHandle): FileHandle =>
    Object.assign(Object.create(handle) as FileHandle, {
      appendFile: (data: string) => {
        const marker = [...left].find((marker) => data.includes(marker));
        if (marker === undefined) return handle.appendFile(data);
        left.delete(marker);
        return Promise.reject(Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }));
      },
    });
  return { ...nodeFileSystem, open: async (path, flags, mode) => wrap(await nodeFileSystem.open(path, flags, mode)) };
};

describe("a resumed turn", () => {
  it("whose first write fails closes answering the calls its cut-off step left", async () => {
    const id = await run({ tools: [slow], scripts: [useTools(call("c1", "slow", {}))] }, () =>
      Effect.gen(function* () {
        const { id } = yield* newSession;
        const agent = yield* Agent;
        yield* Effect.forkChild(agent.prompt(id, text("go")));
        yield* waitFor(log(id), (events) => ofType(events, "custom").some((data) => data.kind === "agent.started"));
        return id;
      }),
    );
    // The next host cannot write the event saying the turn resumes: the turn fails, and closes.
    const events = await run({ tools: [slow], scripts: [], sessions: makeSessionsPlugin({ fs: refusingOnce('"kind":"agent.resumed"') }) }, () =>
      waitFor(log(id), (events) => ofType(events, "turn-end").length > 0),
    );
    const results = ofType(events, "message").flatMap((data) => (data.message.role === "toolResult" ? [data.message.toolCallId] : []));
    expect(results).toEqual(["c1"]);
    const order = events.map((event) => event.data.type);
    expect(order.lastIndexOf("message")).toBeLessThan(order.indexOf("turn-end"));
    expect(ofType(events, "turn-end")[0]!.reason).toBe("error");
  });
});

describe("a prompt its turn never placed", () => {
  it("sent again while the turn waits to close (its turn-end lost) is placed, rather than answered placed unlogged", async () => {
    // The disk fills up as the prompt is logged, and again as the turn ends: it ends, but not in the log.
    const sessions = makeSessionsPlugin({ fs: refusingOnce('"requestId":"a"', '"type":"turn-end"') });
    const seen = await run({ scripts: [reply("done")], sessions }, () =>
      Effect.gen(function* () {
        const { id } = yield* newSession;
        const agent = yield* Agent;
        const first = yield* Effect.flip(agent.prompt(id, text("go"), { requestId: "a" }));
        // A client that never heard sends it again: the turn closes first.
        const again = yield* agent.prompt(id, text("go"), { requestId: "a" });
        return { first: first.reason, again: again.kind, events: yield* log(id) };
      }),
    );
    expect(seen).toMatchObject({ first: "Session", again: "placed" });
    expect(ofType(seen.events, "message").filter((data) => data.requestId === "a")).toHaveLength(1);
    expect(ofType(seen.events, "turn-end").map((data) => data.reason)).toEqual(["error", "done"]);
  });
});

describe("the agent's state on a failing disk", () => {
  it("is not taken for none: a journal it cannot read fails its start", async () => {
    const eio = () => Promise.reject(Object.assign(new Error("EIO: i/o error"), { code: "EIO" }));
    const failing: FileSystem = { ...nodeFileSystem, readdir: (path) => (path.endsWith("/agent") ? eio() : nodeFileSystem.readdir(path)) };
    const llm = fakeLlm([hang("")]);
    const exit = await Effect.runPromiseExit(
      Effect.scoped(makeCore([paths(dir, dir), host(), makeSessionsPlugin(), tools, testTools().plugin, llm.plugin, makeAgentPlugin({ fs: failing })], {})),
    );
    expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain("could not read");
  });
});
