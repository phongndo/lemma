import { arch, platform, release } from "node:os";

/** How Lemma names itself to providers, in place of pi-ai's `pi (<os> <release>; <arch>)`. */
export const USER_AGENT = `lemma (${platform()} ${release()}; ${arch()})`;

/**
 * Headers that name Lemma on a model request, unless the model sends its own `User-Agent` (a custom provider's
 * `headers` may set one). pi-ai lets request headers override its own.
 */
export const identityHeaders = (model: { readonly headers?: Readonly<Record<string, string>> }): Record<string, string> | undefined =>
  Object.keys(model.headers ?? {}).some((name) => name.toLowerCase() === "user-agent") ? undefined : { "User-Agent": USER_AGENT };
