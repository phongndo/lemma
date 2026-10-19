import { Worker } from "node:worker_threads";

/** A tool as the worker lists it: what the model is told of it. */
export interface IsolatedTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
}

export interface IsolateOptions {
  /** A call that takes longer stops the worker: its code may be stuck. */
  readonly timeoutMs: number;
  /** The worker's heap, at most; past it the worker stops, not the host. */
  readonly memoryMb: number;
}

/** A worker thread running a tools module, started again after it stops. */
export interface Isolate {
  readonly list: () => Promise<readonly IsolatedTool[]>;
  /** Runs a tool: its text, or a rejection with what went wrong. A call that times out or is aborted stops the worker. */
  readonly call: (name: string, input: unknown, signal?: AbortSignal) => Promise<string>;
  /** Stops the worker: its code, and every module it imported, go with it. */
  readonly close: () => Promise<void>;
  /** How many workers it has started: one, plus one for each it stopped and needed again. */
  readonly started: () => number;
}

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

/**
 * `module`'s tools in a worker thread of their own: an event loop, a heap, and a module cache apart from the host's. A
 * call that does not answer in time (an endless loop) or is aborted stops the worker, which the host can do because
 * the host's thread was never the one running it; the next call starts another. Closing it frees what the module
 * loaded, which code imported into the host never is: Node's module cache keeps every version imported.
 */
export function startIsolate(module: URL, options: IsolateOptions): Isolate {
  /** The running worker and the calls waiting on it: a worker stopped late fails only its own. */
  let current: { readonly worker: Worker; readonly pending: Map<number, Pending> } | undefined;
  let next = 0;
  let started = 0;

  const failAll = (pending: Map<number, Pending>, error: Error) => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };
  const spawn = () => {
    const worker = new Worker(new URL("./worker.mjs", import.meta.url), {
      workerData: { module: module.href },
      resourceLimits: { maxOldGenerationSizeMb: options.memoryMb },
    });
    const pending = new Map<number, Pending>();
    const made = { worker, pending };
    started++;
    worker.on("message", ({ id, value, error }: { readonly id: number; readonly value?: unknown; readonly error?: string }) => {
      const waiting = pending.get(id);
      pending.delete(id);
      if (error === undefined) waiting?.resolve(value);
      else waiting?.reject(new Error(error));
    });
    const ended = (error: Error) => {
      if (current === made) current = undefined;
      failAll(pending, error);
    };
    worker.on("error", ended);
    worker.on("exit", (code) => ended(new Error(`The tools' worker stopped (exit code ${code})`)));
    return made;
  };
  const stop = async (reason: Error) => {
    const stopping = current;
    current = undefined;
    if (stopping === undefined) return;
    failAll(stopping.pending, reason);
    await stopping.worker.terminate();
  };
  const ask = <A>(message: Record<string, unknown>, signal?: AbortSignal): Promise<A> =>
    new Promise<A>((resolve, reject) => {
      if (signal?.aborted) return reject(new Error("Cancelled"));
      const id = ++next;
      const running = (current ??= spawn());
      const timer = setTimeout(() => {
        if (current === running) void stop(new Error(`No answer in ${options.timeoutMs} ms: the tools' worker was stopped`));
      }, options.timeoutMs);
      const onAbort = () => {
        if (current === running) void stop(new Error("Cancelled: the tools' worker was stopped"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const settle = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      running.pending.set(id, {
        resolve: (value) => (settle(), resolve(value as A)),
        reject: (error) => (settle(), reject(error)),
      });
      running.worker.postMessage({ id, ...message });
    });

  return {
    list: () => ask<readonly IsolatedTool[]>({ type: "list" }),
    call: (name, input, signal) => ask<string>({ type: "call", name, input }, signal),
    close: () => stop(new Error("The tools' worker was closed")),
    started: () => started,
  };
}
