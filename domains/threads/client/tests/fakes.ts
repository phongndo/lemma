import { vi } from "vitest";
import { createRoot } from "solid-js";
import type { SessionInfo } from "@lemma/sessions";
import type { ClientService } from "@lemma/web";
import type { Handle } from "../src/shared.ts";

/** A `Storage` in a map, as a browser's is. */
export const memoryStorage = () => {
  const items = new Map<string, string>();
  return {
    items,
    storage: {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
      removeItem: (key: string) => void items.delete(key),
    },
  };
};

/**
 * What the page gives the client in a browser, stood in for in Node: `window` and `document` to listen to, the
 * browser's storage and the tab's, and animation frames on the fake clock. `look` sets whether the person is looking.
 */
export const browser = () => {
  vi.useFakeTimers();
  const local = memoryStorage();
  const session = memoryStorage();
  const page = { visible: true, focused: true };
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal(
    "document",
    Object.assign(new EventTarget(), {
      get visibilityState() {
        return page.visible ? "visible" : "hidden";
      },
      hasFocus: () => page.focused,
    }),
  );
  vi.stubGlobal("localStorage", local.storage);
  vi.stubGlobal("sessionStorage", session.storage);
  vi.stubGlobal("requestAnimationFrame", (run: () => void) => setTimeout(run, 16) as unknown as number);
  vi.stubGlobal("cancelAnimationFrame", (frame: number) => clearTimeout(frame));
  return {
    local: local.items,
    session: session.items,
    /** The person looks at the window or away, as its focus and visibility events say. */
    look: (looking: boolean) => {
      page.visible = page.focused = looking;
      window.dispatchEvent(new Event(looking ? "focus" : "blur"));
    },
    /** Another tab wrote `key`: the `storage` event this one hears. */
    otherTab: (key: string, newValue: unknown) => {
      const oldValue = local.items.get(key) ?? null;
      const written = newValue === undefined ? null : JSON.stringify(newValue);
      if (written === null) local.items.delete(key);
      else local.items.set(key, written);
      window.dispatchEvent(Object.assign(new Event("storage"), { key, oldValue, newValue: written }));
    },
  };
};

/** The plugin's handle: listeners and timers as the page's, and its cleanups run by `stop`. */
export const handle = () => {
  const cleanups: (() => void)[] = [];
  const plugin: Handle = {
    listen: (target, type, listener) => {
      const listening = (event: Event) => void listener(event as never);
      (target as EventTarget).addEventListener(type, listening);
      return () => (target as EventTarget).removeEventListener(type, listening);
    },
    after: (ms, run) => {
      const timer = setTimeout(() => void run(new AbortController().signal), ms);
      return () => clearTimeout(timer);
    },
    onCleanup: (cleanup) => void cleanups.push(() => void cleanup()),
  } as Handle;
  return { plugin, stop: () => cleanups.splice(0).forEach((cleanup) => cleanup()) };
};

/** An open `follow` of a stream, as the fake client keeps it. */
export interface Followed {
  readonly id: string;
  readonly payload: () => unknown;
  readonly push: (element: unknown) => void;
  readonly end: (error?: Error) => void;
  closed: boolean;
}

/**
 * A `Client` whose calls `answer` answers, by channel id (a call nothing answers rejects), and whose streams the test
 * pushes elements into. `calls` holds each call made, `streams` each stream opened.
 */
export const fakeClient = () => {
  const calls: { readonly id: string; readonly payload: unknown }[] = [];
  const answers = new Map<string, (payload: any) => unknown>();
  const streams: Followed[] = [];
  const client = {
    connected: () => true,
    channel: {
      call: (channel: { readonly id: string } | string, payload: unknown) => {
        const id = typeof channel === "string" ? channel : channel.id;
        calls.push({ id, payload });
        const answer = answers.get(id);
        if (answer === undefined) return Promise.reject(new Error(`nothing answers ${id}`));
        try {
          return Promise.resolve(answer(payload));
        } catch (error) {
          return Promise.reject(error);
        }
      },
    },
    follow: (channel: { readonly id: string } | string, payload: unknown, onElement: (element: unknown) => void, onEnd?: (error?: Error) => void) => {
      const followed: Followed = {
        id: typeof channel === "string" ? channel : channel.id,
        payload: () => (typeof payload === "function" ? (payload as () => unknown)() : payload),
        push: (element) => {
          if (!followed.closed) onElement(element);
        },
        end: (error) => onEnd?.(error),
        closed: false,
      };
      streams.push(followed);
      return () => void (followed.closed = true);
    },
  } as unknown as ClientService;
  return {
    client,
    calls,
    streams,
    /** Answers each call of channel `id` with what `with` returns for its payload (or throws). */
    answer: (id: string, with_: (payload: any) => unknown) => void answers.set(id, with_),
    /** The open streams of channel `id`. */
    open: (id: string) => streams.filter((stream) => stream.id === id && !stream.closed),
    /** The calls made of channel `id`, by payload. */
    made: (id: string) => calls.filter((call) => call.id === id).map((call) => call.payload),
  };
};

/** Runs `make` in a reactive root, as a plugin's setup runs: its effects run, and `dispose` ends them. */
export const rooted = <A>(make: () => A): A & { readonly dispose: () => void } => createRoot((dispose) => ({ ...make(), dispose }));

/** A session as the list holds one: empty (blank) unless `lastSeq` says. */
export const info = (id: string, extra: Partial<SessionInfo> = {}): SessionInfo => ({ id, cwd: "/work", createdAt: 1, updatedAt: 1, lastSeq: 0, ...extra });

/** Lets promises settle, on the fake clock. */
export const settle = () => vi.advanceTimersByTimeAsync(0);
