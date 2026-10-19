import { anthropicMessages } from "./anthropic.ts";
import { openaiCompletions } from "./completions.ts";
import { post, sse } from "./http.ts";
import type { WireApi } from "./model.ts";
import type { Output } from "./output.ts";
import { openaiResponses } from "./responses.ts";
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
  /** The provider accepted the request: its HTTP response, before the body. */
  readonly answered: (response: Response) => void;
  /** Each event as the provider sent it, before it is read. */
  readonly raw: (data: unknown) => void;
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
  const wire = WIRES[call.model.api];
  const built = wire.build(call);
  const response = await post(options.fetch, built.url, {
    headers: headersOf(built.headers, options.headers),
    body: built.body,
    signal: options.signal,
    retries: RETRIES,
  });
  options.answered(response);
  out.start();
  if (response.body === null) throw new Error("The provider answered with no body");
  await wire.read(sse(response.body), out, call, options.raw);
}
