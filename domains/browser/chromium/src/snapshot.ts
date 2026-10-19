import { formatRef } from "@lemma/browser";
import type { ConsoleLevel, ConsoleMessage } from "@lemma/browser";

/** How much of a snapshot's tree reaches the model, in characters. */
export const MAX_TREE_CHARS = 20_000;
/** Console messages a tab keeps between snapshots, and the characters of each. */
export const MAX_CONSOLE_MESSAGES = 20;
export const MAX_CONSOLE_CHARS = 500;

/** Playwright's refs in an AI-mode snapshot (`[ref=e12]`, `[ref=f1e3]` in a frame) as this snapshot's own (`[ref=s3-e12]`). */
export const withGeneration = (tree: string, generation: number): string =>
  tree.replace(/\[ref=([a-z]\d+(?:[a-z]\d+)*)\]/gi, (_, element: string) => `[ref=${formatRef(generation, element)}]`);

/** A field's line with a value, and the field's ref: `- textbox "Password" [ref=e3]: …`, in a frame's refs too. */
const FIELD = /^\s*- (?:textbox|searchbox|spinbutton|combobox)\b.*\[ref=([a-z]\d+(?:[a-z]\d+)*)\][^\n]*?: /;

/** The refs of the fields in `tree` that show a value, which may be secret. */
export const fieldRefs = (tree: string): string[] =>
  tree.split("\n").flatMap((line) => {
    const ref = FIELD.exec(line)?.[1];
    return ref === undefined ? [] : [ref];
  });

/**
 * The tree with the value of each field in `secret` (refs of password fields, and fields drawn as dots) hidden, however
 * the snapshot wrote it: quoted, escaped, or trimmed.
 */
export const maskFields = (tree: string, secret: ReadonlySet<string>): string =>
  secret.size === 0
    ? tree
    : tree
        .split("\n")
        .map((line) => {
          const match = FIELD.exec(line);
          return match === null || !secret.has(match[1]!) ? line : `${match[0]}••••••`;
        })
        .join("\n");

/** The tree's first lines up to `max` characters, and a last line saying how much was cut and how to read it. */
export const capTree = (tree: string, max = MAX_TREE_CHARS): { readonly tree: string; readonly truncated: boolean } => {
  if (tree.length <= max) return { tree, truncated: false };
  const end = tree.lastIndexOf("\n", max);
  const kept = tree.slice(0, end > 0 ? end : max);
  const rest = tree.slice(kept.length);
  const lines = rest.split("\n").filter((line) => line.trim() !== "").length;
  return {
    tree: `${kept}\n[Snapshot cut here: ${lines} more lines (${Math.ceil(rest.length / 1024)} KB) not shown. Read the rest with browser_evaluate, or scroll and take another snapshot.]`,
    truncated: true,
  };
};

/** A console message's level, from Playwright's type. */
export const consoleLevel = (type: string): ConsoleLevel => (type === "warning" || type === "error" || type === "info" || type === "debug" ? type : "log");

/** A message as kept: its text cut to `MAX_CONSOLE_CHARS`. */
export const consoleMessage = (level: ConsoleLevel, text: string): ConsoleMessage => ({
  level,
  text: text.length > MAX_CONSOLE_CHARS ? `${text.slice(0, MAX_CONSOLE_CHARS)}…` : text,
});

/** Adds `message` to `kept`, keeping its newest `MAX_CONSOLE_MESSAGES`. */
export const keepMessage = (kept: ConsoleMessage[], message: ConsoleMessage): void => {
  kept.push(message);
  if (kept.length > MAX_CONSOLE_MESSAGES) kept.splice(0, kept.length - MAX_CONSOLE_MESSAGES);
};
