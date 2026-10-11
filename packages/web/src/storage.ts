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

/** A stored JSON value, or `fallback` when absent or unreadable. */
export const loadJson = <A>(key: string, fallback: A): A => {
  try {
    return JSON.parse(load(key) ?? "") as A;
  } catch {
    return fallback;
  }
};
