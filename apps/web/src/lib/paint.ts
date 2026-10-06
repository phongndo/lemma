/*
 * The page's look as the DOM carries it: `data-theme` (`light` or `dark`) and
 * the `--content` width on `<html>` (see the DOM contracts in ui/contracts.ts).
 * One plugin applies it (the bundled `appearance`); stylesheets and renderers
 * read it. It is remembered so the next load paints it before any plugin runs,
 * and the page's default, with no plugin applying one, is the system theme.
 */

type Theme = "light" | "dark";
interface Look {
  readonly theme: Theme;
  /** A CSS length for `--content`; absent for the stylesheet's own. */
  readonly content?: string;
}

const KEY = "lemma.paint";
const root = () => document.documentElement;

const systemTheme = (): Theme => (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

const put = (look: Look, owner: string | undefined) => {
  root().dataset.theme = look.theme;
  if (look.content === undefined) root().style.removeProperty("--content");
  else root().style.setProperty("--content", look.content);
  if (owner === undefined) delete root().dataset.paintedBy;
  else root().dataset.paintedBy = owner;
};

/** Paints the remembered look, else the system theme: what the page shows before plugins start. */
export const preloadPaint = (): void => {
  let look: Look | undefined;
  try {
    look = JSON.parse(localStorage.getItem(KEY) ?? "null") ?? undefined;
  } catch {
    look = undefined;
  }
  put(look?.theme === "light" || look?.theme === "dark" ? look : { theme: systemTheme() }, undefined);
};

/** Applies `look` for `owner` (a plugin instance's own token) and remembers it for the next load. */
export const paint = (look: Look, owner: string): void => {
  put(look, owner);
  try {
    localStorage.setItem(KEY, JSON.stringify(look));
  } catch {
    /* storage disabled: the next load starts from the system theme */
  }
};

/**
 * `owner` stops applying a look: the page returns to the system theme and
 * forgets it, unless another owner (a replacement, which starts before the old
 * instance stops) has painted since.
 */
export const unpaint = (owner: string): void => {
  if (root().dataset.paintedBy !== owner) return;
  put({ theme: systemTheme() }, undefined);
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing remembered */
  }
};

/** The theme on the page now. */
export const currentTheme = (): Theme => (root().dataset.theme === "dark" ? "dark" : "light");

/** Calls `listener` whenever the page's theme changes; returns the unsubscribe. */
export const onThemeChange = (listener: (theme: Theme) => void): (() => void) => {
  const observer = new MutationObserver(() => listener(currentTheme()));
  observer.observe(root(), { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
};
