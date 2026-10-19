import { arch, platform, release } from "node:os";

/** How Lemma names itself to providers: `lemma (<os> <release>; <arch>)`. */
export const USER_AGENT = `lemma (${platform()} ${release()}; ${arch()})`;

/** Headers that name Lemma on a model request, unless the model sends its own `User-Agent`. */
export const identityHeaders = (model: { readonly headers?: Readonly<Record<string, string>> }): Record<string, string> | undefined =>
  Object.keys(model.headers ?? {}).some((name) => name.toLowerCase() === "user-agent") ? undefined : { "User-Agent": USER_AGENT };
