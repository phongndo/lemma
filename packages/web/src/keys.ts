/** macOS writes app shortcuts with ⌘; Windows and Linux with Ctrl. */
export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

/** What bindings read of a key press: a DOM `KeyboardEvent`, or another's in its terms (the desktop app's pages'). */
export type KeyEvent = Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"> & Partial<Pick<KeyboardEvent, "getModifierState">>;

const modHeld = (event: Pick<KeyEvent, "metaKey" | "ctrlKey">, mac: boolean): boolean =>
  mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;

/**
 * Whether the platform's shortcut modifier is held: ⌘ on macOS, Ctrl elsewhere.
 * On macOS, Ctrl stays with text fields (Ctrl+K deletes to the end of the line).
 */
export const modKey = (event: Pick<KeyEvent, "metaKey" | "ctrlKey">): boolean => modHeld(event, isMac);

const MAC: Readonly<Record<string, string>> = { mod: "⌘", shift: "⇧", alt: "⌥", ctrl: "⌃" };
const OTHER: Readonly<Record<string, string>> = { mod: "Ctrl", shift: "Shift", alt: "Alt", ctrl: "Ctrl" };

/** `shortcut("mod", "shift", "O")` as the platform writes it: ⌘⇧O, or Ctrl+Shift+O. */
export const shortcut = (...keys: string[]): string => (isMac ? keys.map((key) => MAC[key] ?? key).join("") : keys.map((key) => OTHER[key] ?? key).join("+"));

/** A binding such as `mod+shift+o`, `escape`, or `/`: its modifiers and key, lowercase. */
const parse = (binding: string) => {
  const parts = binding.toLowerCase().split("+");
  const key = parts.at(-1)!;
  return { key, mod: parts.includes("mod"), shift: parts.includes("shift"), alt: parts.includes("alt") };
};

const NAMES: Readonly<Record<string, string>> = {
  escape: "Esc",
  enter: "↵",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  space: "Space",
  backspace: "⌫",
  delete: "Del",
  tab: "Tab",
  pageup: "PgUp",
  pagedown: "PgDn",
  home: "Home",
  end: "End",
};

/**
 * The key pressed, lowercase, as bindings name it. Letters and digits come from
 * the physical key, so ⌥K on a Mac (which types ˚) is still `k`; other keys
 * from what they type (`/`, `?`), and the space bar is `space`.
 */
const keyOf = (event: Pick<KeyboardEvent, "key" | "code">): string => {
  const physical = /^Key([A-Z])$/.exec(event.code)?.[1] ?? /^Digit(\d)$/.exec(event.code)?.[1];
  if (physical !== undefined) return physical.toLowerCase();
  return event.key === " " ? "space" : event.key.toLowerCase();
};

const MODIFIERS = new Set(["meta", "control", "alt", "altgraph", "shift", "os", "capslock", "fn"]);

/**
 * Whether AltGr is held: off macOS it reports as Ctrl+Alt, and what it presses types a character (AltGr+A is ą on a
 * Polish layout). Windows reports a real Ctrl+Alt as AltGr too on such layouts, so a binding is not refused for it: the
 * keymap lets it type while focus is in a text field, and a shortcut is never recorded from it. On macOS ⌥ is Alt.
 */
export const typedWithAltGr = (event: KeyEvent, mac = isMac): boolean => !mac && event.getModifierState?.("AltGraph") === true;

/**
 * The binding `event` presses, for recording a shortcut: `mod+shift+k`, `alt+arrowdown`, `/`.
 * Undefined for a modifier on its own. Shift is written for letters, digits, and named keys;
 * for a symbol it is part of typing it (`?`).
 */
export const bindingOf = (event: KeyEvent): string | undefined => {
  if (typedWithAltGr(event)) return undefined;
  const key = keyOf(event);
  if (MODIFIERS.has(key) || key === "dead" || key === "unidentified") return undefined;
  const named = key.length > 1 || /^[a-z0-9]$/.test(key);
  const parts = [...(modKey(event) ? ["mod"] : []), ...(event.shiftKey && named ? ["shift"] : []), ...(event.altKey ? ["alt"] : []), key];
  return parts.join("+");
};

/** A binding as the platform writes it: `mod+shift+o` is ⌘⇧O or Ctrl+Shift+O. */
export const formatKeys = (binding: string): string => {
  const { key, mod, shift, alt } = parse(binding);
  return shortcut(...(mod ? ["mod"] : []), ...(shift ? ["shift"] : []), ...(alt ? ["alt"] : []), NAMES[key] ?? key.toUpperCase());
};

/** A label with the shortcut that does the same, when there is one: `Settings · ⌘,`. */
export const withKeys = (label: string, binding: string | undefined): string => (binding === undefined ? label : `${label} · ${formatKeys(binding)}`);

/** The symbol on a key, by its place (US layout): `]` on the key that types `}` with Shift. */
const SYMBOLS: Readonly<Record<string, string>> = {
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
};

/**
 * Whether `event` presses `binding`. Shift must match for letters and when the
 * binding names it; for other keys it is whatever the layout needs to type
 * them (`/`, `?`). A symbol the key does not type with Shift held (`mod+shift+]`
 * types `}`) is known by the key's place, Shift counting. `mac`: whether `mod` is ⌘, as on this platform when not said;
 * the desktop app's main process, matching its pages' keys, says.
 */
export const matchesKeys = (binding: string, event: KeyEvent, mac = isMac): boolean => {
  const { key, mod, shift, alt } = parse(binding);
  if (modHeld(event, mac) !== mod || event.altKey !== alt) return false;
  if (!mod && (event.ctrlKey || event.metaKey)) return false;
  if (keyOf(event) === key) return shift || /^[a-z0-9]$/.test(key) || key.length > 1 ? event.shiftKey === shift : true;
  return shift && event.shiftKey && SYMBOLS[event.code] === key;
};

/**
 * Whether `event` holds down all of `binding` but its key: the modifiers it names, and no others, so that its key alone
 * would finish it (Ctrl alone, off macOS, for `mod+1`). A binding without a modifier is never held, nor one while AltGr
 * is. `mac` as in `matchesKeys`.
 */
export const holdsKeys = (binding: string, event: KeyEvent, mac = isMac): boolean => {
  const { mod, shift, alt } = parse(binding);
  if ((!mod && !shift && !alt) || typedWithAltGr(event, mac)) return false;
  if (modHeld(event, mac) !== mod || event.shiftKey !== shift || event.altKey !== alt) return false;
  return mod || !(event.ctrlKey || event.metaKey);
};

/** A binding with no modifier types into a text field, so it waits until focus leaves one. */
export const bindsTyping = (binding: string): boolean => !parse(binding).mod;

/** Focus is in something that takes typing. */
export const typing = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

/** Where ↓ or ↑ moves from `index` in a list of `length`, staying in it; undefined for any other key. From nothing (-1), both go to the first. */
export const stepFor = (key: string, index: number, length: number): number | undefined =>
  key === "ArrowDown" ? Math.min(length - 1, index + 1) : key === "ArrowUp" ? Math.max(0, index - 1) : undefined;

/**
 * Where a key moves the choice in a radio group of `length` options, as ARIA's pattern has it: either arrow along
 * either axis, wrapping at the ends, and Home and End to the first and last. Undefined for any other key. The group is
 * one Tab stop (the checked option's `tabindex` 0, the rest -1), and moving checks the option moved to.
 */
export const radioStep = (key: string, index: number, length: number): number | undefined => {
  const step = key === "ArrowRight" || key === "ArrowDown" ? 1 : key === "ArrowLeft" || key === "ArrowUp" ? -1 : undefined;
  return step !== undefined ? (index + step + length) % length : key === "Home" ? 0 : key === "End" ? length - 1 : undefined;
};

/**
 * A radio group's keydown, on its `role="radiogroup"` element (or a tab list's, `role` "tab"): `radioStep` from the option
 * focused (else `checked`), focusing the `[role=…]` moved to and returning its index for the group to check. Undefined
 * for other keys, and with a modifier held (Alt+← is back).
 */
export const radioGroupKey = (event: KeyboardEvent & { readonly currentTarget: Element }, checked?: number, role = "radio"): number | undefined => {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return undefined;
  const radios = [...event.currentTarget.querySelectorAll<HTMLElement>(`[role=${role}]`)];
  const focused = radios.indexOf(document.activeElement as HTMLElement);
  const from = focused >= 0 ? focused : checked;
  const next = from === undefined ? undefined : radioStep(event.key, from, radios.length);
  if (next === undefined) return undefined;
  event.preventDefault();
  radios[next]?.focus();
  return next;
};

/** What a key does in a list being searched: moves the active item, or picks one of the first nine at once. */
export type ListKey = { readonly move: 1 | -1 } | { readonly pick: number };

/**
 * A search list's keys, the same in every one: ↓ and ↑, Ctrl+N and Ctrl+P, or
 * Ctrl+J and Ctrl+K move; mod+1 … mod+9 picks the item shown at that place
 * (⌘1 on macOS, Ctrl+1 elsewhere). Undefined for any other key, which stays the field's.
 * A list that a key of its own closes takes that key first: the palette's
 * `mod+k` closes it, where elsewhere Ctrl+K moves up.
 */
export const listKey = (event: KeyEvent): ListKey | undefined => {
  const key = keyOf(event);
  if (modKey(event) && !event.altKey && !event.shiftKey && /^[1-9]$/.test(key)) return { pick: Number(key) - 1 };
  if (event.altKey || event.shiftKey || event.metaKey) return undefined;
  if (key === "arrowdown" && !event.ctrlKey) return { move: 1 };
  if (key === "arrowup" && !event.ctrlKey) return { move: -1 };
  if (!event.ctrlKey) return undefined;
  return key === "n" || key === "j" ? { move: 1 } : key === "p" || key === "k" ? { move: -1 } : undefined;
};

/**
 * The quick-pick label for the item at `index` while the modifier is held (`⌘1`),
 * shown by the foundation's `[data-quick-key]` rule; undefined past the ninth.
 */
export const quickKey = (index: number): string | undefined => (index >= 0 && index < 9 ? formatKeys(`mod+${index + 1}`) : undefined);
