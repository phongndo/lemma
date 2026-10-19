import { anthropicMessages } from "./anthropic.ts";
import { openaiCompletions } from "./completions.ts";
import { post, sse } from "./http.ts";
import type { SseEvent } from "./http.ts";
import type { WireApi } from "./model.ts";
import type { Output } from "./output.ts";
import { answerItems, openaiResponses } from "./responses.ts";
import type { SocketPool } from "./socket.ts";
import type { Wire, WireCall } from "./wire.ts";

const WIRES: Readonly<Record<WireApi, Wire>> = {
  "anthropic-messages": anthropicMessages,
  "openai-responses": openaiResponses,
  "openai-completions": openaiCompletions,
};

/**
 * Times a request is asked again before an answer starts, where the provider SDKs would (`post`): a caller retries
 * what still fails, as the agent does.
 */
const RETRIES = 2;

export interface SendOptions {
  readonly fetch: typeof fetch;
  readonly headers: Readonly<Record<string, string | null>>;
  readonly signal: AbortSignal;
  /** The provider accepted the request: its HTTP response, before the body; none over a socket, which has no response per request. */
  readonly answered: (response: Response | undefined) => void;
  /** Each event as the provider sent it, before it is read. */
  readonly raw: (data: unknown) => void;
  /** Anything arrived from the provider, model output or not (a ping, a keep-alive comment): the connection lives. */
  readonly alive: () => void;
  /** The provider's Responses WebSocket mode, for a model on it whose provider offers it; absent, HTTP. */
  readonly sockets?: SocketPool;
}

/** `built`'s headers with what `LlmProviderHeadersHook` made of the model's and provider's own over them (a `null` drops one). */
function headersOf(built: Readonly<Record<string, string>>, hooked: Readonly<Record<string, string | null>>): Headers {
  const headers = new Headers(built);
  for (const [name, value] of Object.entries(hooked)) {
    if (value === null) headers.delete(name);
    else headers.set(name, value);
  }
  return headers;
}

/**
 * Sends `call` and reads its answer into `out`, which the caller then ends. `headers` are what `LlmProviderHeadersHook`
 * made of the model's and provider's own: they go over the protocol's, so a handler can replace even its key, and a
 * `null` drops one.
 */
export async function send(call: WireCall, out: Output, options: SendOptions): Promise<void> {
  if (options.sockets !== undefined && call.model.api === "openai-responses" && (await overSocket(call, out, options, options.sockets))) return;
  const wire = WIRES[call.model.api];
  const built = wire.build(call);
  const response = await post(options.fetch, built.url, {
    headers: headersOf(built.headers, options.headers),
    body: built.body,
    signal: options.signal,
    retries: RETRIES,
  });
  options.alive();
  options.answered(response);
  out.start();
  if (response.body === null) throw new Error("The provider answered with no body");
  // Every chunk counts as the connection alive, the events the model output carries or not.
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        options.alive();
        controller.enqueue(chunk);
      },
    }),
  );
  await wire.read(sse(body), out, call, options.raw);
}

/**
 * Sends a Responses request over the session's socket (`socket.ts`): after the session's last response, only what is
 * new. False, for HTTP instead, when it has no session, or no connection can be had before anything is sent. The
 * provider no longer holding the last response, or an error before any output, asks once more with the whole input.
 */
async function overSocket(call: WireCall, out: Output, options: SendOptions, sockets: SocketPool): Promise<boolean> {
  const session = call.request.sessionId;
  if (session === undefined) return false;
  const built = openaiResponses.build(call);
  // Over the socket every response streams; `stream` is not one of its fields.
  const { stream: _stream, ...body } = built.body;
  const { "content-type": _type, accept: _accept, ...own } = built.headers;
  const headers = Object.fromEntries(headersOf(own, options.headers).entries());
  const connection = await sockets.acquire(session, built.url.replace(/^http/, "ws"), headers, options.signal);
  if (connection === undefined) return false;
  let keep = false;
  try {
    const input = (body.input as readonly unknown[]).map((item) => JSON.stringify(item));
    let after = connection.continuation(input);
    for (;;) {
      const event = {
        type: "response.create",
        ...body,
        ...(after === undefined ? {} : { previous_response_id: after.previous, input: (body.input as readonly unknown[]).slice(after.from) }),
      };
      const events = connection.request(event, options.signal);
      const first = await events.next();
      if (first.done === true) throw new Error("The provider sent nothing for the request");
      options.alive();
      // The connection reached the provider's hour: this request goes over HTTP, and the session's next opens another.
      if (first.value.data.includes("websocket_connection_limit_reached")) {
        await events.return(undefined);
        connection.close();
        return false;
      }
      // The connection's memory of the last response is gone (it erred, or another process took the lane): everything again.
      if (after !== undefined && first.value.data.includes("previous_response_not_found")) {
        await events.return(undefined);
        connection.last = undefined;
        after = undefined;
        continue;
      }
      options.answered(undefined);
      out.start();
      await openaiResponses.read(
        (async function* (): AsyncGenerator<SseEvent> {
          yield first.value;
          for await (const next of events) {
            options.alive();
            yield next;
          }
        })(),
        out,
        call,
        options.raw,
      );
      // What the provider holds now: this request's input and its answer, which the session's next request begins with.
      const answered = out.responseId !== undefined && out.stopReason !== undefined && out.stopReason !== "error" && out.stopReason !== "aborted";
      connection.last = answered
        ? { responseId: out.responseId!, items: [...input, ...answerItems(call.model, outContent(out)).map((item) => JSON.stringify(item))] }
        : undefined;
      keep = answered;
      return true;
    }
  } finally {
    // Stopped or failed midway, the connection goes: closing it stops the provider generating what nobody reads.
    sockets.release(session, connection, keep && !options.signal.aborted);
  }
}

/** The answer's blocks as the logged message will hold them. */
const outContent = (out: Output) =>
  out.content.map((block) =>
    block.type === "toolCall"
      ? {
          type: "toolCall" as const,
          id: block.id,
          name: block.name,
          arguments: block.arguments,
          ...(block.namespace === undefined ? {} : { namespace: block.namespace }),
        }
      : { ...block },
  );
