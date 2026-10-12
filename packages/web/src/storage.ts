/** localStorage that tolerates being disabled or full. */
export const load = (key: string): string | undefined => {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
};

export const save = (key: string, value: string | undefined): void => {
  try {
    if (value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
};

/**
 * A stored JSON value `is` takes, or `fallback` when it is absent, unreadable, or of another shape: written by an older
 * version, or by another plugin under the same key. Name a key for its plugin (`lemma.<plugin id>.<what>`), so it
 * meets no other's.
 */
export const loadJson = <A>(key: string, fallback: A, is: (value: unknown) => value is A): A => {
  try {
    const value: unknown = JSON.parse(load(key) ?? "");
    return is(value) ? value : fallback;
  } catch {
    return fallback;
  }
};

/** A stored list of strings (ids, paths), without what is not one; empty when there is none. */
export const loadStrings = (key: string): string[] => loadJson<unknown[]>(key, [], Array.isArray).filter((item): item is string => typeof item === "string");

/** An object (not an array), each of whose values `of` takes. */
export const recordOf =
  <A>(of: (value: unknown) => value is A) =>
  (value: unknown): value is Record<string, A> =>
    typeof value === "object" && value !== null && !Array.isArray(value) && Object.values(value).every(of);
