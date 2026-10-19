import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { constants as osConstants } from "node:os";

/** After exit, how long pipes held by a background descendant may stay idle before reading stops. */
const EXIT_STDIO_GRACE_MS = 100;

/** `bash -c command` in `cwd`, leading a process group of its own, so killing the group stops what it started too. */
export const spawnShell = (
  command: string,
  cwd: string,
): ChildProcess & { stdout: NonNullable<ChildProcess["stdout"]>; stderr: NonNullable<ChildProcess["stderr"]> } =>
  spawn("bash", ["-c", command], { cwd, detached: true, env: process.env, stdio: ["ignore", "pipe", "pipe"] }) as ChildProcess & {
    stdout: NonNullable<ChildProcess["stdout"]>;
    stderr: NonNullable<ChildProcess["stderr"]>;
  };

/** The exit code, or for a shell a signal killed, the shell's convention for it (128 + the signal's number), so it never reads as success. */
export const exitCodeOf = (child: ChildProcess, code: number | null): number | null =>
  code === null && child.signalCode !== null ? 128 + (osConstants.signals[child.signalCode] ?? 0) : code;

/** Kills the shell's whole process group: the shell leads its own group because it was spawned detached. */
export const killTree = (child: ChildProcess) => {
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
export function waitForExit(child: ChildProcess): Promise<number | null> {
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
