import type { LlmRequest } from "@lemma/llm";
import type { SseEvent } from "./http.ts";
import type { Model, Think } from "./model.ts";
import type { Output } from "./output.ts";

/** The key a request authenticates with, and whether it is a signed-in account's token rather than an API key. */
export interface Auth {
  readonly key: string;
  readonly oauth: boolean;
}

/** One model request, as a wire adapter builds it. */
export interface WireCall {
  readonly model: Model;
  /** The request, its history already as the model can take it back (`history`). */
  readonly request: LlmRequest;
  /** How it asks the model to think (`thinkFor`); undefined: nothing about thinking is sent. */
  readonly think: Think | undefined;
  readonly auth: Auth;
  /** How long the provider keeps the prompt cache: `long` is an hour where offered. */
  readonly cacheRetention: "short" | "long";
}

/** A wire protocol: how a request is sent, and how its answer's events become the message. */
export interface Wire {
  /** The URL to POST to, the body, and the headers the protocol needs (its key among them). */
  readonly build: (call: WireCall) => { readonly url: string; readonly body: Record<string, unknown>; readonly headers: Record<string, string> };
  /**
   * Reads the answer's events into `out`, handing each to `raw` as the provider sent it, and sets its stop reason.
   * Throws when the provider fails mid-answer, or ends without finishing it.
   */
  readonly read: (events: AsyncIterable<SseEvent>, out: Output, call: WireCall, raw: (data: unknown) => void) => Promise<void>;
  /**
   * Whether a request at `off` tells `model` to stop thinking (a switch, or the value its `off` is sent as). Where it
   * cannot, `off` is not one of a catalog model's levels: asked at it, the model would think while its user is told it
   * does not.
   */
  readonly saysOff: (model: Model) => boolean;
}

/** An event's data as JSON; a provider's malformed event fails the answer, naming it. */
export function json(event: SseEvent): unknown {
  try {
    return JSON.parse(event.data);
  } catch {
    throw new Error(`The provider sent an event that is not JSON${event.event === undefined ? "" : ` (${event.event})`}: ${event.data.slice(0, 200)}`);
  }
}

/** Sampling parameters merged into a body last, so they win over the fields named before them. */
export const merged = (body: Record<string, unknown>, samplingParams: Record<string, unknown> | undefined): Record<string, unknown> =>
  samplingParams === undefined ? body : { ...body, ...samplingParams };
