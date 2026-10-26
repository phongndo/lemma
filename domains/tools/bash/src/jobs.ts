import { randomBytes } from "node:crypto";
import { OutputAccumulator } from "./output.ts";
import { exitCodeOf, killTree, spawnShell, waitForExit } from "./process.ts";

/** A command the model started in the background, while it runs. */
export interface Job {
  /**
   * Its own id, which no other job of the session has, ever: its exit is told once for it (`ModelNotice.id`), and a
   * provider may give two calls one id.
   */
  readonly id: string;
  /** The tool call that started it. */
  readonly toolCallId: string;
  readonly sessionId: string;
  readonly command: string;
  readonly pid: number;
  /** Its whole output, as it is written; absent when no file could be made. */
  readonly outputPath?: string;
  /** Epoch milliseconds. */
  readonly startedAt: number;
}

/** A background command that ended on its own (or by its timeout), and what the model is told of it. */
export interface JobExit {
  readonly job: Job;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly text: string;
  /** How it ended, in a line, for a transcript to show in place of `text`. */
  readonly display: string;
}

/** What a background command's exit notice keeps of its output: much less than a result, as it arrives unasked. */
const NOTICE_LIMITS = { maxLines: 200, maxBytes: 16 * 1024 } as const;

/** The background commands of every session, with what to do when one exits. */
export interface Jobs {
  /**
   * Starts `command` in `cwd` for the session, its output to a file from its first byte; stopped after `timeout`
   * seconds when one is given. Fails, with the reason, when it could not be started (no `bash`, no `cwd`, no processes
   * left).
   */
  readonly start: (run: {
    readonly sessionId: string;
    readonly toolCallId: string;
    readonly command: string;
    readonly cwd: string;
    readonly timeout?: number;
  }) => Promise<Job>;
  /** The session's jobs still running, oldest first. */
  readonly running: (sessionId: string) => readonly Job[];
  /** Kills the session's jobs (every session's, without one), with no exit told: the session or the plugin is going. */
  readonly stop: (sessionId?: string) => void;
  /**
   * Hears each exit from now on, until the returned detach: the latest listener attached hears them. Once the last one
   * detaches, every job still running is stopped. So a plugin's replacement, which attaches before the instance it
   * replaces detaches, keeps them running; one that fails to start leaves them with the instance still serving.
   */
  readonly attach: (exited: (exit: JobExit) => void) => () => void;
}

interface Running {
  readonly job: Job;
  readonly kill: () => void;
  /** Killed by `stop`: its exit is not told. */
  stopped: boolean;
}

const seconds = (ms: number) => (ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`);

const howItEnded = (exitCode: number | null, timedOut: boolean, timeout: number | undefined) =>
  timedOut ? `timed out after ${timeout} seconds, and was stopped` : exitCode === null ? "ended without an exit code" : `exited with code ${exitCode}`;

/** A background command's end in a line: what a transcript shows of its notice. */
export const exitLine = (job: Job, exitCode: number | null, timedOut: boolean, timeout: number | undefined): string => {
  const command = job.command.replace(/\s+/g, " ").trim();
  return `Background job ${job.id} (${command.length > 60 ? `${command.slice(0, 59)}…` : command}) ${howItEnded(exitCode, timedOut, timeout)}`;
};

/** What the model is told when a background command exits: how it ended, and both ends of its output. */
export function exitText(job: Job, output: OutputAccumulator, exitCode: number | null, timedOut: boolean, timeout: number | undefined, now: number): string {
  const snapshot = output.snapshot();
  const full = job.outputPath === undefined ? "Its output could not be saved." : `Full output: ${job.outputPath}`;
  const body = output.shown(snapshot, full);
  const how = howItEnded(exitCode, timedOut, timeout);
  return [
    `<background-job id="${job.id}" pid="${job.pid}">`,
    `From Lemma, not the user: the background command \`${job.command}\` ${how}, after ${seconds(now - job.startedAt)}.`,
    body.trim() === "" ? "(no output)" : body.replace(/\n+$/, ""),
    ...(snapshot.ends === undefined && job.outputPath !== undefined ? [full] : []),
    "</background-job>",
  ].join("\n");
}

/** A job's id: random, so that it is the session's alone through restarts too, whose log keeps the ids told. */
const randomJobId = () => `job-${randomBytes(6).toString("hex")}`;

/**
 * The background commands, each exit told to the listener attached last. `now` is epoch milliseconds; `newId` gives
 * each job its id; `idle` runs once the last listener detaches, after the commands still running are stopped.
 */
export function makeJobs(options: { readonly now?: () => number; readonly newId?: () => string; readonly idle?: () => void } = {}): Jobs {
  const { now = Date.now, newId = randomJobId, idle } = options;
  const bySession = new Map<string, Map<string, Running>>();
  const listeners: ((exit: JobExit) => void)[] = [];
  const exited = (exit: JobExit) => listeners.at(-1)?.(exit);

  const start: Jobs["start"] = async ({ sessionId, toolCallId, command, cwd, timeout }) => {
    const child = spawnShell(command, cwd);
    if (child.pid === undefined) {
      // Not started: the reason comes as its `error`, on the next tick.
      const error = await new Promise<Error>((resolve) => child.once("error", resolve));
      throw new Error(`The command could not be started: ${error.message}`);
    }
    const output = new OutputAccumulator("lemma-bash-job", { ...NOTICE_LIMITS, spill: "always" });
    const id = newId();
    const job: Job = {
      id,
      toolCallId,
      sessionId,
      command,
      pid: child.pid,
      ...(output.path === undefined ? {} : { outputPath: output.path }),
      startedAt: now(),
    };
    const running: Running = { job, kill: () => killTree(child), stopped: false };
    const session = bySession.get(sessionId) ?? new Map<string, Running>();
    bySession.set(sessionId, session);
    session.set(id, running);
    const onData = (data: Buffer) => output.append(data);
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    let timedOut = false;
    const timer =
      timeout === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            killTree(child);
          }, timeout * 1000);
    void (async () => {
      let exitCode: number | null = null;
      try {
        exitCode = exitCodeOf(child, await waitForExit(child));
      } catch {
        // Spawning failed: told as an end without a code.
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        output.finish();
      }
      const text = exitText(job, output, timedOut ? null : exitCode, timedOut, timeout, now());
      await output.close().catch(() => undefined);
      session.delete(id);
      if (session.size === 0 && bySession.get(sessionId) === session) bySession.delete(sessionId);
      const code = timedOut ? null : exitCode;
      if (!running.stopped) exited({ job, exitCode: code, timedOut, text, display: exitLine(job, code, timedOut, timeout) });
    })();
    return job;
  };

  const stop: Jobs["stop"] = (sessionId) => {
    const sessions = sessionId === undefined ? [...bySession.values()] : [bySession.get(sessionId)].filter((session) => session !== undefined);
    for (const session of sessions) {
      for (const running of session.values()) {
        running.stopped = true;
        running.kill();
      }
    }
  };

  return {
    start,
    running: (sessionId) => [...(bySession.get(sessionId)?.values() ?? [])].map((running) => running.job),
    stop,
    attach: (listener) => {
      const attached = (exit: JobExit) => listener(exit);
      listeners.push(attached);
      return () => {
        const at = listeners.indexOf(attached);
        if (at === -1) return;
        listeners.splice(at, 1);
        if (listeners.length > 0) return;
        stop();
        idle?.();
      };
    },
  };
}

/** Each host's background commands in this process, by its core's `Events`. */
const hosts = new WeakMap<object, Jobs>();

/**
 * One host's background commands, which each instance of its plugin attaches to: kept outside the instance, so a
 * reload (a config change) does not stop what runs. Keyed by `host`, its core's `Events`, which is one object for the
 * core's life and another core's is another: a replacement finds what its predecessor started, and two hosts in one
 * process (tests, an embedding application) each hear their own commands' exits, and stop theirs alone. Gone once the
 * last instance detaches.
 */
export function hostJobs(host: object): Jobs {
  let jobs = hosts.get(host);
  if (jobs === undefined) {
    jobs = makeJobs({ idle: () => hosts.delete(host) });
    hosts.set(host, jobs);
  }
  return jobs;
}

/** The prompt section listing a session's running background commands: undefined (no section) when none run. */
export function jobsSection(jobs: readonly Job[]): string | undefined {
  if (jobs.length === 0) return undefined;
  return [
    "<background_jobs>",
    "Commands you started with `bash`'s background option that are still running; you are told when each exits.",
    ...jobs.map((job) => `- ${job.id}: \`${job.command}\` (pid ${job.pid}${job.outputPath === undefined ? "" : `, output in ${job.outputPath}`})`),
    "</background_jobs>",
  ].join("\n");
}
