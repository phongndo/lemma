import { abortError, ConnectionError, ProviderError } from "./http.ts";
import type { SseEvent } from "./http.ts";

/**
 * OpenAI's Responses API in its WebSocket mode: one connection per session, kept open between its requests. The
 * provider holds the connection's last response in memory (with `store: false` as over HTTP), so a request that
 * extends it sends only what is new, after `previous_response_id`; anything else, or a connection that closed, sends
 * the whole input again. One response runs on a connection at a time: stopping it closes the connection, which stops
 * the provider generating it, and leaves no other session's answer behind.
 */

/** What this plugin uses of a WebSocket: Node's global one is such, with a `headers` option for the key. */
export interface Socket {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

/** Opens a socket to `url` with `headers` on its handshake. */
export type SocketFactory = (url: string, headers: Readonly<Record<string, string>>) => Socket;

/** Node's WebSocket (undici's), which takes handshake headers beside the standard's arguments. */
export const nodeSocket: SocketFactory = (url, headers) => new WebSocket(url, { headers } as unknown as string[]) as unknown as Socket;

/** How long a connection may take to open before a request goes over HTTP instead. */
const CONNECT_TIMEOUT_MS = 10_000;
/** How long a session's idle connection stays open for its next request. */
const IDLE_MS = 10 * 60 * 1000;
/** The provider closes a connection after an hour: one this old takes no new request. */
const MAX_AGE_MS = 55 * 60 * 1000;
/** After a connection could not be opened, requests to that endpoint go over HTTP for this long. */
const BACKOFF_MS = 10 * 60 * 1000;

/** What a session's connection holds of its last response: its id, and the input items it was asked with and made. */
interface Last {
  readonly responseId: string;
  readonly items: readonly string[];
}

export class Connection {
  readonly key: string;
  readonly openedAt = Date.now();
  last: Last | undefined;
  busy = false;
  closed = false;
  private readonly socket: Socket;
  private deliver: ((message: string) => void) | undefined;
  private ended: ((error: Error) => void) | undefined;
  private idle: ReturnType<typeof setTimeout> | undefined;

  private constructor(socket: Socket, key: string) {
    this.socket = socket;
    this.key = key;
    socket.onmessage = (event) => this.deliver?.(typeof event.data === "string" ? event.data : String(event.data));
    socket.onclose = () => {
      this.closed = true;
      this.ended?.(new ConnectionError("The provider closed the connection before the response ended"));
    };
    socket.onerror = () => {
      this.closed = true;
      this.ended?.(new ConnectionError("The connection to the provider failed"));
    };
  }

  /** Opens a connection; rejects when it cannot be opened within the timeout or `signal` aborts. */
  static open(factory: SocketFactory, url: string, headers: Readonly<Record<string, string>>, key: string, signal: AbortSignal): Promise<Connection> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(abortError());
      const socket = factory(url, headers);
      const fail = (error: Error) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", stop);
        socket.onopen = socket.onclose = socket.onerror = null;
        socket.close();
        reject(error);
      };
      const stop = () => fail(abortError());
      const timer = setTimeout(() => fail(new Error("The connection timed out")), CONNECT_TIMEOUT_MS);
      signal.addEventListener("abort", stop, { once: true });
      socket.onopen = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", stop);
        resolve(new Connection(socket, key));
      };
      socket.onerror = socket.onclose = () => fail(new Error("The connection could not be opened"));
    });
  }

  /** Whether a request may start on it: open, not answering another, and not near the provider's limit. */
  get usable(): boolean {
    return !this.closed && !this.busy && Date.now() - this.openedAt < MAX_AGE_MS;
  }

  /**
   * `items` (a request's input, each as JSON) as the connection can take them: after its last response, only what
   * is new, when they begin with all that response held.
   */
  continuation(items: readonly string[]): { readonly previous: string; readonly from: number } | undefined {
    const last = this.last;
    if (last === undefined || items.length <= last.items.length) return undefined;
    for (let i = 0; i < last.items.length; i++) if (items[i] !== last.items[i]) return undefined;
    return { previous: last.responseId, from: last.items.length };
  }

  /**
   * Sends `event` and yields what the provider sends for it, as server-sent events are read, until its response
   * ends or fails. Aborting closes the connection.
   */
  async *request(event: Record<string, unknown>, signal: AbortSignal): AsyncGenerator<SseEvent> {
    const queue: string[] = [];
    let wake: (() => void) | undefined;
    let failure: Error | undefined;
    const notify = () => {
      wake?.();
      wake = undefined;
    };
    this.deliver = (message) => {
      queue.push(message);
      notify();
    };
    this.ended = (error) => {
      failure ??= error;
      notify();
    };
    const stop = () => {
      failure ??= abortError();
      this.close();
      notify();
    };
    signal.addEventListener("abort", stop, { once: true });
    try {
      // Stopped before it was sent: nothing is, so the provider generates nothing nobody reads.
      if (signal.aborted) throw abortError();
      if (this.closed) throw new ConnectionError("The connection to the provider closed");
      this.socket.send(JSON.stringify(event));
      for (;;) {
        const message = queue.shift();
        if (message === undefined) {
          if (failure !== undefined) throw failure;
          await new Promise<void>((resolve) => (wake = resolve));
          continue;
        }
        yield { event: undefined, data: message };
        if (terminal(message)) return;
      }
    } finally {
      signal.removeEventListener("abort", stop);
      this.deliver = undefined;
      this.ended = undefined;
    }
  }

  /** Closes it after `IDLE_MS` unless a request takes it first. */
  rest(onClose: () => void): void {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      this.close();
      onClose();
    }, IDLE_MS);
    this.idle.unref?.();
  }

  wake(): void {
    clearTimeout(this.idle);
  }

  close(): void {
    clearTimeout(this.idle);
    if (this.closed) return;
    this.closed = true;
    this.socket.close();
  }
}

const TERMINAL_TYPES: ReadonlySet<string> = new Set(["response.completed", "response.incomplete", "response.failed", "error"]);
const MAYBE_TERMINAL = /"(?:response\.completed|response\.incomplete|response\.failed|error)"/;

/** Whether `message` ends its response: a finished, cut-short, or failed response, or an error. Parsed only when it may. */
function terminal(message: string): boolean {
  if (!MAYBE_TERMINAL.test(message)) return false;
  try {
    const type = (JSON.parse(message) as { type?: unknown }).type;
    return typeof type === "string" && TERMINAL_TYPES.has(type);
  } catch {
    return false;
  }
}

/** The provider's error event over the socket, as an error carrying its status. */
export function socketError(data: Readonly<Record<string, unknown>>): Error {
  const error = (typeof data.error === "object" && data.error !== null ? data.error : data) as { code?: unknown; message?: unknown };
  const code = typeof error.code === "string" ? error.code : "error";
  const message = `${code}: ${typeof error.message === "string" ? error.message : "the provider failed the request"}`;
  return typeof data.status === "number" ? new ProviderError(`${data.status} ${message}`, { status: data.status }) : new Error(message);
}

/** A session's place in the pool: its connection while one opens, then the connection. */
type Slot = { readonly opening: AbortController } | { readonly connection: Connection };

/**
 * Each session's connection, opened when its first request goes over the socket, and kept while it is used. Every
 * connection is in `sessions` from before its handshake until it closes, so whatever closes the pool reaches it: one
 * whose handshake ends after its slot is gone (the pool closed, the request stopped) is closed at once.
 */
export class SocketPool {
  private readonly factory: SocketFactory;
  private readonly sessions = new Map<string, Slot>();
  /** Endpoints a connection could not be opened to, and until when their requests go over HTTP. */
  private readonly backoff = new Map<string, number>();
  private closed = false;

  constructor(factory: SocketFactory) {
    this.factory = factory;
  }

  /**
   * `session`'s connection to `url` with `headers`, opened if it has none that is usable; undefined, for HTTP
   * instead, when it is answering another request, is opening for one, or cannot be opened. A connection opened with
   * other headers (a handler of the headers hook changed them) is replaced.
   */
  async acquire(session: string, url: string, headers: Readonly<Record<string, string>>, signal: AbortSignal): Promise<Connection | undefined> {
    if (this.closed) return undefined;
    const key = `${url}\n${JSON.stringify(Object.entries(headers).sort(([a], [b]) => a.localeCompare(b)))}`;
    const slot = this.sessions.get(session);
    if (slot !== undefined && "opening" in slot) return undefined;
    const current = slot?.connection;
    if (current !== undefined && current.busy && !current.closed) return undefined;
    if (current !== undefined && current.usable && current.key === key) {
      current.wake();
      current.busy = true;
      return current;
    }
    current?.close();
    this.sessions.delete(session);
    if ((this.backoff.get(url) ?? 0) > Date.now()) return undefined;
    const opening: Slot = { opening: new AbortController() };
    this.sessions.set(session, opening);
    let connection: Connection;
    try {
      connection = await Connection.open(this.factory, url, headers, key, AbortSignal.any([signal, opening.opening.signal]));
    } catch (error) {
      if (this.sessions.get(session) === opening) this.sessions.delete(session);
      if (signal.aborted) throw error;
      if (!opening.opening.signal.aborted) this.backoff.set(url, Date.now() + BACKOFF_MS);
      return undefined;
    }
    // Its slot gone while the handshake ended (the pool closed), or the request stopped: the connection is nobody's.
    if (this.sessions.get(session) !== opening || signal.aborted) {
      connection.close();
      if (this.sessions.get(session) === opening) this.sessions.delete(session);
      if (signal.aborted) throw abortError();
      return undefined;
    }
    connection.busy = true;
    this.sessions.set(session, { connection });
    return connection;
  }

  /** The request on `connection` ended: kept for the session's next one, or closed. */
  release(session: string, connection: Connection, keep: boolean): void {
    connection.busy = false;
    const slot = this.sessions.get(session);
    const held = slot !== undefined && "connection" in slot && slot.connection === connection;
    if (!keep || connection.closed || !held) {
      connection.close();
      if (held) this.sessions.delete(session);
      return;
    }
    connection.rest(() => {
      const now = this.sessions.get(session);
      if (now !== undefined && "connection" in now && now.connection === connection) this.sessions.delete(session);
    });
  }

  /** Closes every connection, and stops those opening: requests from now on go over HTTP. */
  closeAll(): void {
    this.closed = true;
    for (const slot of this.sessions.values()) {
      if ("opening" in slot) slot.opening.abort();
      else slot.connection.close();
    }
    this.sessions.clear();
  }
}
