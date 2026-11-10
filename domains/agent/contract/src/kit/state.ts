import { basename, join } from "node:path";
import { Data, Effect, Option, Schema } from "effect";
import { QueuedPrompt } from "../agent.ts";
import { AssistantMessage } from "@lemma/llm";
import { TurnEndReason } from "@lemma/sessions";
import { errorCode, readJsonFile, removeFile, writeFileAtomic } from "@lemma/contracts/fs";
import type { FileSystem } from "@lemma/contracts/fs";
import { errorMessage } from "@lemma/contracts";

/*
 * What the agent keeps on disk beside the session log, per session, under
 * `<home>/agent`: the journal (`<session>.json`) and the running turn's output
 * so far (`<session>.live.json`), as the README's Durability section
 * describes. The log stays the source of truth: anything these files claim
 * that it contradicts is dropped.
 */

/** How often a running turn's output so far is written, at most. */
export const LIVE_INTERVAL_MS = 250;

export const Journal = Schema.Struct({
  /** The turn running when this was written; the prompts it was started with stay here until it ends. */
  turn: Schema.optional(
    Schema.Struct({
      turnId: Schema.String,
      prompts: Schema.Array(QueuedPrompt),
      /** `cancel` was asked for: a resumed turn closes as cancelled instead of continuing. */
      cancelling: Schema.optional(Schema.Boolean),
      /** It ended so, but its `turn-end` did not reach the log: a resumed turn closes so instead of continuing. */
      closing: Schema.optional(Schema.Struct({ reason: TurnEndReason, error: Schema.optional(Schema.String) })),
      /**
       * The turn logs an `agent.started` event before it runs tool calls, so a call none names never ran. Absent for a
       * turn an older agent started, which did not: any of its cut-off calls may have run.
       */
      marked: Schema.optional(Schema.Boolean),
    }),
  ),
  queue: Schema.Array(QueuedPrompt),
  /** The last turn failed or was cancelled: the queue waits for the next prompt rather than starting a turn. */
  held: Schema.optional(Schema.Boolean),
  /** Request ids withdrawn from the queue, the latest last: a prompt sent again with one is refused `Retracted`. */
  withdrawn: Schema.optional(Schema.Array(Schema.String)),
});
export type Journal = typeof Journal.Type;

export const LiveFile = Schema.Struct({
  turnId: Schema.String,
  step: Schema.optional(Schema.Struct({ stepId: Schema.String, startedAt: Schema.Number, content: AssistantMessage.fields.content })),
  output: Schema.Array(Schema.Struct({ toolCallId: Schema.String, output: Schema.String, length: Schema.Number })),
});
export type LiveFile = typeof LiveFile.Type;

/** A file of the agent's state could not be written or removed: a full or failing disk. */
export class StateWriteError extends Data.TaggedError("StateWriteError")<{ readonly message: string; readonly cause: unknown }> {}

/** Where the agent's state is, and the file system it is on. */
export interface StateFiles {
  readonly home: string;
  readonly fs: FileSystem;
}

const stateDir = ({ home }: StateFiles) => join(home, "agent");
// Session ids belong to the store's contract, so they need not be safe path segments.
// Dots are escaped too, so a journal's id ending in `.live` cannot collide with live output.
const stateName = (sessionId: string) => encodeURIComponent(sessionId).replaceAll(".", "%2E");
/** The current path first, then a safe legacy path, if different. Encoded names never overlap legacy names. */
const statePaths = (files: StateFiles, sessionId: string, suffix: string): readonly [string, ...string[]] => {
  const name = stateName(sessionId);
  const current = join(stateDir(files), ...(name === sessionId ? [] : ["escaped"]), `${name}${suffix}`);
  if (name === sessionId || basename(`${sessionId}${suffix}`) !== `${sessionId}${suffix}` || sessionId.endsWith(".live")) return [current];
  return [current, join(stateDir(files), `${sessionId}${suffix}`)];
};
/** How many times an agent has started on this state: each instance's queue revisions start from its number. */
const instancePath = (files: StateFiles) => join(stateDir(files), "instance");

const attempt = (what: string, write: () => Promise<unknown>): Effect.Effect<void, StateWriteError> =>
  Effect.tryPromise({
    try: write,
    catch: (cause) => new StateWriteError({ message: `could not ${what}: ${errorMessage(cause)}`, cause }),
  }).pipe(Effect.asVoid);

/** A write that fails (a full disk) costs durability, not the turn: it is logged, and the next write tries again. */
const bestEffort = (what: string, write: () => Promise<unknown>): Effect.Effect<void> =>
  attempt(what, write).pipe(Effect.catch((error) => Effect.logWarning(`agent: ${error.message}`)));

/** The disk would not say what is there (`EIO`): the agent cannot know the state it left, and does not start. */
export class StateReadError extends Data.TaggedError("StateReadError")<{ readonly message: string; readonly cause: unknown }> {}

const Instance = Schema.Struct({ instance: Schema.Number });
const decodeInstance = Schema.decodeUnknownOption(Schema.fromJsonString(Instance));

/**
 * The lowest instance number: its revisions (see `REVISIONS_PER_INSTANCE` in the agent) start past the wall-clock
 * milliseconds earlier agents numbered them by, so an upgrade never takes a revision back.
 */
export const FIRST_INSTANCE = 1024;

/**
 * This start's instance number, one past the last start's, recorded durably before it is used: no two starts share
 * one, whatever a clock or a failed journal write did. Fails when it cannot be read or recorded, and the agent then
 * does not start.
 */
export const nextInstance = (files: StateFiles): Effect.Effect<number, StateReadError | StateWriteError> =>
  Effect.gen(function* () {
    const text = yield* Effect.tryPromise({
      try: () => files.fs.readFile(instancePath(files), "utf8").catch((cause) => (errorCode(cause) === "ENOENT" ? undefined : Promise.reject(cause))),
      catch: (cause) => new StateReadError({ message: `could not read ${instancePath(files)}: ${errorMessage(cause)}`, cause }),
    });
    const last = text === undefined ? undefined : Option.getOrUndefined(decodeInstance(text))?.instance;
    const instance = Math.max(FIRST_INSTANCE, (last ?? 0) + 1);
    yield* attempt(`record the agent's start`, () => writeFileAtomic(instancePath(files), `${JSON.stringify({ instance })}\n`, { sync: true, fs: files.fs }));
    return instance;
  });

const decodeJournal = Schema.decodeUnknownOption(Schema.fromJsonString(Journal));

/**
 * Every session's journal. One that does not decode (a version it does not know, a torn write) is skipped with a
 * warning, so it never keeps the agent from starting; none at all (no directory yet) is none. A disk that fails to
 * answer fails this, as the agent would otherwise start without what it left, and place a prompt it had queued again.
 */
export const readJournals = (files: StateFiles): Effect.Effect<ReadonlyMap<string, Journal>, StateReadError> =>
  Effect.gen(function* () {
    const read = <A>(what: string, run: () => Promise<A>) =>
      Effect.tryPromise({
        try: run,
        catch: (cause) => new StateReadError({ message: `could not read ${what}: ${errorMessage(cause)}`, cause }),
      });
    const missing = (cause: unknown) => (errorCode(cause) === "ENOENT" ? undefined : Promise.reject(cause));
    const found = new Map<string, Journal>();
    // New encoded journals win over legacy files left by an interrupted migration.
    for (const encoded of [false, true]) {
      const dir = encoded ? join(stateDir(files), "escaped") : stateDir(files);
      const names = (yield* read(dir, () => files.fs.readdir(dir).catch(missing))) ?? [];
      // In name order, so the sessions are taken up in the same order on every start.
      for (const name of [...names].sort()) {
        if (!name.endsWith(".json") || name.endsWith(".live.json")) continue;
        const stem = name.slice(0, -".json".length);
        let sessionId: string;
        try {
          sessionId = encoded ? decodeURIComponent(stem) : stem;
        } catch {
          yield* Effect.logWarning(`agent: ignoring state with an invalid filename ${name}`);
          continue;
        }
        const path = join(dir, name);
        // Gone since it was listed (removed as its session went idle): nothing to take up.
        const text = yield* read(path, () => files.fs.readFile(path, "utf8").catch(missing));
        if (text === undefined) continue;
        const journal = Option.getOrUndefined(decodeJournal(text));
        if (journal === undefined) yield* Effect.logWarning(`agent: ignoring unreadable state ${path}`);
        else found.set(sessionId, journal);
      }
    }
    return found;
  });

const isEmpty = (journal: Journal) =>
  journal.turn === undefined && journal.queue.length === 0 && journal.held !== true && (journal.withdrawn ?? []).length === 0;

/**
 * Replaces the session's journal, durably: once this succeeds, a crash leaves it (or, for an empty one, its absence).
 * Fails when it cannot, so the change it records is not reported made.
 */
export const writeJournal = (files: StateFiles, sessionId: string, journal: Journal): Effect.Effect<void, StateWriteError> =>
  attempt(`write the state of session ${sessionId}`, async () => {
    const [path, ...legacy] = statePaths(files, sessionId, ".json");
    if (isEmpty(journal)) return Promise.all([path, ...legacy].map((file) => removeFile(file, { sync: true, fs: files.fs })));
    await writeFileAtomic(path, `${JSON.stringify(journal)}\n`, { sync: true, fs: files.fs });
    await Promise.all(legacy.map((file) => removeFile(file, { sync: true, fs: files.fs })));
  });

export const readLive = (files: StateFiles, sessionId: string): Effect.Effect<LiveFile | undefined> =>
  Effect.promise(async () => {
    for (const path of statePaths(files, sessionId, ".live.json")) {
      const live = await readJsonFile(path, LiveFile, files.fs);
      if (live !== undefined) return live;
    }
    return undefined;
  });

/** The running turn's output so far, unsynced: it is a convenience, which the log does not need. */
export const writeLive = (files: StateFiles, sessionId: string, live: LiveFile): Effect.Effect<void> =>
  bestEffort(`write the output of session ${sessionId}`, () =>
    writeFileAtomic(statePaths(files, sessionId, ".live.json")[0]!, JSON.stringify(live), { fs: files.fs }),
  );

export const removeLive = (files: StateFiles, sessionId: string): Effect.Effect<void> =>
  bestEffort(`remove the output of session ${sessionId}`, () =>
    Promise.all(statePaths(files, sessionId, ".live.json").map((path) => removeFile(path, { fs: files.fs }))),
  );

/** Both files, for a deleted session. */
export const removeState = (files: StateFiles, sessionId: string): Effect.Effect<void> =>
  bestEffort(`remove the state of session ${sessionId}`, () =>
    Promise.all([
      ...statePaths(files, sessionId, ".json").map((path) => removeFile(path, { sync: true, fs: files.fs })),
      ...statePaths(files, sessionId, ".live.json").map((path) => removeFile(path, { fs: files.fs })),
    ]),
  );
