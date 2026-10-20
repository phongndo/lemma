import { arch, platform, release } from "node:os";

/** How Lemma names itself to providers: `lemma (<os> <release>; <arch>)`. */
export const USER_AGENT = `lemma (${platform()} ${release()}; ${arch()})`;

/** A model request's `headers`, naming Lemma unless they name their own `User-Agent` (Copilot's requests name Copilot Chat). */
export const withIdentity = (headers: Readonly<Record<string, string>>): Record<string, string> =>
  Object.keys(headers).some((name) => name.toLowerCase() === "user-agent") ? { ...headers } : { ...headers, "User-Agent": USER_AGENT };
