#!/usr/bin/env -S node --conditions=lemma-source
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { run } from "./cli.ts";
import { nodeCommand } from "./release.ts";

const argv = process.argv.slice(2);
// `lemma sessions inspect … | head` closes the pipe early; that ends the output, it is not a failure.
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

/** The host, loaded only by \`lemma serve\`: named in a variable, so a bundle of this command leaves it out. */
const hostModule = "@lemma/host";

// The first Ctrl+C stops the command and lets it clean up (a login cancels on the host, a check stops its host and
// removes its home); a second one exits at once. A SIGTERM or SIGHUP (a closed terminal) stops it so too.
const interrupt = new AbortController();
const stopOn = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map((signal) => {
  const listener = () => interrupt.abort();
  process.once(signal, listener);
  return [signal, listener] as const;
});

process.exitCode = await run(argv, {
  env: process.env,
  // \`pnpm lemma\` runs from the workspace root; INIT_CWD is where the user invoked it.
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
  errWrite: (text) => {
    process.stderr.write(text);
  },
  ...(process.stdin.isTTY ? { ask } : {}),
  ...(canOpen ? { open } : {}),
  ...(process.stdout.isTTY ? { columns: process.stdout.columns } : {}),
  interrupt: interrupt.signal,
  // \`lemma serve\` in the foreground: the host runs in this process until SIGINT or SIGTERM, which it handles itself.
  // The host reads its profile from the process's environment: the one the command names (`--profile`), else none.
  serve: async (args, profile) => {
    for (const [signal, listener] of stopOn) process.off(signal, listener);
    process.argv = [process.argv[0]!, process.argv[1]!, ...args];
    if (profile === undefined) delete process.env.LEMMA_PROFILE;
    else process.env.LEMMA_PROFILE = profile;
    await import(hostModule);
  },
  // The script node started, `bin/lemma.js` when that chose this: a host started again (`serve --detach`, a service) chooses again.
  // On the release's Node.js (`nodeCommand`), which in the desktop app is not `process.execPath`, the app.
  self: [nodeCommand, ...process.execArgv, process.argv[1]!],
});
// Whatever still holds the event loop (a socket closing) does not keep an interrupted command alive.
if (interrupt.signal.aborted) process.exit();
