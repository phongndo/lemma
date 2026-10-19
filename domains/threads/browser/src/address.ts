/** Where a search goes when nothing else says: `%s` is what was typed. */
export const SEARCH = "https://duckduckgo.com/?q=%s";

/** This machine, a numbered address, or a machine named without a domain and given a port (`devbox:8080`): served over plain http, as a dev server is. */
const PLAIN = /^(?:(?:localhost|\[[0-9a-f:]+\]|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?|[a-z0-9-]+:\d+)$/i;
/** A dotted name ending in letters (`example.com`). */
const NAMED = /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?$/i;
/**
 * A name only this machine or this network answers to, as a dev server takes (`app.localhost:5173`, `site.test`,
 * `printer.local`): over plain http, as a browser opens `*.localhost`. The suffixes reserved for that.
 */
const LOCAL = /\.(?:localhost|test|local|internal|lan|home\.arpa)(?::\d+)?$/i;

const searchFor = (text: string, search: string): string => {
  const query = encodeURIComponent(text);
  return search.includes("%s") ? search.replace("%s", query) : `${search}${query}`;
};

const valid = (url: string): boolean => {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
};

/**
 * What the address bar goes to for `typed`: a web address as it is; this machine (`localhost:3000`), a numbered one,
 * one named with a port alone (`devbox:8080`), or one under a local name (`app.localhost:5173`, `site.test`) over
 * http, a domain (`example.com`) over https; anything else (words, another scheme) searched for, at `search`.
 * Undefined for nothing typed.
 */
export const addressOf = (typed: string, search = SEARCH): string | undefined => {
  const text = typed.trim();
  if (text === "") return undefined;
  if (/^https?:\/\//i.test(text) || /^about:blank$/i.test(text)) return valid(text) ? text : searchFor(text, search);
  if (/\s/.test(text)) return searchFor(text, search);
  const host = text.split(/[/?#]/, 1)[0] ?? "";
  const scheme = PLAIN.test(host) || (NAMED.test(host) && LOCAL.test(host)) ? "http" : NAMED.test(host) ? "https" : undefined;
  const url = scheme === undefined ? undefined : `${scheme}://${text}`;
  return url !== undefined && valid(url) ? url : searchFor(text, search);
};

/** A page's host, for naming its tab before it has a title. */
export const hostOf = (url: string | undefined): string | undefined => {
  if (url === undefined) return undefined;
  try {
    const host = new URL(url).host;
    return host === "" ? undefined : host;
  } catch {
    return undefined;
  }
};
