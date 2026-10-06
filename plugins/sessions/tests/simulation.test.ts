import { describe, expect, test } from "vitest";
import { Effect, Exit, Result, Scope } from "effect";
import type { Context } from "effect";
import { TestClock } from "effect/testing";
import fc from "fast-check";
import { makeCore } from "@lemma/core";
import { Sessions } from "@lemma/contracts";
import { pathsPlugin } from "@lemma/contracts/testing";
import type { EventData, SessionEvent } from "@lemma/contracts";
import { seededRandom, SimDisk } from "@lemma/testing";
import type { Faults } from "@lemma/testing";
import { IdBytes } from "../src/format.ts";
import { makeSessionsPlugin } from "../src/index.ts";

/*
 * A deterministic simulation of the session log, after TigerBeetle's VOPR and
 * FoundationDB's simulator: random operations on a simulated disk that tears
 * and drops unsynced writes at a crash, fails operations at rates drawn per run
 * (swarm testing), and is changed by "another program". One seed fixes the
 * disk, the ids, and the clock, so a failure replays from the seed and path it
 * prints, and fast-check shrinks it to a short sequence.
 *
 * Safety, checked after each operation and each restart:
 * - an append that returned survives restarts and crashes, as it was returned;
 * - after a crash a session is its acknowledged events, then at most one of
 *   the failed appends since the last acknowledged one (a failed append may
 *   have reached the disk, but each write first cuts what the last one left);
 * - a session nothing else wrote to is never `Corrupt`;
 * - `list` agrees with the events.
 * Liveness, at the end with faults off: every session takes an append that a
 * restart keeps.
 */

const paths = pathsPlugin("/home", { cwd: "/work" });

type Command =
  | { readonly kind: "create"; readonly project: number }
  | { readonly kind: "append"; readonly session: number; readonly title: boolean; readonly text: string; readonly parent: number | undefined }
  | { readonly kind: "checkout"; readonly session: number; readonly event: number }
  | { readonly kind: "remove"; readonly session: number }
  | { readonly kind: "list" }
  | { readonly kind: "unload" }
  | { readonly kind: "restart" }
  | { readonly kind: "crash" }
  /** A power loss part-way through an append: after `operations` more disk operations. */
  | { readonly kind: "crash-during"; readonly session: number; readonly operations: number; readonly text: string }
  | { readonly kind: "tamper"; readonly session: number; readonly how: "append" | "replace" | "truncate" };

// Any code points, lone surrogates and newlines included: a line must read back as it was written.
const text = fc.oneof(
  fc.string({ unit: "binary", maxLength: 24 }),
  fc.string({ maxLength: 24 }).map((text) => text.replaceAll("x", "\n")),
);

const command: fc.Arbitrary<Command> = fc.oneof(
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("create" as const), project: fc.nat(2) }) },
  {
    weight: 10,
    arbitrary: fc.record({
      kind: fc.constant("append" as const),
      session: fc.nat(),
      title: fc.boolean(),
      text,
      parent: fc.option(fc.nat(), { nil: undefined }),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("checkout" as const), session: fc.nat(), event: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("remove" as const), session: fc.nat() }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("list" as const) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("unload" as const) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("restart" as const) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("crash" as const) }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("crash-during" as const), session: fc.nat(), operations: fc.nat(12), text }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("tamper" as const), session: fc.nat(), how: fc.constantFrom("append", "replace", "truncate") }) },
);

/** Fault rates for one run: often off, sometimes rare, sometimes frequent, per kind. */
const rate = fc.constantFrom(0, 0, 0.02, 0.1, 0.3);
const swarm: fc.Arbitrary<Faults> = fc.record({ write: rate, sync: rate, truncate: rate, rename: rate, open: rate });

/** What the test knows of a session. */
interface Known {
  readonly id: string;
  /** What `append` returned, in order: what the session holds. */
  acked: SessionEvent[];
  /** Appends that failed since the last that returned: a crash may keep a prefix of them. */
  maybe: EventData[];
  removed: boolean;
  /** Removed while syncs could fail: the removal may not survive a crash, and the session may come back whole. */
  removedUnsynced: boolean;
  /** Another program wrote to its file: nothing is promised for it any more. */
  tampered: boolean;
}

/**
 * Situations the runs must reach (SQLite's `testcase`, Antithesis's `sometimes`): a generator that stopped
 * reaching one would let its bugs through while every run passes.
 */
const reached = {
  acknowledged: 0,
  failedAppend: 0,
  crash: 0,
  tornTail: 0,
  failedAppendKept: 0,
  failedAppendDropped: 0,
  reloadAfterUnload: 0,
  tamperedRefused: 0,
  removedReturned: 0,
};

type Service = Context.Service.Shape<typeof Sessions>;
interface Running {
  readonly scope: Scope.Closeable;
  readonly sessions: Service;
}

/** JSON is the log's medium: the data an append is given, as reading the line back gives it. */
const asWritten = (data: EventData): unknown => JSON.parse(JSON.stringify(data));

const simulate = (seed: number, faults: Faults, initial: number, commands: readonly Command[]) =>
  Effect.gen(function* () {
    const disk = new SimDisk(seededRandom(seed));
    const log: string[] = [];
    /** Starts a host process on the disk; faults stay off while it starts, so every run gets going. */
    const start = Effect.gen(function* () {
      Object.assign(disk.faults, { write: 0, sync: 0, truncate: 0, rename: 0, open: 0 });
      const scope = yield* Scope.make();
      const core = yield* makeCore([paths, makeSessionsPlugin({ fs: disk.mount() })], { configs: { sessions: { unloadAfter: 300 } } }).pipe(
        Scope.provide(scope),
      );
      const sessions = yield* core.run(Sessions);
      Object.assign(disk.faults, faults);
      return { scope, sessions } satisfies Running;
    });
    let host: Running = yield* start;
    const known: Known[] = [];
    let crashed = false;
    for (let n = 0; n < initial; n++) {
      Object.assign(disk.faults, { write: 0, sync: 0, truncate: 0, rename: 0, open: 0 });
      const { id } = yield* host.sessions.create({ cwd: `/work/p${n}` });
      known.push({ id, acked: [], maybe: [], removed: false, removedUnsynced: false, tampered: false });
      Object.assign(disk.faults, faults);
    }
    const live = () => known.filter((session) => !session.removed && !session.tampered);
    const pick = (index: number) => {
      const candidates = live();
      return candidates.length === 0 ? undefined : candidates[index % candidates.length];
    };
    const fileOf = (id: string) => disk.list().find((file) => file.endsWith(`_${id}.jsonl`));

    /** After a restart or crash: each session is what it acknowledged, then a prefix of what failed since. */
    const reconcile = Effect.gen(function* () {
      const saved = { ...disk.faults };
      Object.assign(disk.faults, { write: 0, sync: 0, truncate: 0, rename: 0, open: 0 });
      for (const session of known) {
        if (session.tampered) continue;
        const read = yield* Effect.result(host.sessions.events(session.id));
        if (session.removed && Result.isSuccess(read) && session.removedUnsynced) {
          reached.removedReturned++;
          session.removed = false;
        }
        if (session.removed) {
          expect(Result.isFailure(read) && read.failure.reason, `removed session ${session.id} came back`).toBe("NotFound");
          continue;
        }
        if (Result.isFailure(read)) expect.fail(`session ${session.id}: ${read.failure.reason}: ${read.failure.message}`);
        const events = (read as Result.Success<readonly SessionEvent[], never>).success;
        expect(events.slice(0, session.acked.length), `session ${session.id} lost or changed acknowledged events`).toEqual(session.acked);
        // At most one failed append can be on the disk: each write first cuts what the last failed one left.
        const extra = events.slice(session.acked.length);
        expect(extra.length, `session ${session.id} kept more than one failed append`).toBeLessThanOrEqual(Math.min(1, session.maybe.length));
        if (extra.length === 1) expect(session.maybe.map(asWritten)).toContainEqual(extra[0]!.data);
        if (extra.length > 0) reached.failedAppendKept++;
        else if (session.maybe.length > 0) reached.failedAppendDropped++;
        session.acked = [...events];
        session.maybe = [];
      }
      yield* checkList(true);
      Object.assign(disk.faults, saved);
    });

    /** `list` against what is known; with `complete`, every live session must be there (no fault can hide one). */
    const checkList = (complete: boolean) =>
      Effect.gen(function* () {
        const listed = yield* Effect.result(host.sessions.list());
        if (Result.isFailure(listed)) {
          expect(complete, `list failed: ${listed.failure.message}`).toBe(false);
          return;
        }
        const byId = new Map(listed.success.map((info) => [info.id, info]));
        // A session whose create failed is gone, unless a crash undid the removal of its file.
        if (!crashed)
          for (const info of listed.success)
            expect(
              known.some((session) => session.id === info.id),
              `unknown session ${info.id} listed`,
            ).toBe(true);
        for (const session of known) {
          if (session.tampered) continue;
          const info = byId.get(session.id);
          if (session.removed) {
            expect(info, `removed session ${session.id} is listed`).toBeUndefined();
            continue;
          }
          if (info === undefined) {
            expect(complete, `session ${session.id} is not listed`).toBe(false);
            continue;
          }
          expect(info.lastSeq, `list's lastSeq for ${session.id}`).toBe(session.acked.length);
          const titles = session.acked.flatMap((event) => (event.data.type === "title" ? [event.data.title] : []));
          expect(info.title).toBe(titles.at(-1));
        }
      });

    /** `scheduled`: the crash `crashAfter` set up came part-way through the last operation, or comes now. */
    const restart = (crash: "no" | "now" | "scheduled") =>
      Effect.gen(function* () {
        if (crash !== "no") {
          if (crash === "now" || disk.crashPending) disk.crash();
          crashed = true;
          reached.crash++;
          // A file whose last bytes are not a whole line: a write the crash cut short.
          if (disk.list().some((file) => file.endsWith(".jsonl") && !(disk.read(file) ?? "").endsWith("\n"))) reached.tornTail++;
        }
        // After a crash the old process can do nothing: every disk operation it attempts fails.
        yield* Scope.close(host.scope, Exit.void);
        host = yield* start;
        yield* reconcile;
      });

    for (const [step, next] of commands.entries()) {
      log.push(`${step}: ${JSON.stringify(next)}`);
      switch (next.kind) {
        case "create": {
          const created = yield* Effect.result(host.sessions.create({ cwd: `/work/p${next.project}` }));
          if (Result.isSuccess(created)) known.push({ id: created.success.id, acked: [], maybe: [], removed: false, removedUnsynced: false, tampered: false });
          else expect(created.failure.reason).toBe("Io");
          break;
        }
        case "append": {
          const session = pick(next.session);
          if (session === undefined) break;
          const data: EventData = next.title ? { type: "title", title: next.text } : { type: "custom", kind: "note", data: { text: next.text } };
          const parent = next.parent === undefined || session.acked.length === 0 ? undefined : session.acked[next.parent % session.acked.length]!.id;
          const appended = yield* Effect.result(host.sessions.append(session.id, data, parent === undefined ? undefined : { parent }));
          if (Result.isSuccess(appended)) {
            const event = appended.success;
            expect(event.seq).toBe(session.acked.length + 1);
            expect(event.data).toEqual(asWritten(data));
            if (parent !== undefined) expect(event.parent).toBe(parent);
            session.acked.push(event);
            session.maybe = [];
            reached.acknowledged++;
          } else {
            expect(appended.failure.reason, appended.failure.message).toBe("Io");
            session.maybe.push(data);
            reached.failedAppend++;
          }
          break;
        }
        case "checkout": {
          const session = pick(next.session);
          if (session === undefined || session.acked.length === 0) break;
          const checked = yield* Effect.result(host.sessions.checkout(session.id, session.acked[next.event % session.acked.length]!.id));
          if (Result.isFailure(checked)) expect(checked.failure.reason, checked.failure.message).toBe("Io");
          break;
        }
        case "remove": {
          const session = pick(next.session);
          if (session === undefined) break;
          const removed = yield* Effect.result(host.sessions.remove(session.id));
          if (Result.isSuccess(removed)) {
            session.removed = true;
            session.removedUnsynced = (disk.faults.sync ?? 0) > 0 || (disk.faults.open ?? 0) > 0;
          } else expect(removed.failure.reason, removed.failure.message).toBe("Io");
          break;
        }
        case "list":
          yield* checkList(false);
          break;
        case "unload":
          // Idle past `unloadAfter`: the sweep closes every loaded session; the next use reads it again.
          yield* TestClock.adjust("11 minutes");
          yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 1)));
          if (live().some((session) => session.acked.length > 0)) reached.reloadAfterUnload++;
          break;
        case "restart":
          yield* restart("no");
          break;
        case "crash":
          yield* restart("now");
          break;
        case "crash-during": {
          const session = pick(next.session);
          if (session === undefined) break;
          const data: EventData = { type: "custom", kind: "note", data: { text: next.text } };
          disk.crashAfter(next.operations);
          const appended = yield* Effect.result(host.sessions.append(session.id, data));
          if (Result.isSuccess(appended)) session.acked.push(appended.success);
          else session.maybe.push(data);
          yield* restart("scheduled");
          break;
        }
        case "tamper": {
          const session = pick(next.session);
          const file = session === undefined ? undefined : fileOf(session.id);
          if (session === undefined || file === undefined) break;
          session.tampered = true;
          if (next.how === "append") disk.outside.append(file, '{"written":"by another program"}\n');
          else if (next.how === "replace") disk.outside.replace(file, "not a session\n");
          else disk.outside.truncate(file, Math.floor((disk.read(file)?.length ?? 0) / 2));
          break;
        }
      }
      // In one process, memory is the truth: what `events` gives is exactly what was acknowledged.
      if (next.kind !== "restart" && next.kind !== "crash" && next.kind !== "crash-during") {
        for (const session of live()) {
          const read = yield* Effect.result(host.sessions.events(session.id));
          // A session not in memory is read from the file, which a fault may stop.
          if (Result.isFailure(read)) {
            expect(read.failure.reason, read.failure.message).toBe("Io");
            continue;
          }
          expect(read.success, `session ${session.id} after step ${step}`).toEqual(session.acked);
        }
        for (const session of known) {
          if (!session.tampered || session.removed) continue;
          const appended = yield* Effect.result(host.sessions.append(session.id, { type: "title", title: "over theirs" }));
          if (Result.isFailure(appended)) reached.tamperedRefused++;
        }
      }
    }

    // Liveness: with the disk healthy again, every session takes an append, and a restart keeps it.
    yield* restart("no");
    Object.assign(faults, { write: 0, sync: 0, truncate: 0, rename: 0, open: 0 });
    Object.assign(disk.faults, faults);
    for (const session of live()) {
      const event = yield* host.sessions.append(session.id, { type: "title", title: "after" });
      session.acked.push(event);
    }
    yield* restart("no");
    yield* Scope.close(host.scope, Exit.void);
  }).pipe(Effect.provideService(IdBytes, seededBytes(seed)), Effect.provide(TestClock.layer()));

/** Ids from the run's seed, so a failure replays with the same files in the same order. */
const seededBytes = (seed: number) => {
  const random = seededRandom(seed ^ 0x5eed);
  return (size: number) => Uint8Array.from({ length: size }, () => Math.floor(random() * 256));
};

const runs = Number(process.env.LEMMA_SIM_RUNS ?? 100);

describe("sessions directory", () => {
  test("a start that could not sync the directories above it syncs them on the next, so a crash keeps what it creates", async () => {
    for (let seed = 0; seed < 30; seed++) {
      const disk = new SimDisk(seededRandom(seed));
      const host = <A, E>(body: (sessions: Service) => Effect.Effect<A, E>) =>
        Effect.runPromiseExit(
          Effect.scoped(Effect.flatMap(makeCore([paths, makeSessionsPlugin({ fs: disk.mount() })]), (core) => Effect.flatMap(core.run(Sessions), body))).pipe(
            Effect.provide(TestClock.layer()),
          ),
        );
      disk.faults.sync = 1;
      expect(Exit.isFailure(await host(() => Effect.void))).toBe(true);
      disk.faults.sync = 0;
      const created = await host((sessions) => sessions.create({ cwd: "/work/a" }));
      if (Exit.isFailure(created)) throw new Error(`create failed: ${String(created.cause)}`);
      disk.crash();
      expect(
        disk.list().some((file) => file.endsWith(`_${created.value.id}.jsonl`)),
        `seed ${seed}`,
      ).toBe(true);
    }
  });
});

describe("session log simulation", () => {
  test("acknowledged events survive crashes, torn and lost writes, failing disks, and other programs' writes", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer(),
        swarm,
        fc.integer({ min: 1, max: 3 }),
        fc.array(command, { minLength: 1, maxLength: 60 }),
        async (seed, faults, initial, commands) => {
          await Effect.runPromise(simulate(seed, { ...faults }, initial, commands));
        },
      ),
      {
        numRuns: runs,
        ...(process.env.LEMMA_SIM_SEED === undefined ? {} : { seed: Number(process.env.LEMMA_SIM_SEED) }),
        ...(process.env.LEMMA_SIM_PATH === undefined ? {} : { path: process.env.LEMMA_SIM_PATH }),
      },
    );
    process.stderr.write(`session log simulation, ${runs} runs: ${JSON.stringify(reached)}\n`);
    // The rare ones are required of the long nightly runs only.
    const rare = new Set(["removedReturned", "failedAppendKept"]);
    for (const [situation, count] of Object.entries(reached)) {
      if (runs >= 1000 || !rare.has(situation)) expect(count, `no run reached "${situation}"`).toBeGreaterThan(0);
    }
  }, 600_000);
});
