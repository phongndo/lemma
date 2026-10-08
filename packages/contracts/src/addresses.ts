/*
 * Ways into the web app from outside it: an address on the host that serves
 * it, and a desktop deep link (`lemma://threads/<id>`). The addresses
 * themselves are routes (`@lemma/router`), declared by what they name: a
 * session's in `sessions.ts`, a web app plugin's own with `defineRoute`.
 */

/** The scheme of desktop deep links: `lemma://threads/<id>` opens that address in the app. */
export const DEEP_LINK_SCHEME = "lemma";

/**
 * The web app at `path` on the host serving it at `base`, with the token the page takes from `?token=` (and then hides).
 * Throws for a `path` that resolves to another origin: the token goes only to the host it belongs to.
 */
export const appUrl = (base: string, path: string, token?: string): string => {
  const url = new URL(path, base);
  if (url.origin !== new URL(base).origin) throw new Error(`Not an address in the app: ${path}`);
  if (token !== undefined && token !== "") url.searchParams.set("token", token);
  return url.href;
};

/**
 * The app's own address in a deep link (`lemma://threads/abc?x=1`, or
 * `lemma:///threads/abc`): `/threads/abc?x=1`. Undefined for anything that
 * is not one, a fragment and `token` dropped: a link names a page, not a
 * credential.
 */
export const deepLinkPath = (link: string): string | undefined => {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return undefined;
  }
  if (url.protocol !== `${DEEP_LINK_SCHEME}:`) return undefined;
  const path = `/${url.host}${url.pathname}`.replace(/\/{2,}/g, "/");
  // A path an http address reads as another host's (`/\evil.com`, where `\` is `/`) is not one of the app's.
  const origin = "http://app.invalid";
  if (new URL(path, origin).origin !== origin) return undefined;
  url.searchParams.delete("token");
  return `${path}${url.search}`;
};
