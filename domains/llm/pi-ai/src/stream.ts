import { Effect, Predicate, Queue, Stream } from "effect";
import type { Api, Model, Models, Provider, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { LlmRequest, StreamEvent } from "@lemma/llm";
import { makeEventMapper, reasoningFor, toContext } from "./convert.ts";
import { identityHeaders } from "./identity.ts";

/** The response header a provider names its request id in, by the names providers use (not a CDN's trace id). */
const REQUEST_ID_HEADERS = ["request-id", "x-request-id", "openai-request-id", "x-amzn-requestid", "x-goog-request-id"];
const requestIdOf = (headers: Readonly<Record<string, string>>): string | undefined => {
  const lower = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return REQUEST_ID_HEADERS.map((name) => lower.get(name)).find((value) => value !== undefined);
};

/** What `providerOptions` (`LlmRequest`) pi-ai passes on: a temperature, sampling parameters, and metadata. */
const passedOn = (options: LlmRequest["providerOptions"]): Pick<SimpleStreamOptions, "temperature" | "samplingParams" | "metadata"> => {
  if (options === undefined) return {};
  const record = (value: unknown) => (Predicate.isObject(value) ? value : undefined);
  const temperature = typeof options.temperature === "number" ? options.temperature : undefined;
  const samplingParams = record(options.samplingParams);
  const metadata = record(options.metadata);
  return {
    ...(temperature === undefined ? {} : { temperature }),
    ...(samplingParams === undefined ? {} : { samplingParams }),
    ...(metadata === undefined ? {} : { metadata }),
  };
};

/**
 * Times pi-ai asks again itself, before a response starts, when the provider
 * fails in a way its SDK would retry (pi-ai makes none unless told). It waits
 * the delay the provider names (`Retry-After`) up to a minute; a longer one it
 * reports in the error, for the caller to wait out.
 */
const SDK_RETRIES = 2;

/** What a response stream reads of the plugin's config. */
export interface StreamSettings {
  /** Seconds a response may send nothing before it fails as stalled; 0 waits forever. */
  readonly streamTimeout: number;
  readonly cacheRetention: NonNullable<SimpleStreamOptions["cacheRetention"]>;
}

/**
 * `request` sent to `model`, as Lemma's events. The stream begins with `start`, and the provider's answer (`provider`,
 * heard before the response's body) follows it. A response that sends nothing for `streamTimeout` seconds ends as a
 * transient failure. Interrupting the stream aborts the request.
 */
export const streamResponse = (
  models: Models,
  model: Model<Api>,
  provider: Provider,
  request: LlmRequest,
  settings: StreamSettings,
): Stream.Stream<StreamEvent> => {
  const reasoning = reasoningFor(model, request.thinking);
  // The model's own headers, and Lemma's User-Agent.
  const headers = { ...model.headers, ...identityHeaders(model) };
  return Stream.callback<StreamEvent>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const controller = new AbortController();
        const mapper = makeEventMapper(model, provider);
        let closed = false;
        /** The provider's answer, held until `start` has gone out: a stream begins with `start`. */
        let answer: StreamEvent | undefined;
        let started = false;
        const send = (out: StreamEvent[]) => {
          if (closed || out.length === 0) return;
          // Where in `out` what was held goes: right after its `start`, first once the stream has started, or
          // before an error that came with no `start`.
          const startAt = out.findIndex((event) => event.type === "start");
          if (startAt >= 0) started = true;
          const at = startAt >= 0 ? startAt + 1 : started ? 0 : out.findIndex((event) => event.type === "error");
          if (answer !== undefined && at >= 0) {
            out = [...out.slice(0, at), answer, ...out.slice(at)];
            answer = undefined;
          }
          Queue.offerAllUnsafe(queue, out);
        };
        const streamOptions: SimpleStreamOptions = {
          signal: controller.signal,
          cacheRetention: settings.cacheRetention,
          maxRetries: SDK_RETRIES,
          ...(Object.keys(headers).length === 0 ? {} : { headers }),
          ...(reasoning === undefined ? {} : { reasoning }),
          ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
          ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
          ...passedOn(request.providerOptions),
          // Before its body: told to the caller, and logged with the answer.
          onResponse: (response) => {
            const requestId = requestIdOf(response.headers);
            answer = { type: "provider", status: response.status, ...(requestId === undefined ? {} : { requestId }) };
          },
        };
        const close = (out: StreamEvent[]) => {
          send(out);
          if (!closed) Queue.endUnsafe(queue);
          closed = true;
        };
        // A response that sends nothing for `streamTimeout` ends at once as a transient failure, and the
        // request is aborted: a half-open connection would otherwise hold the turn forever.
        const idleMs = settings.streamTimeout * 1000;
        let stalled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        // Armed again on every event of the stream: one timer, restarted (`refresh`), rather than a new one each
        // time. Never once it has fired, as `refresh` would start it again.
        const arm = () => {
          if (idleMs <= 0 || stalled) return;
          if (timer !== undefined) {
            timer.refresh();
            return;
          }
          timer = setTimeout(() => {
            stalled = true;
            close(
              mapper.end(new Error(`The model sent nothing for ${settings.streamTimeout} seconds; the request was cut off as stalled`), {
                kind: "transient",
              }),
            );
            controller.abort();
          }, idleMs);
        };
        void (async () => {
          arm();
          try {
            for await (const event of models.streamSimple(model, toContext(request, model), streamOptions)) {
              if (stalled) break;
              arm();
              send(mapper.push(event));
              if (mapper.finished) break;
            }
            close(mapper.end());
          } catch (error) {
            close(mapper.end(error));
          } finally {
            clearTimeout(timer);
          }
        })();
        return () => {
          clearTimeout(timer);
          controller.abort();
        };
      }),
      // Interrupting the consumer aborts the provider request.
      (stop) => Effect.sync(stop),
    ),
  );
};
