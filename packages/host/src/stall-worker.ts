import { writeSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { parentPort, workerData } from "node:worker_threads";
import { attribute } from "./stall.ts";
import type { CodeOwner, OwnersMessage, StallWorkerData, WorkerMessage } from "./stall.ts";

/*
 * The stall watchdog's thread (see `watchStalls`): it runs on a loop of its own, so it sees the main thread's counter
 * stop, and says so while the main thread is still blocked.
 */

const { shared, thresholdMs, tickMs, snapshots, gapMs, inspectable } = workerData as StallWorkerData;
const counters = new Int32Array(shared);
let owners: readonly CodeOwner[] = [];
parentPort!.on("message", (message: OwnersMessage) => {
  owners = message.owners;
});

/** Written straight to the file descriptor: the main thread, which writes the process's stderr, is the one blocked. */
const write = (line: string) => {
  try {
    writeSync(2, `lemma: ${line}\n`);
  } catch {
    // Nowhere to say it.
  }
};

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Frame {
  readonly location: { readonly scriptId: string };
}

/**
 * The blocked thread's stack, read up to `snapshots` times while the loop stays blocked at `blocked` beats: each a list
 * of script URLs, innermost first. Every pause is resumed the moment it is heard, whoever's it is, and one heard after
 * the loop ran again (a thread blocked outside JavaScript answers only once it returns) is left out.
 */
const stacks = async (blocked: number): Promise<readonly (readonly string[])[]> => {
  if (!inspectable) return [];
  const session = new Session();
  const scripts = new Map<string, string>();
  const read: string[][] = [];
  let heard: (() => void) | undefined;
  session.on("Debugger.scriptParsed", ({ params }) => void scripts.set(params.scriptId, params.url));
  session.on("Debugger.paused", ({ params }) => {
    void session.post("Debugger.resume").catch(() => undefined);
    if (Atomics.load(counters, 0) === blocked) read.push((params.callFrames as readonly Frame[]).map((frame) => scripts.get(frame.location.scriptId) ?? ""));
    heard?.();
  });
  try {
    session.connectToMainThread();
    // Enabling reports every script already parsed, so a frame's script is known by its id.
    await session.post("Debugger.enable");
    for (let taken = 0; taken < snapshots && Atomics.load(counters, 0) === blocked; taken++) {
      // Waited for however long it takes: a pause asked for is always heard, and resumed, before the session ends.
      const paused = new Promise<void>((resolve) => (heard = resolve));
      await session.post("Debugger.pause");
      await paused;
      await delay(gapMs);
    }
    await session.post("Debugger.disable");
  } catch {
    // Nothing to attribute it with; the stall is still said.
  } finally {
    session.disconnect();
  }
  return read;
};

let beats = Atomics.load(counters, 0);
/** When the worker last saw the counter move, and when it last looked (by its own clock). */
let moved = performance.now();
let looked = moved;
let stall: { readonly since: number; readonly start: number; readonly found: Promise<{ readonly pluginId?: string; readonly share?: number }> } | undefined;

// The worker's own timer keeps it running; the main thread has unref'd it, so it never keeps the process alive.
setInterval(() => {
  const now = performance.now();
  const late = now - looked > thresholdMs;
  looked = now;
  const current = Atomics.load(counters, 0);
  if (current !== beats) {
    beats = current;
    moved = now;
    if (stall !== undefined) {
      const { since, start, found } = stall;
      stall = undefined;
      void found.then((who) => parentPort!.postMessage({ type: "stall", stall: { start, ms: now - since, ...who } } satisfies WorkerMessage));
    }
    return;
  }
  // The worker itself ran late (the machine slept, the process was stopped): that gap is not the loop's to answer for.
  if (late && stall === undefined) {
    moved = now;
    return;
  }
  // A debugger holding the loop at a breakpoint is no stall.
  if (stall !== undefined || now - moved < thresholdMs || Atomics.load(counters, 1) === 1) return;
  const since = moved;
  const found = stacks(current).then((read) => attribute(read, owners));
  stall = { since, start: performance.timeOrigin + since, found };
  void found.then(({ pluginId, share }) => {
    // Said while still blocked, when it is: once the loop runs again, `onStall` hears it.
    if (stall?.since !== since) return;
    const whose = pluginId === undefined ? "" : `, running ${pluginId}'s code (${Math.round((share ?? 0) * 100)}% of its stacks)`;
    write(`the event loop has been blocked for ${seconds(performance.now() - since)}${whose}`);
  });
}, tickMs);
parentPort!.postMessage({ type: "ready" } satisfies WorkerMessage);
