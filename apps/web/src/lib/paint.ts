/*
 * The page's look as the DOM carries it: `data-theme` (`light` or `dark`) and
 * tokens set over the stylesheet's own on `<html>`, such as the `--content`
 * width (see the DOM contracts in ui/contracts.ts).
 * One plugin applies it (the bundled `appearance`); stylesheets and renderers
 * read it. It is remembered so the next load paints it before any plugin runs,
 * and the page's default, with no plugin applying one, is the system theme.
 */

type Theme = "light" | "dark";
interface Look {
  readonly theme: Theme;
  /** Custom properties (`--accent`) over the stylesheet's own; one absent keeps the stylesheet's. */
  readonly tokens?: Readonly<Record<string, string>>;
}

const KEY = "lemma.paint";
const root = () => document.documentElement;

const systemTheme = (): Theme => (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

/** The tokens the last look set, which the next one removes unless it sets them too. */
let applied: readonly string[] = [];

const put = (look: Look, owner: string | undefined) => {
  root().dataset.theme = look.theme;
  const tokens = Object.entries(look.tokens ?? {}).filter(([name, value]) => name.startsWith("--") && typeof value === "string");
  for (const name of applied) if (!tokens.some(([set]) => set === name)) root().style.removeProperty(name);
  for (const [name, value] of tokens) root().style.setProperty(name, value);
  applied = tokens.map(([name]) => name);
  if (owner === undefined) delete root().dataset.paintedBy;
  else root().dataset.paintedBy = owner;
};

/**
 * Paints the remembered look, else the system theme: what the page shows
 * before plugins start. Not `remembered` (`?safe`, the way back from a look
 * that broke the page), the system theme alone.
 */
export const preloadPaint = (remembered = true): void => {
  let look: Look | undefined;
  try {
    look = remembered ? (JSON.parse(localStorage.getItem(KEY) ?? "null") ?? undefined) : undefined;
  } catch {
    look = undefined;
  }
  put(look?.theme === "light" || look?.theme === "dark" ? look : { theme: systemTheme() }, undefined);
};

/**
 * Once the plugins have started: a remembered look that no plugin painted
 * again belongs to none now (its painter is off, or another composition runs),
 * so the page returns to the system theme and forgets it.
 */
export const settlePaint = (): void => {
  if (root().dataset.paintedBy !== undefined) return;
  put({ theme: systemTheme() }, undefined);
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing remembered */
  }
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

/** A token's value on the page now: a look's, else the stylesheets'. */
export const currentToken = (name: string): string => getComputedStyle(root()).getPropertyValue(name).trim();

/**
 * Calls `listener` whenever the page's look may have changed: its theme or a
 * token a look sets on `<html>`, or a stylesheet coming, going, or changing
 * (a UI file's, a plugin's), once a linked one has loaded. Returns the
 * unsubscribe.
 */
export const onLookChange = (listener: () => void): (() => void) => {
  const painted = new MutationObserver(() => listener());
  painted.observe(root(), { attributes: true, attributeFilter: ["data-theme", "style"] });
  const loaded = () => listener();
  const linked = new Set<HTMLLinkElement>();
  const sheets = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof HTMLLinkElement)) continue;
        node.addEventListener("load", loaded, { once: true });
        linked.add(node);
      }
      for (const node of record.removedNodes) {
        if (!(node instanceof HTMLLinkElement)) continue;
        node.removeEventListener("load", loaded);
        linked.delete(node);
      }
    }
    listener();
  });
  sheets.observe(document.head, { childList: true, subtree: true, characterData: true });
  // Stylesheets linked before this subscribed and still loading (a UI file's, at boot) count too, once they load.
  for (const link of document.head.querySelectorAll<HTMLLinkElement>("link[rel=stylesheet]")) {
    if (link.sheet !== null) continue;
    link.addEventListener("load", loaded, { once: true });
    linked.add(link);
  }
  return () => {
    painted.disconnect();
    sheets.disconnect();
    for (const link of linked) link.removeEventListener("load", loaded);
  };
};

let swatch: CanvasRenderingContext2D | null | undefined;
/**
 * A token's color as an opaque `#rrggbb`, laid over the token `under` if it is
 * translucent: for a renderer that takes only plain colors (Mermaid, a canvas).
 */
export const tokenColor = (name: string, under = "--bg"): string => {
  const probe = document.createElement("span");
  probe.style.color = `var(${name})`;
  probe.style.backgroundColor = `var(${under})`;
  root().append(probe);
  const { color, backgroundColor } = getComputedStyle(probe);
  probe.remove();
  swatch ??= Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d", { willReadFrequently: true });
  if (swatch === null) return "#000000";
  swatch.fillStyle = backgroundColor;
  swatch.fillRect(0, 0, 1, 1);
  swatch.fillStyle = color;
  swatch.fillRect(0, 0, 1, 1);
  const [r, g, b] = swatch.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((channel) => channel!.toString(16).padStart(2, "0")).join("")}`;
};
