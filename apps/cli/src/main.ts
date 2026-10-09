#!/usr/bin/env -S node --conditions=lemma-source
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { run } from "./cli.ts";

const argv = process.argv.slice(2);
// `lemma inspect … | head` closes the pipe early; that ends the output, it is not a failure.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0);
  else throw error;
});

/** A question at the terminal, on stderr so stdout stays clean for output; secrets are not echoed. Aborting withdraws it. */
const ask = (question: string, secret: boolean, signal?: AbortSignal) =>
  new Promise<string>((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    // The terminal is raw while asking, so Ctrl+C arrives as input: pass it on as the signal it means.
    rl.on("SIGINT", () => process.kill(process.pid, "SIGINT"));
    const withdraw = () => {
      rl.close();
      process.stderr.write("\n");
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", withdraw, { once: true });
    if (secret) {
      const output = rl as unknown as { _writeToOutput: (text: string) => void; output: NodeJS.WritableStream };
      let prompted = false;
      output._writeToOutput = (text) => {
        if (!prompted) {
          output.output.write(text);
          prompted = true;
        }
      };
    }
    rl.question(question, (answer) => {
      signal?.removeEventListener("abort", withdraw);
      if (secret) process.stderr.write("\n");
      rl.close();
      resolve(answer);
    });
  });

/** A browser on this machine, unless there is none to show: no display, or a session over SSH (the link would open on the remote side). */
const canOpen =
  process.stderr.isTTY &&
  process.env.SSH_CONNECTION === undefined &&
  process.env.SSH_TTY === undefined &&
  (process.platform === "darwin" || process.platform === "win32" || process.env.DISPLAY !== undefined || process.env.WAYLAND_DISPLAY !== undefined);

const open = (url: string) => {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  spawn(command, [url], { detached: true, stdio: "ignore" })
    .on("error", () => {})
    .unref();
};

if (argv[0] === "serve") {
  // The host app runs until SIGINT/SIGTERM and reads its own flags (`--no-open`) from argv.
  await import("@lemma/host");
} else {
  // The first Ctrl+C stops the command and lets it clean up (a login cancels on the host); a second one exits at once.
  const interrupt = new AbortController();
  process.once("SIGINT", () => interrupt.abort());
  process.exitCode = await run(argv, {
    env: process.env,
    // `pnpm lemma` runs from the workspace root; INIT_CWD is where the user invoked it.
    cwd: process.env.INIT_CWD ?? process.cwd(),
    out: (text) => {
      process.stdout.write(`${text}\n`);
    },
    write: (text) => {
      process.stdout.write(text);
    },
    drained: (signal) => {
      if (!process.stdout.writableNeedDrain) return undefined;
      return new Promise<void>((resolve) => {
        const done = () => {
          process.stdout.off("drain", done).off("close", done).off("error", done);
          signal.removeEventListener("abort", done);
          resolve();
        };
        process.stdout.once("drain", done).once("close", done).once("error", done);
        signal.addEventListener("abort", done, { once: true });
      });
    },
    err: (text) => {
      process.stderr.write(`${text}\n`);
    },
    ...(process.stdin.isTTY ? { ask } : {}),
    ...(canOpen ? { open } : {}),
    interrupt: interrupt.signal,
  });
  // Whatever still holds the event loop (a socket closing) does not keep an interrupted command alive.
  if (interrupt.signal.aborted) process.exit();
}
