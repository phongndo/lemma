import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { Schema } from "effect";
import { ToolResult } from "@lemma/contracts";
import type { Tool } from "@lemma/contracts";
import { OutputAccumulator } from "./output.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "./truncate.ts";
import type { Truncation } from "./truncate.ts";

export const BashInput = Schema.Struct({
  command: Schema.String.annotations({ description: "Bash command to execute" }),
  timeout: Schema.optional(Schema.Number.annotations({ description: "Timeout in seconds (optional; the tool description names the default)" })),
});
export type BashInput = typeof BashInput.Type;

export interface BashDetails {
  /** Null when the command did not finish (timeout, abort). */
  readonly exitCode: number | null;
  readonly timedOut?: boolean;
  readonly aborted?: boolean;
  readonly truncation?: Truncation;
  /** The complete output, when it was truncated. */
  readonly fullOutputPath?: string;
}

/** setTimeout's ceiling. */
const MAX_TIMEOUT_MS = 2_147_483_647;
/** Seconds a command runs when the model names no timeout: long enough for a build, short enough that a server started in the foreground does not hold the turn forever. */
export const DEFAULT_BASH_TIMEOUT = 600;
/** After exit, how long pipes held by a background descendant may stay idle before reading stops. */
const EXIT_STDIO_GRACE_MS = 100;

/** Kills the shell's whole process group: the shell leads its own group because it was spawned detached. */
const killTree = (child: ChildProcess) => {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
};

/**
 * Resolves with the exit code once the process exited and its pipes closed, or
 * once the pipes stayed idle for a grace period after exit: a detached
 * descendant that inherited them must not hang the tool, but output it is
 * still writing is not cut off (pi's `waitForChildProcess`).
 */
function waitForExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let exited = false;
    let code: number | null = null;
    let idle: NodeJS.Timeout | undefined;
    let stdoutEnded = child.stdout === null;
    let stderrEnded = child.stderr === null;
    const finish = (value: number | null) => {
      if (settled) return;
      settled = true;
      if (idle !== undefined) clearTimeout(idle);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(value);
    };
    const armIdle = () => {
      if (idle !== undefined) clearTimeout(idle);
      idle = setTimeout(() => finish(code), EXIT_STDIO_GRACE_MS);
    };
    const maybeFinish = () => {
      if (exited && stdoutEnded && stderrEnded) finish(code);
    };
    child.stdout?.once("end", () => {
      stdoutEnded = true;
      maybeFinish();
    });
    child.stderr?.once("end", () => {
      stderrEnded = true;
      maybeFinish();
    });
    child.stdout?.on("data", () => {
      if (exited && !settled) armIdle();
    });
    child.stderr?.on("data", () => {
      if (exited && !settled) armIdle();
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once("exit", (value) => {
      exited = true;
      code = value;
      maybeFinish();
      if (!settled) armIdle();
    });
    child.once("close", (value) => finish(value));
  });
}

/** The `bash` tool; a command without a timeout of its own stops after `defaultTimeout` seconds (0: never). */
export const makeBashTool = (defaultTimeout: number = DEFAULT_BASH_TIMEOUT): Tool<BashInput> => ({
  name: "bash",
  description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds${
    defaultTimeout > 0
      ? `; without one, the command is stopped after ${defaultTimeout} seconds. Run long-lived processes such as servers in the background (with nohup and &, redirecting their output to a file)`
      : ""
  }.`,
  input: BashInput,
  execute: async ({ command, timeout: requested }, { cwd, signal, update }) => {
    const timeout = requested ?? (defaultTimeout > 0 ? defaultTimeout : undefined);
    if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) throw new Error("Invalid timeout: must be a finite number of seconds");
    if (timeout !== undefined && timeout * 1000 > MAX_TIMEOUT_MS) throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_MS / 1000} seconds`);
    if (signal.aborted) throw new Error("Command aborted");
    try {
      await access(cwd, fsConstants.F_OK);
    } catch {
      throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
    }
    // Recheck after the lookup; from here to installing the abort listener runs synchronously.
    if (signal.aborted) throw new Error("Command aborted");

    const output = new OutputAccumulator("lemma-bash");
    const child = spawn("bash", ["-c", command], { cwd, detached: true, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    // Streaming decode: a character split across chunks is held until its last byte arrives.
    const live = new TextDecoder();
    const onData = (data: Buffer) => {
      output.append(data);
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
      exitCode = await waitForExit(child);
      // A signal-killed shell has no exit code; use the shell convention so it never reads as success.
      if (exitCode === null && child.signalCode !== null) exitCode = 128 + (osConstants.signals[child.signalCode] ?? 0);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      output.finish();
    }
    const snapshot = output.snapshot();
    await output.close();

    const { truncation, fullOutputPath } = snapshot;
    let body = snapshot.content;
    if (truncation.truncated) {
      const startLine = truncation.totalLines - truncation.outputLines + 1;
      const endLine = truncation.totalLines;
      if (truncation.lastLinePartial) {
        body += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${formatSize(output.lastLineBytes)}). Full output: ${fullOutputPath}]`;
      } else if (truncation.truncatedBy === "lines") {
        body += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${fullOutputPath}]`;
      } else {
        body += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${fullOutputPath}]`;
      }
    }
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
    return new ToolResult({ content: [{ type: "text", text: textBody }], ...(status === undefined ? {} : { isError: true }), details });
  },
});

export const bashTool: Tool<BashInput> = makeBashTool();
