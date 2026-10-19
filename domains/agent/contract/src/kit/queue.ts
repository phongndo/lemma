import { Deferred, Effect, Semaphore } from "effect";
import { assert } from "@lemma/core";
import { AgentError } from "../agent.ts";
import type { QueuedPrompt } from "../agent.ts";
import { removeState, writeJournal } from "./state.ts";
import type { Journal, StateFiles } from "./state.ts";
import type { Ended } from "./turn.ts";

/*
 * Each session's queue and turn as the agent keeps them, and as its journal records them: the journal is written
 * whenever they change, and a change the log will not record is made only once the journal has it (`recorded`).
 * What a prompt sent to a session comes to (`admission`) is read from them.
 */

/**
 * Queue revisions each instance of the agent has to number with: an instance's start from its number (`nextInstance`)
 * times this, so they pass every earlier instance's, whatever the clock says. Below 2^53 for two million starts.
 */
export const REVISIONS_PER_INSTANCE = 2 ** 32;

/** Prompts a session's queue holds at most: one past it fails `Busy`, as a turn's queue is for a person's prompts. */
export const MAX_QUEUED = 256;

/**
 * Withdrawn request ids a session remembers, the latest: a client that never heard its prompt was withdrawn (it lost
 * its connection) sends it again with the same id when it reconnects, and is refused rather than have it placed.
 */
export const WITHDRAWN_KEPT = 64;

/** A submitted prompt, queued or placed in a turn. */
export interface Item {
  readonly prompt: QueuedPrompt;
  /** Settles when the turn that placed it ends; fails `Retracted` when it is taken out of the queue first. */
  readonly done: Deferred.Deferred<void, AgentError>;
  /** A queued steer the running turn is placing: it can no longer be withdrawn. */
  placing: boolean;
}

/** A prompt the journal had, as an item no call waits on yet. */
export const itemOf = (prompt: QueuedPrompt): Item => ({ prompt, done: Deferred.makeUnsafe<void, AgentError>(), placing: false });

/** What the journal records of a running turn, and what admitting a prompt reads of it. */
export interface QueuedTurn {
  readonly turnId: string;
  /** What it was started with; kept in the journal until it ends, so a turn cut off before logging them still has them. */
  readonly prompts: readonly QueuedPrompt[];
  readonly cancelling: boolean;
  readonly marked: boolean;
  /** It resumes only to close so. */
  readonly closing?: Ended | undefined;
  /** The prompts placed in it, by request id. */
  readonly items: ReadonlyMap<string, Item>;
  /** Settles when the turn ends, however it ends. */
  readonly ended: Deferred.Deferred<void, AgentError>;
}

/** A turn the last instance left open, not running: it resumes once its session is taken up. */
export interface Suspended {
  readonly turnId: string;
  readonly prompts: readonly Item[];
  readonly marked: boolean;
  /** `cancel` was asked for: it resumes only to close as cancelled. */
  cancelling: boolean;
  /** It ended so, but its `turn-end` did not reach the log: it resumes only to close so. */
  readonly closing?: Ended;
}

export interface SessionState<T extends QueuedTurn> {
  turn: T | undefined;
  /** Never set with `turn`. */
  suspended: Suspended | undefined;
  /**
   * Restored from the journal the last instance left, and not taken up yet: its suspended turn, if any, waits, and so
   * does its queue.
   */
  restored: boolean;
  /** Restored, and its queue not yet checked against its log: nothing reads or changes the queue until it is. */
  unchecked: boolean;
  queue: Item[];
  /**
   * Counts from this instance's `base`, past every revision an earlier instance could have told, so it keeps
   * `QueueChanged`'s promise across restarts.
   */
  revision: number;
  /** The last turn failed or was cancelled: queued prompts wait for the next one rather than starting a turn. */
  held: boolean;
  /**
   * The last turn this instance saw end ran to its end (`done` or `max-steps`), so a plugin's prompt may start the next
   * (`PromptOptions.source`). Not journaled: an instance that has seen none lets a plugin's prompt wait.
   */
  ranToEnd: boolean;
  /** Request ids withdrawn from the queue, the latest last, at most `WITHDRAWN_KEPT` (journaled). */
  withdrawn: readonly string[];
}

/** What the session's journal says of it: its running turn, or the suspended one, as the last instance left it. */
export const journalOf = <T extends QueuedTurn>(state: SessionState<T>): Journal => {
  const turn = state.turn ?? (state.suspended === undefined ? undefined : { ...state.suspended, prompts: state.suspended.prompts.map((item) => item.prompt) });
  return {
    ...(turn === undefined
      ? {}
      : {
          turn: {
            turnId: turn.turnId,
            prompts: turn.prompts,
            ...(turn.cancelling ? { cancelling: true } : {}),
            ...(turn.marked ? { marked: true } : {}),
            ...(turn.closing === undefined ? {} : { closing: turn.closing }),
          },
        }),
    queue: state.queue.map((item) => item.prompt),
    ...(state.held && state.queue.length > 0 ? { held: true } : {}),
    ...(state.withdrawn.length === 0 ? {} : { withdrawn: state.withdrawn }),
  };
};

/**
 * What admitting a prompt comes to, as the session has it now: one sent before (`requestId`) is found queued (and
 * starts the queue, held after a failed or cancelled turn, when no turn runs), placed in the running turn, or placed
 * in a turn the log has (`placedIn` names it: awaited while it runs); a new one is queued behind the running turn, or
 * refused (`whenBusy: "reject"`, or a full queue), or starts a turn. A withdrawn one is refused before this is asked.
 */
export type Admission =
  | { readonly kind: "queued"; readonly item: Item; readonly start: boolean }
  | { readonly kind: "placed"; readonly done: Deferred.Deferred<void, AgentError> }
  | { readonly kind: "logged"; readonly ended: Deferred.Deferred<void, AgentError> | undefined }
  | { readonly kind: "busy"; readonly message: string }
  | { readonly kind: "queue" }
  | { readonly kind: "start" };

export const admission = <T extends QueuedTurn>(
  sessionId: string,
  state: SessionState<T>,
  prompt: { readonly requestId?: string | undefined; readonly whenBusy: "reject" | QueuedPrompt["mode"] },
  placedIn: ReadonlyMap<string, string | undefined>,
): Admission => {
  const { requestId } = prompt;
  if (requestId !== undefined) {
    const queued = state.queue.find((item) => item.prompt.requestId === requestId);
    if (queued !== undefined) return { kind: "queued", item: queued, start: state.turn === undefined };
    const placed = state.turn?.items.get(requestId);
    if (placed !== undefined) return { kind: "placed", done: placed.done };
    if (placedIn.has(requestId)) {
      const running = state.turn;
      return { kind: "logged", ended: running !== undefined && placedIn.get(requestId) === running.turnId ? running.ended : undefined };
    }
  }
  if (state.turn === undefined) return { kind: "start" };
  if (prompt.whenBusy === "reject") return { kind: "busy", message: `Session ${sessionId} already has a turn in progress` };
  if (state.queue.length >= MAX_QUEUED) return { kind: "busy", message: `Session ${sessionId} has ${MAX_QUEUED} prompts queued already` };
  return { kind: "queue" };
};

/**
 * Every session's state, from this instance's queue revision `base`, journaled in `files`. Changes to a state are the
 * caller's to serialize (the agent's `admit`); journal writes are serialized here, so the last one written is the
 * latest state.
 */
export const makeQueues = <T extends QueuedTurn>(files: StateFiles, base: number) => {
  const states = new Map<string, SessionState<T>>();
  const writing = Semaphore.makeUnsafe(1);

  /** The session's state, made empty when it has none. */
  const of = (sessionId: string): SessionState<T> => {
    let state = states.get(sessionId);
    if (state === undefined) {
      state = {
        turn: undefined,
        suspended: undefined,
        restored: false,
        unchecked: false,
        queue: [],
        revision: base,
        held: false,
        ranToEnd: false,
        withdrawn: [],
      };
      states.set(sessionId, state);
    }
    return state;
  };

  /** Replaces the queue, moving its revision on with it, so a view never pairs a new queue with an old revision. */
  const setQueue = (state: SessionState<T>, queue: Item[]): Effect.Effect<void> =>
    Effect.sync(() => {
      state.queue = queue;
      state.revision++;
      assert(state.revision < base + REVISIONS_PER_INSTANCE, `session revisions past this instance's room`);
    });

  /**
   * Records the session's state in its journal, durably. Fails `Io` when it cannot (see `AgentError`): its caller
   * then undoes the change it records, as a crash would lose it (`recorded`).
   */
  const persist = (sessionId: string): Effect.Effect<void, AgentError> =>
    writing
      .withPermits(1)(Effect.suspend(() => writeJournal(files, sessionId, journalOf(of(sessionId)))))
      .pipe(Effect.mapError((error) => new AgentError({ sessionId, reason: "Io", message: `Session ${sessionId}: ${error.message}`, cause: error })));

  /**
   * As `persist`, for a change made already, which a failed write only leaves less durable: the log, the source of
   * truth, says what happened (a turn's end, a steer placed), and the journal is checked against it on the next start.
   */
  const persistOrWarn = (sessionId: string): Effect.Effect<void> =>
    persist(sessionId).pipe(Effect.catch((error) => Effect.logWarning(`agent: ${error.message}`)));

  /**
   * Makes `change` to the session's state and records it in the journal, for a change the log will not record (a turn
   * starting, a prompt queued, withdrawn, or promoted): made once the journal has it. When the journal cannot be
   * written, what `change` changed of what the journal records (the turn, the suspended one, the queue, `held`,
   * `withdrawn`, and whether the session is `restored`) is put back, the queue's revision moving on, and this fails
   * `Io`; a `change` that fails puts it back too.
   */
  const recorded = <A, E, R>(sessionId: string, change: (state: SessionState<T>) => Effect.Effect<A, E, R>): Effect.Effect<A, E | AgentError, R> =>
    Effect.suspend(() => {
      const state = of(sessionId);
      const { turn, suspended, restored, queue, held, withdrawn } = state;
      const putBack = Effect.suspend(() => {
        state.turn = turn;
        state.suspended = suspended;
        state.restored = restored;
        state.held = held;
        state.withdrawn = withdrawn;
        return state.queue === queue ? Effect.void : setQueue(state, queue);
      });
      return Effect.tap(change(state), () => persist(sessionId)).pipe(Effect.tapError(() => putBack));
    });

  /** The session's state goes (it was deleted), and is returned; its files go with `removeFiles`. */
  const drop = (sessionId: string): SessionState<T> | undefined => {
    const state = states.get(sessionId);
    states.delete(sessionId);
    return state;
  };
  /** The session's journal and live files go, after a journal write under way, which would bring the file back. */
  const removeFiles = (sessionId: string): Effect.Effect<void> => writing.withPermits(1)(removeState(files, sessionId));

  /** Each journal the last instance left becomes its session's state, as it was, its turn suspended. */
  const restore = (journals: ReadonlyMap<string, Journal>): void => {
    for (const [sessionId, journal] of journals) {
      const state = of(sessionId);
      // One that keeps only what was withdrawn has nothing to take up, nor a queue to check against its log.
      const waiting = journal.turn !== undefined || journal.queue.length > 0;
      state.restored = waiting;
      state.unchecked = waiting;
      state.queue = journal.queue.map(itemOf);
      state.held = journal.held === true;
      state.withdrawn = journal.withdrawn ?? [];
      if (journal.turn !== undefined) {
        const { closing } = journal.turn;
        state.suspended = {
          turnId: journal.turn.turnId,
          // One that ended keeps none, though an older agent's journal may list them.
          prompts: closing === undefined ? journal.turn.prompts.map(itemOf) : [],
          marked: journal.turn.marked === true,
          cancelling: journal.turn.cancelling === true,
          ...(closing === undefined ? {} : { closing: { reason: closing.reason, ...(closing.error === undefined ? {} : { error: closing.error }) } }),
        };
      }
    }
  };

  return {
    get: (sessionId: string): SessionState<T> | undefined => states.get(sessionId),
    of,
    /** Every session with a state, and its state. */
    all: (): IterableIterator<[string, SessionState<T>]> => states.entries(),
    setQueue,
    persist,
    persistOrWarn,
    recorded,
    drop,
    removeFiles,
    restore,
  };
};
