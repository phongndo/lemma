import type { Context } from "effect";
import type { Invocation } from "../awaitable.ts";

/** Calls a plugin's setup made: setup is over once they settle (see `@lemma/core/plain`). */
export interface SetupCalls {
  /** Taking calls; closed once setup has returned or failed. */
  open: boolean;
  readonly calls: Promise<unknown>[];
}

/**
 * Where promise-based code is running: the Effect context of the work that
 * called it (a hook's caller, an event's observer, the plugin's activation)
 * and that work's invocation, whose signal aborts when the work is
 * interrupted. Calls it makes through a service run in that context, so they
 * trace under it and stop with it.
 */
export interface Current {
  readonly context: Context.Context<never>;
  readonly invocation: Invocation | undefined;
  /** Present while a plugin's setup runs: its calls, which setup waits for. Work started elsewhere is not counted. */
  readonly setup?: SetupCalls;
}

interface Storage<T> {
  run<R>(store: T, run: () => R): R;
  getStore(): T | undefined;
}

/**
 * `AsyncLocalStorage` where the runtime has one (Node.js, Deno, Bun, found
 * without importing a runtime module, so a browser bundle has nothing to
 * resolve): code keeps the current invocation across `await` and `.then`.
 * Elsewhere only what runs before the first one does.
 */
const asyncLocal = (): Storage<Current> | undefined => {
  try {
    const process = (globalThis as { readonly process?: { readonly getBuiltinModule?: (id: string) => unknown } }).process;
    const hooks = process?.getBuiltinModule?.("node:async_hooks") as { readonly AsyncLocalStorage?: new () => Storage<Current> } | undefined;
    return hooks?.AsyncLocalStorage === undefined ? undefined : new hooks.AsyncLocalStorage();
  } catch {
    return undefined;
  }
};

const storage = asyncLocal();
let synchronous: Current | undefined;

/** Whether the current invocation follows code across `await` (see `asyncLocal`). */
export const followsAwait = storage !== undefined;

/**
 * Runs `run` with `current` as the current invocation. Every call enters
 * async-local storage where there is one: whether a function continues after
 * a promise (`async`, a `.then` chain, a helper it calls) cannot be told
 * from outside it, and a continuation that lost its invocation would run with
 * another's context.
 */
export const within = <T>(current: Current, run: () => T): T => {
  const previous = synchronous;
  if (storage !== undefined) {
    // Inside, the async-local value is the current one: the synchronous one is cleared so it does not shadow it.
    synchronous = undefined;
    try {
      return storage.run(current, run);
    } finally {
      synchronous = previous;
    }
  }
  synchronous = current;
  try {
    return run();
  } finally {
    synchronous = previous;
  }
};

/** The innermost invocation: one entered synchronously and still on the stack, else the one async-local storage carried here. */
export const current = (): Current | undefined => synchronous ?? storage?.getStore();
