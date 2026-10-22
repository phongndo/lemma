import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { Option, Schema } from "effect";
import { TurnOptions, WhenBusy } from "@lemma/agent";

/**
 * An agent working in the background (`delegate` with `background`): which thread it reports to, the call that started
 * it, and what it is called. Kept as a file under `<home>/delegate/agents` from its start until the thread it reports
 * to has heard how it finished, so a reload or a restart picks it up again and the thread is still told: the agent's
 * own turn resumes on its own, and only the waiting on it is this plugin's.
 */
export const Job = Schema.Struct({
  /** The thread it reports to: its delegating call's session. */
  parent: Schema.String,
  /** The agent's session. */
  child: Schema.String,
  /** What it was asked, and how: what placing its prompt again sends, should the host have stopped before it was placed. */
  prompt: Schema.String,
  options: Schema.optional(TurnOptions),
  whenBusy: Schema.optional(WhenBusy),
  /** Its prompt's request id (`requestIdOf`), by which waiting again finds the turn it started, and never places it twice. */
  requestId: Schema.String,
  /** How deep in delegations the agent is (1 for one a person's thread started): the slots it waits for. */
  depth: Schema.Number,
  /** The notice's id (`noticeIdOf`): the thread is told once per call. */
  noticeId: Schema.String,
  title: Schema.String,
  /** A message to an agent already started: it takes no slot, and its thread stays whatever its turn does. */
  followUp: Schema.optional(Schema.Boolean),
  /**
   * The agent's last seq when its call made it, holding only what the call put there (its title, a fork's copy): a
   * prompt refused while it still does leaves it nothing worth keeping, so it goes. Absent for one the call found.
   */
  emptyAt: Schema.optional(Schema.Number),
});
export type Job = typeof Job.Type;

const decode = Schema.decodeUnknownOption(Job);

/** The files of the agents working in the background, one per job, by a hash of the thread and the notice it owes. */
export const jobFiles = (dir: string) => {
  const file = (job: Pick<Job, "parent" | "noticeId">) =>
    path.join(dir, `${createHash("sha256").update(`${job.parent}\0${job.noticeId}`).digest("hex").slice(0, 32)}.json`);
  return {
    /** Kept before the call answers, readable only by the user. Best effort: without it, a restart forgets to tell the thread. */
    save: (job: Job): Promise<void> =>
      fs
        .mkdir(dir, { recursive: true, mode: 0o700 })
        .then(() => fs.writeFile(file(job), `${JSON.stringify(job)}\n`, { mode: 0o600 }))
        .catch(() => {}),
    remove: (job: Pick<Job, "parent" | "noticeId">): Promise<void> => fs.rm(file(job), { force: true }).catch(() => {}),
    /** Every job kept, those that do not read left out. */
    all: async (): Promise<Job[]> => {
      const names = await fs.readdir(dir).catch(() => [] as string[]);
      const read = await Promise.all(
        names
          .filter((name) => name.endsWith(".json"))
          .map(async (name) => {
            const text = await fs.readFile(path.join(dir, name), "utf8").catch(() => undefined);
            if (text === undefined) return undefined;
            try {
              return Option.getOrUndefined(decode(JSON.parse(text)));
            } catch {
              return undefined;
            }
          }),
      );
      return read.filter((job) => job !== undefined);
    },
  };
};
export type JobFiles = ReturnType<typeof jobFiles>;

/** The prompt section naming a thread's agents still at work in the background: none while there are none. */
export const workingSection = (jobs: readonly Job[]): string | undefined =>
  jobs.length === 0
    ? undefined
    : [
        "Agents you started in the background that are still working; you are told when each finishes, so do not wait or poll for them:",
        ...jobs.map((job) => `- "${job.title}" (session ${job.child})`),
      ].join("\n");
