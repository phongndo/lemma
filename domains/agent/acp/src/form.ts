import type { AgentEntry } from "@lemma/agent/acp";

/*
 * The web half's model of adding and editing an agent: its command line as one string, its environment as rows, and
 * an id from a name. Pure, so it is tested without a page.
 */

/** Splits a command line as a shell would split simple words: on spaces, with single and double quotes, and `\` escaping. */
export function splitCommand(line: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote: '"' | "'" | undefined;
  let started = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else if (char === "\\" && quote === '"' && i + 1 < line.length) word += line[++i];
      else word += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (char === "\\" && i + 1 < line.length) {
      word += line[++i];
      started = true;
    } else if (/\s/.test(char)) {
      if (started || word !== "") words.push(word);
      word = "";
      started = false;
    } else word += char;
  }
  if (started || word !== "") words.push(word);
  return words;
}

/** The words as one command line `splitCommand` reads back. */
export const joinCommand = (words: readonly string[]): string =>
  words.map((word) => (word === "" || /[\s"'\\]/.test(word) ? `"${word.replace(/(["\\])/g, "\\$1")}"` : word)).join(" ");

/** An agent id made from a name: lowercase letters, digits, `_`, and `-`, at most 40. */
export const idFrom = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 40);

/** Whether `text` can be an icon: an `https:` address, or an image as a `data:` URL. */
export const isImageAddress = (text: string): boolean => /^https:\/\/\S+$/.test(text) || /^data:image\/[a-z0-9.+-]+(;[^,]*)?,.+$/i.test(text);

export type Rows = readonly { readonly name: string; readonly value: string }[];

/** What the form holds. */
export interface AgentDraft {
  readonly title: string;
  readonly command: string;
  readonly env: Rows;
  readonly mcp: boolean;
  /** Its icon's address; empty: the one Lemma or the registry gives it. */
  readonly icon?: string;
}

/**
 * The entry the form makes over `entry` (what the file has for the agent, whose other settings it keeps), or why it
 * cannot. Over a preset (`preset` its command line), an unchanged command line and title are left out, so the preset's
 * own (and its updates) still apply.
 */
export function entryFrom(
  draft: AgentDraft,
  entry: AgentEntry = {},
  preset?: { readonly title: string; readonly command: readonly string[] },
): { readonly entry: AgentEntry } | { readonly error: string } {
  const [command, ...args] = splitCommand(draft.command.trim());
  if (command === undefined || command === "") return { error: "Give the command that starts the agent speaking ACP" };
  const icon = (draft.icon ?? "").trim();
  if (icon !== "" && !isImageAddress(icon)) return { error: "The icon is an https: address or a data:image/ URL" };
  const { title: _title, command: _command, args: _args, env: _env, mcp: _mcp, icon: _icon, ...kept } = entry;
  const env = draft.env.filter((row) => row.name.trim() !== "");
  const same = preset !== undefined && joinCommand([command, ...args]) === joinCommand(preset.command);
  const title = draft.title.trim();
  return {
    entry: {
      ...kept,
      ...(title === "" || title === preset?.title ? {} : { title }),
      ...(same ? {} : { command, args }),
      ...(env.length === 0 ? {} : { env: Object.fromEntries(env.map((row) => [row.name.trim(), row.value])) }),
      ...(draft.mcp ? {} : { mcp: false }),
      ...(icon === "" ? {} : { icon }),
    },
  };
}
