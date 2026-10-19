import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { Schema } from "effect";
import { ToolResult } from "@lemma/tools";
import type { Tool } from "@lemma/tools";
import type { Jobs } from "./jobs.ts";
import { OutputAccumulator, ScriptOutput } from "./output.ts";
import { exitCodeOf, killTree, spawnShell, waitForExit } from "./process.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@lemma/tools";
import type { Truncation } from "@lemma/tools";

const foreground = {
  command: Schema.String.annotate({ description: "Bash command to execute" }),
  timeout: Schema.optional(Schema.Number.annotate({ description: "Timeout in seconds (optional; the tool description names the default)" })),
};
/** The input of a `bash` with no jobs, which runs nothing in the background: it is not offered `background`. */
const ForegroundInput = Schema.Struct(foreground);
export const BashInput = Schema.Struct({
  ...foreground,
  background: Schema.optional(
    Schema.Boolean.annotate({
      description: "Run it without waiting for it: for servers, watchers, and long builds. You get its pid and output file at once, and are told when it exits",
    }),
  ),
});
export type BashInput = typeof BashInput.Type;

/** What a script's call resolves to: on a non-zero exit, a timeout, or an abort too. */
export const BashOutput = Schema.Struct({
  output: Schema.String.annotate({ description: "stdout and stderr combined: whole up to 1 MiB, else its first and last 512 KiB around a marker" }),
  exitCode: Schema.NullOr(Schema.Number).annotate({ description: "null when the command did not finish (timeout, abort)" }),
  truncated: Schema.Boolean.annotate({ description: "Whether output left out its middle" }),
  fullOutputPath: Schema.optional(Schema.String.annotate({ description: "The whole output, when it was longer than the model sees" })),
  timedOut: Schema.optional(Schema.Boolean),
  aborted: Schema.optional(Schema.Boolean),
  wallTimeSeconds: Schema.Number,
  background: Schema.optional(
    Schema.Struct({ id: Schema.String, pid: Schema.Number }).annotate({
      description: "Run in the background: its job and pid; the model is told when it exits, and `fullOutputPath` has its output as it is written",
    }),
  ),
});
export type BashOutput = typeof BashOutput.Type;

export interface BashDetails {
  /** Null when the command did not finish (timeout, abort), or runs on in the background. */
  readonly exitCode: number | null;
  readonly timedOut?: boolean;
  readonly aborted?: boolean;
  readonly truncation?: Truncation;
  /** The complete output, when it was truncated, or for a background command, as it is written. */
  readonly fullOutputPath?: string;
  /** A background command: it runs on, as job `id` (`Job.id`) with `pid`, and its exit is told to the model. */
  readonly background?: { readonly id: string; readonly pid: number };
}

/** setTimeout's ceiling. */
const MAX_TIMEOUT_MS = 2_147_483_647;
/** Seconds a command runs when the model names no timeout: long enough for a build, short enough that a server started in the foreground does not hold the turn forever. */
export const DEFAULT_BASH_TIMEOUT = 600;

/**
 * The `bash` tool; a command without a timeout of its own stops after `defaultTimeout` seconds (0: never). With `jobs`
 * (the plugin's), it runs commands in the background too; without, it is not offered `background`, and is told to put
 * a long-lived process in the background itself.
 */
export const makeBashTool = (defaultTimeout: number = DEFAULT_BASH_TIMEOUT, jobs?: Jobs): Tool<BashInput> => ({
  name: "bash",
  description: `Execute a bash command in the current working directory. Returns stdout and stderr. Prefer the dedicated tools for reading, searching, and editing files when they are offered. Long output keeps its first and last ${DEFAULT_MAX_LINES / 2} lines or ${DEFAULT_MAX_BYTES / 2048}KB (whichever is hit first), and the full output is saved to a temp file. Optionally provide a timeout in seconds${
    defaultTimeout > 0 ? `; without one, the command is stopped after ${defaultTimeout} seconds` : ""
  }.${
    jobs === undefined
      ? " Run long-lived processes such as servers in the background (with nohup and &, redirecting their output to a file)."
      : " Set background for a long-lived process (a server, a watcher, a long build): it runs on, and you are told when it exits, with its output's start and end; read its output file to check on it meanwhile, and stop it with `kill -- -<pid>`. A timeout you give still applies to it."
  }`,
  // Its decoded input is a `BashInput` with no `background`.
  input: jobs === undefined ? (ForegroundInput as unknown as typeof BashInput) : BashInput,
  output: BashOutput,
  execute: async ({ command, timeout: requested, background }, { sessionId, toolCallId, cwd, signal, update }) => {
    const started = performance.now();
    const timeout = requested ?? (defaultTimeout > 0 && background !== true ? defaultTimeout : undefined);
    if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) throw new Error("Invalid timeout: must be a finite number of seconds");
    if (timeout !== undefined && timeout * 1000 > MAX_TIMEOUT_MS) throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_MS / 1000} seconds`);
    if (signal.aborted) throw new Error("Command aborted");
    try {
      await access(cwd, fsConstants.F_OK);
    } catch {
      throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
    }
    if (background === true) {
      if (jobs === undefined) throw new Error("This bash runs no command in the background: run it in the foreground");
      if (signal.aborted) throw new Error("Command aborted");
      const job = await jobs.start({ sessionId, toolCallId, command, cwd, ...(timeout === undefined ? {} : { timeout }) });
      const output = job.outputPath === undefined ? "Its output could not be saved." : `Its output goes to ${job.outputPath}.`;
      const details: BashDetails = {
        exitCode: null,
        background: { id: job.id, pid: job.pid },
        ...(job.outputPath === undefined ? {} : { fullOutputPath: job.outputPath }),
      };
      const structured: BashOutput = {
        output: "",
        exitCode: null,
        truncated: false,
        ...(job.outputPath === undefined ? {} : { fullOutputPath: job.outputPath }),
        wallTimeSeconds: Math.round(performance.now() - started) / 1000,
        background: { id: job.id, pid: job.pid },
      };
      return new ToolResult({
        content: [
          {
            type: "text",
            text: `Started in the background as job ${job.id}, pid ${job.pid}. ${output} You will be told when it exits; stop it with \`kill -- -${job.pid}\`.`,
          },
        ],
        details,
        structured,
      });
    }
    // Recheck after the lookup; from here to installing the abort listener runs synchronously.
    if (signal.aborted) throw new Error("Command aborted");

    const output = new OutputAccumulator("lemma-bash");
    const script = new ScriptOutput();
    const child = spawnShell(command, cwd);
    // Streaming decode: a character split across chunks is held until its last byte arrives.
    const live = new TextDecoder();
    const onData = (data: Buffer) => {
      output.append(data);
      script.append(data);
      update?.(live.decode(data, { stream: true }));
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    let timedOut = false;
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      killTree(child);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const timer =
      timeout === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            killTree(child);
          }, timeout * 1000);

    let exitCode: number | null;
    try {
      exitCode = exitCodeOf(child, await waitForExit(child));
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      output.finish();
    }
    const snapshot = output.snapshot();
    await output.close();

    const { truncation, fullOutputPath } = snapshot;
    const body = output.shown(snapshot, fullOutputPath === undefined ? "Full output could not be saved" : `Full output: ${fullOutputPath}`);
    const status = aborted
      ? "Command aborted"
      : timedOut
        ? `Command timed out after ${timeout} seconds`
        : exitCode === null
          ? "Command terminated without an exit code"
          : exitCode !== 0
            ? `Command exited with code ${exitCode}`
            : undefined;
    const details: BashDetails = {
      exitCode: aborted || timedOut ? null : exitCode,
      ...(timedOut ? { timedOut } : {}),
      ...(aborted ? { aborted } : {}),
      ...(truncation.truncated ? { truncation } : {}),
      ...(fullOutputPath === undefined ? {} : { fullOutputPath }),
    };
    const textBody = status === undefined ? body || "(no output)" : `${body ? `${body}\n\n` : ""}${status}`;
    const read = script.read();
    const structured: BashOutput = {
      output: read.output,
      exitCode: details.exitCode,
      truncated: read.truncated,
      ...(fullOutputPath === undefined ? {} : { fullOutputPath }),
      ...(timedOut ? { timedOut } : {}),
      ...(aborted ? { aborted } : {}),
      wallTimeSeconds: Math.round(performance.now() - started) / 1000,
    };
    return new ToolResult({ content: [{ type: "text", text: textBody }], ...(status === undefined ? {} : { isError: true }), details, structured });
  },
});

export const bashTool: Tool<BashInput> = makeBashTool();
