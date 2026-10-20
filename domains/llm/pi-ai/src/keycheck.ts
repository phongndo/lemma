import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { USER_AGENT } from "./identity.ts";

/** What asking the provider with a key found: it `works` (listing `models`), the provider `refused` it, or no telling. */
export type KeyVerdict =
  | { readonly verdict: "works"; readonly models?: number }
  | { readonly verdict: "refused"; readonly problem: string }
  | { readonly verdict: "unknown" };

/** Checks a key, as a login is about to store it. */
export type KeyCheck = (key: string, signal: AbortSignal) => Promise<KeyVerdict>;

/** How long a check may take before the key is taken unchecked. */
const CHECK_TIMEOUT_MS = 10_000;

/** How a wire API lists models: the URL, and the headers a key goes in. */
type Lister = (baseUrl: string, key: string | undefined) => { readonly url: string; readonly headers: Record<string, string> };

const bearer = (key: string | undefined): Record<string, string> => (key === undefined ? {} : { authorization: `Bearer ${key}` });

const LISTERS: Readonly<Partial<Record<string, Lister>>> = {
  "openai-completions": (baseUrl, key) => ({ url: `${baseUrl}/models`, headers: bearer(key) }),
  "openai-responses": (baseUrl, key) => ({ url: `${baseUrl}/models`, headers: bearer(key) }),
  "anthropic-messages": (baseUrl, key) => ({
    url: `${baseUrl}/v1/models`,
    headers: { "anthropic-version": "2023-06-01", ...(key === undefined ? {} : { "x-api-key": key }) },
  }),
  "google-generative-ai": (baseUrl, key) => ({ url: `${baseUrl}/models`, headers: key === undefined ? {} : { "x-goog-api-key": key } }),
  "mistral-conversations": (baseUrl, key) => ({ url: `${baseUrl}/v1/models`, headers: bearer(key) }),
};

/** A base URL a check can ask: a plain http(s) URL, not one with a placeholder filled in per account. */
const askable = (baseUrl: string) => /^https?:\/\/[^{}\s]+$/.test(baseUrl);

/** How many models a list names, read from the shapes providers answer with (`data`, `models`). */
const count = (body: unknown): number | undefined => {
  if (typeof body !== "object" || body === null) return undefined;
  const list = (body as { data?: unknown; models?: unknown }).data ?? (body as { models?: unknown }).models;
  return Array.isArray(list) ? list.length : undefined;
};

/** What a body says, briefly: its error's message. */
const messageIn = (text: string): string => {
  try {
    const body = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown };
    const message = typeof body.error === "object" ? body.error?.message : (body.error ?? body.message);
    if (typeof message === "string" && message.trim() !== "") return message.trim();
  } catch {
    // Not JSON: the status says it.
  }
  return "";
};

/** Gemini's answer to a key that is no key: a 400, not a 401. */
const INVALID_KEY = /API_KEY_INVALID|API key not valid/;

/**
 * What a refusal of the key says, when the answer is one: a 401, or Gemini's 400 for an invalid key. A 403 is none: a
 * key that may not list models (an OpenAI key restricted from them) can still chat.
 */
const refusalOf = async (response: Response): Promise<{ readonly status: number; readonly detail: string } | undefined> => {
  if (response.status !== 401 && response.status !== 400) return undefined;
  const text = await response.text().catch(() => "");
  if (response.status === 400 && !INVALID_KEY.test(text)) return undefined;
  return { status: response.status, detail: messageIn(text) };
};

/**
 * A check for keys to `provider`, from the wire API and base URL of its models: it lists the models with the key, and
 * says only what that shows of the key. The list must refuse a request without a key, else it is public and shows
 * nothing either way (some refuse every key, some take any): then a refusal of the key (`refusalOf`) counts against it,
 * and a list it reads says it works. Anything else (a 403, no list, the network failing, a timeout) takes it unchecked.
 * Undefined for a provider whose list it cannot ask.
 */
export function keyCheck(provider: Provider, fetchImpl: typeof fetch): KeyCheck | undefined {
  const model = provider.getModels()[0] as Model<Api> | undefined;
  const lister = model === undefined ? undefined : LISTERS[model.api];
  if (model === undefined || lister === undefined || !askable(model.baseUrl)) return undefined;
  const baseUrl = model.baseUrl.replace(/\/+$/, "");
  const ask = (key: string | undefined, signal: AbortSignal) => {
    const { url, headers } = lister(baseUrl, key);
    return fetchImpl(url, { headers: { accept: "application/json", "user-agent": USER_AGENT, ...headers }, signal });
  };
  return async (key, signal) => {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(CHECK_TIMEOUT_MS)]);
    try {
      const keyed = await ask(key, bounded);
      const models = keyed.ok ? count(await keyed.json().catch(() => undefined)) : undefined;
      const refusal = keyed.ok ? undefined : await refusalOf(keyed);
      if (!keyed.ok && refusal === undefined) return { verdict: "unknown" };
      // A list anyone may read says nothing of a key, either way: asked without one, it answers the same.
      const open = await ask(undefined, bounded).then(
        (unkeyed) => unkeyed.ok,
        () => true,
      );
      if (open) return { verdict: "unknown" };
      if (refusal === undefined) return models === undefined ? { verdict: "works" } : { verdict: "works", models };
      return { verdict: "refused", problem: `${provider.name} refused this key (${refusal.status}${refusal.detail === "" ? "" : `: ${refusal.detail}`})` };
    } catch (error) {
      // Stopped by the login, not by the clock: the login is ending.
      if (signal.aborted) throw error;
      return { verdict: "unknown" };
    }
  };
}
