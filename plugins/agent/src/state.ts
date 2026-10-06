import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Either, Schema } from "effect";
import { AssistantMessage, QueuedPrompt } from "@lemma/contracts";
import { writeFileAtomic } from "@lemma/contracts/fs";

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
});
export type Journal = typeof Journal.Type;

export const LiveFile = Schema.Struct({
  turnId: Schema.String,
  step: Schema.optional(Schema.Struct({ stepId: Schema.String, startedAt: Schema.Number, content: AssistantMessage.fields.content })),
  output: Schema.Array(Schema.Struct({ toolCallId: Schema.String, output: Schema.String, length: Schema.Number })),
});
export type LiveFile = typeof LiveFile.Type;

const decodeJournal = Schema.decodeUnknownEither(Schema.parseJson(Journal));
const decodeLive = Schema.decodeUnknownEither(Schema.parseJson(LiveFile));

export const stateDir = (home: string) => join(home, "agent");
const journalPath = (home: string, sessionId: string) => join(stateDir(home), `${sessionId}.json`);
const livePath = (home: string, sessionId: string) => join(stateDir(home), `${sessionId}.live.json`);

/** A write that fails (a full disk) costs durability, not the turn: it is logged, and the next write tries again. */
const bestEffort = (what: string, write: () => Promise<unknown>): Effect.Effect<void> =>
  Effect.tryPromise(write).pipe(
    Effect.asVoid,
    Effect.catchAll((error) => Effect.logWarning(`agent: could not ${what}: ${error.cause instanceof Error ? error.cause.message : String(error.cause)}`)),
  );

/** Every session's journal; one that cannot be read is skipped with a warning, so it never keeps the agent from starting. */
export const readJournals = (home: string): Effect.Effect<ReadonlyMap<string, Journal>> =>
  Effect.gen(function* () {
    const names = yield* Effect.promise(() => readdir(stateDir(home)).catch(() => [] as string[]));
    const found = new Map<string, Journal>();
    for (const name of names) {
      if (!name.endsWith(".json") || name.endsWith(".live.json")) continue;
      const sessionId = name.slice(0, -".json".length);
      const text = yield* Effect.promise(() => readFile(join(stateDir(home), name), "utf8").catch(() => undefined));
      const journal = text === undefined ? undefined : Either.getOrUndefined(decodeJournal(text));
      if (journal === undefined) yield* Effect.logWarning(`agent: ignoring unreadable state ${join(stateDir(home), name)}`);
      else found.set(sessionId, journal);
    }
    return found;
  });

const isEmpty = (journal: Journal) => journal.turn === undefined && journal.queue.length === 0 && journal.held !== true;

/** Replaces the session's journal, synced; an empty one is removed. */
export const writeJournal = (home: string, sessionId: string, journal: Journal): Effect.Effect<void> =>
  bestEffort(`write the state of session ${sessionId}`, async () => {
    if (isEmpty(journal)) {
      await rm(journalPath(home, sessionId), { force: true });
      return;
    }
    await writeFileAtomic(journalPath(home, sessionId), `${JSON.stringify(journal)}\n`, { sync: true });
  });

export const readLive = (home: string, sessionId: string): Effect.Effect<LiveFile | undefined> =>
  Effect.promise(() => readFile(livePath(home, sessionId), "utf8").catch(() => undefined)).pipe(
    Effect.map((text) => (text === undefined ? undefined : Either.getOrUndefined(decodeLive(text)))),
  );

export const writeLive = (home: string, sessionId: string, live: LiveFile): Effect.Effect<void> =>
  bestEffort(`write the output of session ${sessionId}`, async () => {
    await writeFileAtomic(livePath(home, sessionId), JSON.stringify(live));
  });

export const removeLive = (home: string, sessionId: string): Effect.Effect<void> =>
  bestEffort(`remove the output of session ${sessionId}`, () => rm(livePath(home, sessionId), { force: true }));

/** Both files, for a deleted session. */
export const removeState = (home: string, sessionId: string): Effect.Effect<void> =>
  bestEffort(`remove the state of session ${sessionId}`, () =>
    Promise.all([rm(journalPath(home, sessionId), { force: true }), rm(livePath(home, sessionId), { force: true })]),
  );
