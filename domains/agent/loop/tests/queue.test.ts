import { Deferred, Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import { SimDisk } from "@lemma/testing";
import type { AgentError, QueuedPrompt } from "@lemma/agent";
import { admission, itemOf, journalOf, makeQueues, MAX_QUEUED } from "../src/queue.ts";
import type { Item, QueuedTurn, SessionState } from "../src/queue.ts";
import { readJournals } from "../src/state.ts";

/*
 * The sessions' queues and turns as the journal records them, on their own: a change the journal cannot record is
 * put back (`recorded`), and what a prompt comes to is read from them (`admission`).
 */

const prompt = (requestId: string, mode: QueuedPrompt["mode"] = "follow-up"): QueuedPrompt => ({
  requestId,
  content: [{ type: "text", text: requestId }],
  mode,
  at: 1,
});

const turn = (turnId: string, placed: readonly Item[] = [], extra: Partial<QueuedTurn> = {}): QueuedTurn => ({
  turnId,
  prompts: placed.map((item) => item.prompt),
  cancelling: false,
  marked: true,
  items: new Map(placed.map((item) => [item.prompt.requestId, item])),
  ended: Deferred.makeUnsafe<void, AgentError>(),
  ...extra,
});

const empty = (): SessionState<QueuedTurn> => ({
  turn: undefined,
  suspended: undefined,
  restored: false,
  unchecked: false,
  queue: [],
  revision: 0,
  held: false,
  withdrawn: [],
});

/** Queues on a simulated disk, and what its journals say. */
const onDisk = () => {
  const disk = new SimDisk();
  const files = { home: "/lemma", fs: disk.mount() };
  const queues = makeQueues<QueuedTurn>(files, 1000);
  const journal = (sessionId: string) => Effect.runPromise(Effect.map(readJournals(files), (journals) => journals.get(sessionId)));
  return { disk, queues, journal };
};

describe("recorded", () => {
  it("keeps a change once the journal has it, and puts back one it could not record, the queue's revision moving on", async () => {
    const { disk, queues, journal } = onDisk();
    const [a, b] = [itemOf(prompt("a")), itemOf(prompt("b"))];
    await Effect.runPromise(queues.recorded("s", (state) => queues.setQueue(state, [a, b])));
    expect((await journal("s"))?.queue.map((queued) => queued.requestId)).toEqual(["a", "b"]);
    const state = queues.of("s");
    const before = state.revision;

    // Withdrawing `a` cannot be recorded: the session is as it was, and the journal too.
    disk.faultAfter(0, { persistent: true });
    const exit = await Effect.runPromiseExit(
      queues.recorded("s", (from) =>
        Effect.andThen(
          queues.setQueue(
            from,
            from.queue.filter((item) => item !== a),
          ),
          Effect.sync(() => void (from.withdrawn = [...from.withdrawn, "a"])),
        ),
      ),
    );
    expect(Exit.isFailure(exit) && exit.cause.reasons[0]?._tag === "Fail" && exit.cause.reasons[0].error).toMatchObject({ reason: "Io" });
    expect(state.queue).toEqual([a, b]);
    expect(state.withdrawn).toEqual([]);
    expect(state.revision).toBeGreaterThan(before + 1);
    disk.clearFaults();
    expect((await journal("s"))?.queue.map((queued) => queued.requestId)).toEqual(["a", "b"]);
    expect((await journal("s"))?.withdrawn).toBeUndefined();
  });

  it("puts back a turn it could not record, and what the change took for it", async () => {
    const { disk, queues } = onDisk();
    const state = queues.of("s");
    const held = itemOf(prompt("held"));
    state.queue = [held];
    state.held = true;
    state.restored = true;
    disk.faultAfter(0, { persistent: true });
    const started = turn("t1", [held]);
    const exit = await Effect.runPromiseExit(
      queues.recorded("s", (taken) =>
        Effect.andThen(
          queues.setQueue(taken, []),
          Effect.sync(() => {
            taken.turn = started;
            taken.held = false;
            taken.restored = false;
          }),
        ),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(state).toMatchObject({ turn: undefined, queue: [held], held: true, restored: true });
  });

  it("puts back what a change that fails changed, writing nothing", async () => {
    const { queues, journal } = onDisk();
    const state = queues.of("s");
    const exit = await Effect.runPromiseExit(queues.recorded("s", (from) => Effect.andThen(queues.setQueue(from, [itemOf(prompt("a"))]), Effect.fail("no"))));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(state.queue).toEqual([]);
    expect(await journal("s")).toBeUndefined();
  });
});

describe("journalOf and restore", () => {
  it("records the running turn, or the suspended one, the queue, and held only with something queued", () => {
    const state = empty();
    const placed = itemOf(prompt("p"));
    state.turn = turn("t1", [placed], { cancelling: true, closing: { reason: "error", error: "disk full" } });
    state.held = true;
    expect(journalOf(state)).toEqual({
      turn: { turnId: "t1", prompts: [placed.prompt], cancelling: true, marked: true, closing: { reason: "error", error: "disk full" } },
      queue: [],
    });
    state.turn = undefined;
    state.suspended = { turnId: "t0", prompts: [placed], marked: false, cancelling: false };
    state.queue = [itemOf(prompt("q"))];
    state.withdrawn = ["w"];
    expect(journalOf(state)).toEqual({ turn: { turnId: "t0", prompts: [placed.prompt] }, queue: [prompt("q")], held: true, withdrawn: ["w"] });
  });

  it("restores each journal as its session's state, its turn suspended, to be taken up and checked against the log", () => {
    const { queues } = onDisk();
    queues.restore(
      new Map([
        ["running", { turn: { turnId: "t1", prompts: [prompt("p")], closing: { reason: "done" as const } }, queue: [prompt("q")], held: true }],
        ["withdrawn", { queue: [], withdrawn: ["w"] }],
      ]),
    );
    expect(queues.get("running")).toMatchObject({
      restored: true,
      unchecked: true,
      held: true,
      queue: [{ prompt: prompt("q"), placing: false }],
      suspended: { turnId: "t1", prompts: [{ prompt: prompt("p") }], marked: false, cancelling: false, closing: { reason: "done" } },
    });
    // Nothing to take up: only what was withdrawn is kept.
    expect(queues.get("withdrawn")).toMatchObject({ restored: false, unchecked: false, withdrawn: ["w"] });
  });
});

describe("admission", () => {
  const known = (entries: Record<string, string | undefined> = {}) => new Map(Object.entries(entries));

  it("starts a turn in an idle session, and queues behind a running one unless asked not to or the queue is full", () => {
    const state = empty();
    expect(admission("s", state, { whenBusy: "follow-up" }, known())).toEqual({ kind: "start" });
    state.turn = turn("t1");
    expect(admission("s", state, { whenBusy: "steer" }, known())).toEqual({ kind: "queue" });
    expect(admission("s", state, { whenBusy: "reject" }, known())).toEqual({ kind: "busy", message: "Session s already has a turn in progress" });
    state.queue = Array.from({ length: MAX_QUEUED }, (_, index) => itemOf(prompt(`q${index}`)));
    expect(admission("s", state, { whenBusy: "follow-up" }, known())).toMatchObject({ kind: "busy" });
  });

  it("answers a prompt sent again by where it is: queued (starting a held queue), placed, or in the log", () => {
    const state = empty();
    const queued = itemOf(prompt("queued"));
    state.queue = [queued];
    // Held after a failed turn: the retry starts it.
    expect(admission("s", state, { requestId: "queued", whenBusy: "follow-up" }, known())).toEqual({ kind: "queued", item: queued, start: true });
    const placed = itemOf(prompt("placed"));
    const running = turn("t2", [placed]);
    state.turn = running;
    expect(admission("s", state, { requestId: "queued", whenBusy: "reject" }, known())).toEqual({ kind: "queued", item: queued, start: false });
    expect(admission("s", state, { requestId: "placed", whenBusy: "reject" }, known())).toEqual({ kind: "placed", done: placed.done });
    // Placed by the running turn, as the log says: awaited with it; by an earlier one, answered at once.
    expect(admission("s", state, { requestId: "steered", whenBusy: "reject" }, known({ steered: "t2" }))).toEqual({ kind: "logged", ended: running.ended });
    expect(admission("s", state, { requestId: "old", whenBusy: "reject" }, known({ old: "t1" }))).toEqual({ kind: "logged", ended: undefined });
    // Unknown: a new prompt.
    expect(admission("s", state, { requestId: "new", whenBusy: "follow-up" }, known({ old: "t1" }))).toEqual({ kind: "queue" });
  });
});
