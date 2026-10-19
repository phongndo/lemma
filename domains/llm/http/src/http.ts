/**
 * Requests to providers: a POST that asks again where the provider SDKs would, and a reader of the server-sent events
 * a streamed answer comes in.
 */

/** A provider's failure: its HTTP status and headers when it answered, and its wording. */
export class ProviderError extends Error {
  readonly status: number | undefined;
  readonly headers: Headers | undefined;
  /** The delay the provider asked for before another try, when longer than this plugin waits itself. */
  readonly retryAfterMs: number | undefined;
  constructor(
    message: string,
    options: { readonly status?: number; readonly headers?: Headers; readonly retryAfterMs?: number; readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ProviderError";
    this.status = options.status;
    this.headers = options.headers;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/** The most of an error body kept in a message. */
const MAX_BODY = 4000;

/**
 * What a provider said in an error body: its `error.message` (OpenAI's and Anthropic's shape), prefixed by its type
 * or code when it gives one, else the body itself.
 */
export function errorText(body: string): string {
  try {
    const parsed = JSON.parse(body) as unknown;
    const error = typeof parsed === "object" && parsed !== null && "error" in parsed ? (parsed as { error: unknown }).error : parsed;
    if (typeof error === "string") return error;
    if (typeof error === "object" && error !== null) {
      const { message, type, code } = error as { message?: unknown; type?: unknown; code?: unknown };
      const kind = typeof code === "string" ? code : typeof type === "string" ? type : undefined;
      if (typeof message === "string") return withUpstream(kind === undefined || message.includes(kind) ? message : `${kind}: ${message}`, error);
    }
  } catch {
    // Not JSON: the text itself.
  }
  const text = body.trim();
  return text.length > MAX_BODY ? `${text.slice(0, MAX_BODY)}... [${text.length - MAX_BODY} more characters]` : text;
}

/**
 * `message` with what the provider behind a gateway said, where the gateway passes it on (OpenRouter's
 * `metadata.raw`): "Provider returned error" alone hides an overflow or a refusal.
 */
export function withUpstream(message: string, error: object): string {
  const raw = (error as { metadata?: { raw?: unknown } }).metadata?.raw;
  if (raw === undefined || raw === null) return message;
  const text = typeof raw === "string" ? raw : JSON.stringify(raw);
  return message.includes(text) ? message : `${message}\n${text.length > MAX_BODY ? `${text.slice(0, MAX_BODY)}...` : text}`;
}

/** The connection to the provider was lost or could not be had: the request did nothing wrong, and asked again may pass. */
export class ConnectionError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "ConnectionError";
  }
}

/** A connection's failure, named by Node's code for it (`fetch failed (ECONNREFUSED)`). */
export function networkError(error: unknown): ProviderError {
  const cause = error instanceof Error ? (error.cause as { code?: unknown; message?: unknown } | undefined) : undefined;
  const detail = typeof cause?.code === "string" ? cause.code : typeof cause?.message === "string" ? cause.message : undefined;
  const message = error instanceof Error ? error.message : String(error);
  return new ProviderError(detail === undefined ? message : `${message} (${detail})`, { cause: error });
}

export const abortError = (): Error => {
  const error = new Error("Request was aborted");
  error.name = "AbortError";
  return error;
};

/** The longest wait a provider may ask for that this plugin sits out itself; a longer one is the caller's. */
const MAX_RETRY_DELAY_MS = 60_000;

/** Whether the provider SDKs ask again after this answer: a timeout, a conflict, a rate limit, or the server's fault. */
const retryable = (status: number, headers: Headers): boolean => {
  const should = headers.get("x-should-retry");
  if (should === "true") return true;
  if (should === "false") return false;
  return status === 408 || status === 409 || status === 429 || status >= 500;
};

/** The wait the provider names (`retry-after-ms`, `retry-after` in seconds or as a date), else a backoff. */
const retryDelay = (headers: Headers | undefined, attempt: number): { readonly ms: number; readonly named: boolean } => {
  const ms = Number.parseFloat(headers?.get("retry-after-ms") ?? "");
  if (Number.isFinite(ms)) return { ms, named: true };
  const after = headers?.get("retry-after");
  if (after) {
    const seconds = Number.parseFloat(after);
    const named = Number.isNaN(seconds) ? Date.parse(after) - Date.now() : seconds * 1000;
    if (Number.isFinite(named)) return { ms: Math.max(0, named), named: true };
  }
  return { ms: Math.min(500 * 2 ** attempt, 8000) * (1 - Math.random() * 0.25), named: false };
};

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const done = () => {
      signal.removeEventListener("abort", stop);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener("abort", stop, { once: true });
  });

/**
 * POSTs `body` as JSON, asking again up to `retries` times before an answer starts where the provider SDKs would (a
 * lost connection, a 408, 409, 429, or 5xx), waiting the delay the provider names up to a minute. A refusal is a
 * `ProviderError` with its status and wording; a longer requested delay is its `retryAfterMs`, for the caller.
 */
export async function post(
  fetchImpl: typeof fetch,
  url: string,
  init: { readonly headers: Headers; readonly body: unknown; readonly signal: AbortSignal; readonly retries: number },
): Promise<Response> {
  const body = JSON.stringify(init.body);
  for (let attempt = 0; ; attempt++) {
    let failure: ProviderError;
    try {
      const response = await fetchImpl(url, { method: "POST", headers: init.headers, body, signal: init.signal });
      if (response.ok) return response;
      const text = await response.text().catch(() => "");
      const said = errorText(text);
      failure = new ProviderError(`${response.status} ${said || response.statusText || "(no body)"}`.trim(), {
        status: response.status,
        headers: response.headers,
      });
      if (!retryable(response.status, response.headers)) throw failure;
    } catch (error) {
      if (init.signal.aborted) throw abortError();
      if (error instanceof ProviderError) throw error;
      failure = networkError(error);
    }
    const delay = retryDelay(failure.headers, attempt);
    if (delay.named && delay.ms > MAX_RETRY_DELAY_MS) {
      throw new ProviderError(failure.message, {
        ...(failure.status === undefined ? {} : { status: failure.status }),
        ...(failure.headers === undefined ? {} : { headers: failure.headers }),
        retryAfterMs: delay.ms,
      });
    }
    if (attempt >= init.retries) throw failure;
    await sleep(delay.ms, init.signal);
  }
}

/** One server-sent event: its `event` field, when it has one, and its data lines joined. */
export interface SseEvent {
  readonly event: string | undefined;
  readonly data: string;
}

/** The events of a server-sent event stream, as they arrive. Lines end in `\n`, `\r\n`, or `\r`; comments are skipped. */
export async function* sse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  let event: string | undefined;
  let data: string[] = [];
  const flush = (): SseEvent | undefined => {
    const out = data.length === 0 ? undefined : { event, data: data.join("\n") };
    event = undefined;
    data = [];
    return out;
  };
  const line = (text: string): SseEvent | undefined => {
    if (text === "") return flush();
    if (text.startsWith(":")) return undefined;
    const colon = text.indexOf(":");
    const field = colon === -1 ? text : text.slice(0, colon);
    const value = colon === -1 ? "" : text.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    return undefined;
  };
  const reader = body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      for (let end = buffer.search(/[\r\n]/); end !== -1; end = buffer.search(/[\r\n]/)) {
        // A `\r` at the buffer's end may be the first half of `\r\n`: wait for the next chunk.
        if (buffer[end] === "\r" && end === buffer.length - 1 && !done) break;
        const next = buffer[end] === "\r" && buffer[end + 1] === "\n" ? end + 2 : end + 1;
        const out = line(buffer.slice(0, end));
        buffer = buffer.slice(next);
        if (out !== undefined) yield out;
      }
      if (done) break;
    }
    if (buffer !== "") {
      const out = line(buffer);
      if (out !== undefined) yield out;
    }
    const last = flush();
    if (last !== undefined) yield last;
  } finally {
    reader.releaseLock();
  }
}

/** Headers as a record, for what the provider answered with. */
export const headerRecord = (headers: Headers): Record<string, string> => Object.fromEntries(headers.entries());
