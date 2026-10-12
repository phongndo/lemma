import { join } from "node:path";
import { Data, Effect, Schema } from "effect";
import { QueuedPrompt } from "@lemma/agent";
import { AssistantMessage } from "@lemma/llm";
import { readJsonFile, removeFile, writeFileAtomic } from "@lemma/contracts/fs";
import type { FileSystem } from "@lemma/contracts/fs";

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
  /** The queue's revision when this was written, so the next instance's keep growing from it (see `QueueChanged`). */
  revision: Schema.optional(Schema.Number),
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
const journalPath = (files: StateFiles, sessionId: string) => join(stateDir(files), `${sessionId}.json`);
const livePath = (files: StateFiles, sessionId: string) => join(stateDir(files), `${sessionId}.live.json`);

const attempt = (what: string, write: () => Promise<unknown>): Effect.Effect<void, StateWriteError> =>
  Effect.tryPromise({
    try: write,
    catch: (cause) => new StateWriteError({ message: `could not ${what}: ${cause instanceof Error ? cause.message : String(cause)}`, cause }),
  }).pipe(Effect.asVoid);

/** A write that fails (a full disk) costs durability, not the turn: it is logged, and the next write tries again. */
const bestEffort = (what: string, write: () => Promise<unknown>): Effect.Effect<void> =>
  attempt(what, write).pipe(Effect.catch((error) => Effect.logWarning(`agent: ${error.message}`)));

/** Every session's journal; one that cannot be read is skipped with a warning, so it never keeps the agent from starting. */
export const readJournals = (files: StateFiles): Effect.Effect<ReadonlyMap<string, Journal>> =>
  Effect.gen(function* () {
    const names = yield* Effect.promise(() => files.fs.readdir(stateDir(files)).catch(() => [] as string[]));
    const found = new Map<string, Journal>();
    // In name order, so the sessions are taken up in the same order on every start.
    for (const name of [...names].sort()) {
      if (!name.endsWith(".json") || name.endsWith(".live.json")) continue;
      const sessionId = name.slice(0, -".json".length);
      const journal = yield* Effect.promise(() => readJsonFile(join(stateDir(files), name), Journal, files.fs));
      if (journal === undefined) yield* Effect.logWarning(`agent: ignoring unreadable state ${join(stateDir(files), name)}`);
      else found.set(sessionId, journal);
    }
    return found;
  });

const isEmpty = (journal: Journal) => journal.turn === undefined && journal.queue.length === 0 && journal.held !== true;

/**
 * Replaces the session's journal, durably: once this succeeds, a crash leaves it (or, for an empty one, its absence).
 * Fails when it cannot, so the change it records is not reported made.
 */
export const writeJournal = (files: StateFiles, sessionId: string, journal: Journal): Effect.Effect<void, StateWriteError> =>
  attempt(`write the state of session ${sessionId}`, async () => {
    if (isEmpty(journal)) return removeFile(journalPath(files, sessionId), { sync: true, fs: files.fs });
    await writeFileAtomic(journalPath(files, sessionId), `${JSON.stringify(journal)}\n`, { sync: true, fs: files.fs });
  });

export const readLive = (files: StateFiles, sessionId: string): Effect.Effect<LiveFile | undefined> =>
  Effect.promise(() => readJsonFile(livePath(files, sessionId), LiveFile, files.fs));

/** The running turn's output so far, unsynced: it is a convenience, which the log does not need. */
export const writeLive = (files: StateFiles, sessionId: string, live: LiveFile): Effect.Effect<void> =>
  bestEffort(`write the output of session ${sessionId}`, () => writeFileAtomic(livePath(files, sessionId), JSON.stringify(live), { fs: files.fs }));

export const removeLive = (files: StateFiles, sessionId: string): Effect.Effect<void> =>
  bestEffort(`remove the output of session ${sessionId}`, () => removeFile(livePath(files, sessionId), { fs: files.fs }));

/** Both files, for a deleted session. */
export const removeState = (files: StateFiles, sessionId: string): Effect.Effect<void> =>
  bestEffort(`remove the state of session ${sessionId}`, () =>
    Promise.all([removeFile(journalPath(files, sessionId), { sync: true, fs: files.fs }), removeFile(livePath(files, sessionId), { fs: files.fs })]),
  );
