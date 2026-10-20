import { realpath } from "node:fs/promises";
import { sep } from "node:path";
import { Effect, Queue, Schema } from "effect";
import type { Context } from "effect";
import { definePlugin } from "@lemma/core";
import { Agent, TurnEnded, TurnStarted } from "@lemma/agent";
import { SessionChanged, SessionRemoved, Sessions } from "@lemma/sessions";
import { Workspace } from "@lemma/workspace";

/** Whether `path` is `root` or a folder in it, by its real path, as git names `root`; a path gone is in nothing. */
const within = async (root: string, path: string): Promise<boolean> => {
  const real = await realpath(path).catch(() => undefined);
  return real !== undefined && (real === root || real.startsWith(`${root}${sep}`));
};

interface Deps {
  readonly workspace: Context.Service.Shape<typeof Workspace>;
  readonly sessions: Context.Service.Shape<typeof Sessions>;
  readonly agent: Context.Service.Shape<typeof Agent>;
}

/**
 * What tidying does with the worktree a thread's folder (`cwd`) is in. `tidy` removes it once nothing needs it: this
 * host made it (`Place.made`), every thread in it is archived or gone, no turn runs in it, and it holds nothing
 * uncommitted; its branch and commits stay. `restore` makes it again, where it was, when it is gone. Each says what it
 * did, for its caller's log.
 */
export const makeTidy = ({ workspace, sessions, agent }: Deps) => {
  const tidy = (cwd: string): Effect.Effect<string> =>
    Effect.gen(function* () {
      const [at] = yield* workspace.places([cwd]);
      if (at === undefined || !at.exists || !at.worktree || at.made !== true) return "not a worktree of ours";
      const status = yield* workspace.status(cwd);
      const root = status.git?.root;
      if (root === undefined) return "not a worktree of ours";
      if (status.git!.changes > 0) return `kept ${root}: it has uncommitted changes`;
      const all = yield* sessions.list();
      const running = new Set(yield* agent.running);
      const inIt = (yield* Effect.promise(() => Promise.all(all.map(async (session) => ((await within(root, session.cwd)) ? [session] : []))))).flat();
      if (inIt.some((session) => running.has(session.id))) return `kept ${root}: a turn runs in it`;
      if (inIt.some((session) => session.archived !== true)) return `kept ${root}: a thread in it is open`;
      yield* workspace.removeWorktree(cwd);
      return `removed ${root}`;
    }).pipe(Effect.catch((error) => Effect.succeed(`left ${cwd}: ${error.message}`)));

  const restore = (cwd: string): Effect.Effect<string> =>
    Effect.gen(function* () {
      const [at] = yield* workspace.places([cwd]);
      if (at === undefined || at.exists || !at.worktree) return "nothing to restore";
      const status = yield* workspace.restoreWorktree(cwd);
      return `restored ${status.git?.root ?? cwd}`;
    }).pipe(Effect.catch((error) => Effect.succeed(`could not restore ${cwd}: ${error.message}`)));

  return { tidy, restore };
};

const TidyConfig = Schema.Struct({
  removeOnArchive: Schema.Boolean.pipe(Schema.withDecodingDefaultType(Effect.sync(() => true))).annotate({
    title: "Remove worktrees when archived",
    description:
      "A worktree Lemma made goes once its last thread is archived or deleted, if nothing in it is uncommitted; its branch stays. Off: they stay until removed by hand.",
  }),
});

/**
 * Keeps worktrees from piling up: removes one this host made once its last thread is archived (or deleted), unless
 * `removeOnArchive` is off, and makes it again when one of its threads is unarchived. Hears archiving from any
 * client, so the web app, the `lemma` command, and a script are alike.
 */
export default definePlugin({
  id: "workspace.tidy",
  version: "0.1.0",
  config: TidyConfig,
  requires: { workspace: Workspace, sessions: Sessions, agent: Agent },
  setup: function* (deps, owner) {
    const { tidy, restore } = makeTidy(deps);
    const removing = owner.config.removeOnArchive;
    // The observers only note what changed; the git work is done one job at a time, after them, so a slow removal never
    // holds up the events, nor two jobs on one worktree race.
    const jobs = yield* Queue.unbounded<{ readonly kind: "tidy" | "restore"; readonly cwd: string }>();
    /** Each thread's folder and whether it is archived, to tell archiving and unarchiving from its other changes. */
    const known = new Map<string, { readonly cwd: string; readonly archived: boolean }>();
    /** Threads with a turn running, and those of them archived meanwhile, whose worktree waits for the turn to end. */
    const turning = new Set<string>();
    const waiting = new Set<string>();
    yield* owner.observe(
      SessionChanged,
      ({ info }) =>
        Effect.sync(() => {
          const before = known.get(info.id);
          const archived = info.archived === true;
          known.set(info.id, { cwd: info.cwd, archived });
          if (before === undefined || before.archived === archived) return;
          if (!archived) {
            waiting.delete(info.id);
            Queue.offerUnsafe(jobs, { kind: "restore", cwd: info.cwd });
          } else if (removing) {
            if (turning.has(info.id)) waiting.add(info.id);
            Queue.offerUnsafe(jobs, { kind: "tidy", cwd: info.cwd });
          }
        }),
      { buffer: 1024 },
    );
    yield* owner.observe(
      SessionRemoved,
      ({ sessionId }) =>
        Effect.sync(() => {
          const before = known.get(sessionId);
          known.delete(sessionId);
          turning.delete(sessionId);
          waiting.delete(sessionId);
          if (before !== undefined && removing) Queue.offerUnsafe(jobs, { kind: "tidy", cwd: before.cwd });
        }),
      { buffer: 1024 },
    );
    // A thread archived while its turn ran is tidied once the turn ends; not one prompted after it was archived (its
    // worktree made again to work in), whose turn ending is no reason to remove it.
    yield* owner.observe(TurnStarted, ({ sessionId }) => Effect.sync(() => void turning.add(sessionId)), { buffer: 1024 });
    yield* owner.observe(
      TurnEnded,
      ({ sessionId }) =>
        Effect.sync(() => {
          turning.delete(sessionId);
          const at = known.get(sessionId);
          if (waiting.delete(sessionId) && at !== undefined) Queue.offerUnsafe(jobs, { kind: "tidy", cwd: at.cwd });
        }),
      { buffer: 1024 },
    );
    for (const info of yield* deps.sessions.list().pipe(Effect.orElseSucceed(() => []))) {
      if (!known.has(info.id)) known.set(info.id, { cwd: info.cwd, archived: info.archived === true });
    }
    for (const sessionId of yield* deps.agent.running) turning.add(sessionId);
    yield* owner.background(
      "tidy worktrees",
      Effect.forever(
        Effect.flatMap(Queue.take(jobs), (job) =>
          Effect.flatMap(job.kind === "tidy" ? tidy(job.cwd) : restore(job.cwd), (outcome) => Effect.logDebug(`workspace.tidy: ${outcome}`)),
        ),
      ),
    );
  },
});
