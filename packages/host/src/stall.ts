import { realpathSync } from "node:fs";
import { Context, Exit, Option } from "effect";
import type { Tracer } from "effect";
import { Worker } from "node:worker_threads";
import type { CodeOwner } from "./stall-owners.ts";

/*
 * Telling that the host's event loop is blocked, and by whose code. A plugin stuck in synchronous work (a loop that
 * never yields, a huge `JSON.parse`) stops every session, the transport, and its own supervision with it: nothing that
 * runs on the loop can notice. A worker thread can: the loop bumps a counter in shared memory every `TICK_MS`, and the
 * worker, on a loop of its own, sees when the counter has not moved for `thresholdMs`. It then reads the blocked
 * thread's stack a few times through the inspector, and names the plugin whose code most of them were in, from where
 * each plugin's code lives (`CodeOwner`).
 *
 * A read evaluates `new Error().stack` on the blocked thread (`Runtime.evaluate`, which the inspector serves between
 * the instructions of the JavaScript it runs, in about a millisecond): it runs nested on top of the work that blocks
 * the thread, so that work's frames are below it, and nothing is paused. A CPU profile started after the work began
 * would miss that work's own frame once V8 has optimized the running loop (the profiler never saw that code made),
 * and name its caller instead: often the kernel, which called the plugin's handler. A thread blocked outside
 * JavaScript answers only once it returns: a stack read once the loop has run again shows other work, and is left out.
 */

/** A stall, reported once the loop runs again. */
export interface Stall {
  /** Epoch milliseconds the loop last ran before it, and how long it was blocked. */
  readonly start: number;
  readonly ms: number;
  /** The plugin whose code most of the stacks read were in, and what share of them; absent when none could be told. */
  readonly pluginId?: string;
  readonly share?: number;
}

export interface StallOptions {
  /** How long the loop may be blocked before it is a stall (default 1,000 ms). */
  readonly thresholdMs?: number;
  /** Where each plugin's code lives now: asked as the loop runs, and sent to the worker when it returns another array. */
  readonly owners: () => readonly CodeOwner[];
  /** Hears a stall once the loop runs again. */
  readonly onStall: (stall: Stall) => void;
}

export interface StallWatch {
  /** Resolves once the worker is watching. */
  readonly ready: Promise<void>;
  /** Sends the worker where plugins' code is now, if `owners` changed: before code that may block runs (a load's). */
  readonly refresh: () => void;
  readonly stop: () => void;
}

/** How often the loop bumps its counter, and the worker looks at it. */
export const TICK_MS = 100;
export const DEFAULT_THRESHOLD_MS = 1_000;
/** How many times the worker reads a stall's stack, and how long it waits between reads. */
export const SNAPSHOTS = 5;
export const SNAPSHOT_GAP_MS = 20;

/** What the worker says: that it is watching, and each stall once the loop runs again. */
export type WorkerMessage = { readonly type: "ready" } | { readonly type: "stall"; readonly stall: Stall };

/** What the worker hears: where plugins' code is. */
export interface OwnersMessage {
  readonly owners: readonly CodeOwner[];
}

/** What the worker starts with. */
export interface StallWorkerData {
  /**
   * Two counters: [0] the loop's beats, [1] 1 while an inspector is open (`--inspect`, a debugger's terminal), which
   * may hold the loop at a breakpoint: no stall is said then, as one cannot be told from a pause.
   */
  readonly shared: SharedArrayBuffer;
  readonly thresholdMs: number;
  readonly tickMs: number;
  readonly snapshots: number;
  readonly gapMs: number;
  /** Whether the inspector can read the main thread's stack: false where the runtime has none. */
  readonly inspectable: boolean;
}

/**
 * Starts watching the loop. The worker writes a line to stderr while the loop is still blocked (straight to the file
 * descriptor, as the loop that would print it is the one blocked), and `onStall` hears the stall once the loop runs
 * again. Neither the timer nor the worker keeps the process alive once the worker is watching (`ready`). Returns
 * undefined where a worker cannot start.
 */
export function watchStalls(options: StallOptions): StallWatch | undefined {
  const thresholdMs = options.thresholdMs ?? DEFAULT_THRESHOLD_MS;
  const shared = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const counters = new Int32Array(shared);
  const debuggable = process.features.inspector;
  // Loaded only where the runtime has one: where it has none, importing `node:inspector` throws.
  const inspector = debuggable ? (process.getBuiltinModule("node:inspector") as typeof import("node:inspector")) : undefined;
  const data: StallWorkerData = { shared, thresholdMs, tickMs: TICK_MS, snapshots: SNAPSHOTS, gapMs: SNAPSHOT_GAP_MS, inspectable: debuggable };
  let worker: Worker;
  try {
    worker = new Worker(new URL("./stall-worker.ts", import.meta.url), { workerData: data });
  } catch (error) {
    console.error(`lemma: cannot watch for a blocked event loop: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
  let sent: readonly CodeOwner[] | undefined;
  const refresh = () => {
    const owners = options.owners();
    if (owners === sent) return;
    sent = owners;
    // As stack frames name them: through any symlink (a plugin linked into the plugins directory, a temporary
    // directory under one), to the file itself.
    worker.postMessage({ owners: owners.map((owner) => ({ ...owner, path: realPath(owner.path) })) } satisfies OwnersMessage);
  };
  const beat = () => {
    Atomics.add(counters, 0, 1);
    Atomics.store(counters, 1, inspector?.url() !== undefined ? 1 : 0);
    refresh();
  };
  beat();
  const timer = setInterval(beat, TICK_MS);
  timer.unref();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => (started = resolve));
  worker.on("message", (message: WorkerMessage) => {
    if (message.type === "stall") return options.onStall(message.stall);
    // Held until it is watching (a moment), so `ready` resolves; then it keeps nothing alive. The `message` listener
    // refs the worker's port, so this comes after it.
    worker.unref();
    started();
  });
  // A watchdog that cannot run (its file cannot load where the host is packaged) is no reason to stop the host.
  worker.on("error", (error) => {
    clearInterval(timer);
    console.error(`lemma: stopped watching for a blocked event loop: ${error.message}`);
    worker.unref();
  });
  return {
    ready,
    refresh,
    stop: () => {
      clearInterval(timer);
      void worker.terminate();
    },
  };
}

/**
 * Says a stall once the loop runs again, and keeps it in the trace: a `host.stall` span over the time the loop was
 * blocked, with `stall.ms`, and `plugin.id` (and `stall.share`) when whose code it was could be told.
 */
export function recordStall(tracer: Tracer.Tracer, stall: Stall): void {
  const whose = stall.pluginId === undefined ? "" : `, running ${stall.pluginId}'s code`;
  console.error(`lemma: the event loop was blocked for ${(stall.ms / 1000).toFixed(1)} s${whose}`);
  const nanos = (ms: number) => BigInt(Math.round(ms * 1e6));
  const span = tracer.span({
    name: "host.stall",
    parent: Option.none(),
    annotations: Context.empty(),
    links: [],
    startTime: nanos(stall.start),
    kind: "internal",
    root: true,
    sampled: true,
  });
  span.attribute("stall.ms", stall.ms);
  if (stall.pluginId !== undefined) span.attribute("plugin.id", stall.pluginId);
  if (stall.share !== undefined) span.attribute("stall.share", stall.share);
  span.end(nanos(stall.start + stall.ms), Exit.void);
}

const realPath = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};
