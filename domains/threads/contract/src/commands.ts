import type { PromptCommandArgument, PromptCommandShape, PromptSubcommand } from "./threads.ts";

/** A command or a subcommand, named: a `PromptCommands` item's name is its id. */
export type CommandNode = PromptSubcommand;

/** A word of a command line: its text (unquoted), and where it starts and ends in the line. */
export interface CommandWord {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  /** Quoted (`"my server"`) with no closing quote yet: it runs to the end of the line, spaces and all. */
  readonly open: boolean;
}

/**
 * A command line's words: runs of non-space, or quoted (`"my server"`, `\"` and `\\` escaped) to hold spaces. A
 * quote left open takes the rest of the line.
 */
export const commandWords = (line: string): readonly CommandWord[] => {
  const words: CommandWord[] = [];
  let at = 0;
  while (at < line.length) {
    if (/\s/.test(line[at]!)) {
      at++;
      continue;
    }
    const start = at;
    if (line[at] === '"') {
      let text = "";
      at++;
      while (at < line.length && line[at] !== '"') {
        if (line[at] === "\\" && at + 1 < line.length) at++;
        text += line[at++];
      }
      const open = at >= line.length;
      if (!open) at++;
      words.push({ text, start, end: at, open });
    } else {
      while (at < line.length && !/\s/.test(line[at]!)) at++;
      words.push({ text: line.slice(start, at), start, end: at, open: false });
    }
  }
  return words;
};

/** How a word is written on a command line: as is, or quoted when it has whitespace or quotes. */
export const commandWord = (text: string): string => (text === "" || /[\s"\\]/.test(text) ? `"${text.replace(/(["\\])/g, "\\$1")}"` : text);

/** The command a line's words name: from its first, down through each subcommand named after it, then its arguments. */
export interface ResolvedCommand {
  readonly root: CommandNode;
  /** The last named: the command, or the subcommand run. */
  readonly node: CommandNode;
  /** The canonical names from `root` to `node`. */
  readonly path: readonly string[];
  /** How many of the words name the path. */
  readonly named: number;
  /** The words after them. */
  readonly args: readonly string[];
}

/** The node in `nodes` called `word`, by its name or an alias. */
export const commandNamed = <N extends CommandNode>(nodes: readonly N[], word: string): N | undefined =>
  nodes.find((node) => node.name === word) ?? nodes.find((node) => node.aliases?.includes(word) === true);

export const resolveCommand = (commands: readonly CommandNode[], words: readonly string[]): ResolvedCommand | undefined => {
  const root = words[0] === undefined ? undefined : commandNamed(commands, words[0]);
  if (root === undefined) return undefined;
  let node: CommandNode = root;
  const path = [root.name];
  let named = 1;
  for (; named < words.length; named++) {
    const sub = commandNamed(node.subcommands ?? [], words[named]!);
    if (sub === undefined) break;
    node = sub;
    path.push(sub.name);
  }
  return { root, node, path, named, args: words.slice(named) };
};

/** Something in the tree runs here: without, the command is the host's, sent as typed. */
export const runsHere = (node: PromptCommandShape): boolean => node.run !== undefined || (node.subcommands ?? []).some(runsHere);

/** The argument the word at `index` (from 0, after the path) is: a repeating last one takes all after it. */
export const argumentAt = (args: readonly PromptCommandArgument[], index: number): PromptCommandArgument | undefined => {
  const last = args.at(-1);
  return args[index] ?? (last?.repeats === true || last?.rest === true ? last : undefined);
};

const argUsage = (arg: PromptCommandArgument) => {
  const name = `${arg.name}${arg.repeats === true ? "..." : ""}`;
  return arg.optional === true ? `[${name}]` : `<${name}>`;
};

/**
 * What a command takes from the word at `from` (after its path) on: with none typed yet and subcommands to choose,
 * their names (`<list|reconnect|tool>`, or `[…]` when it runs without one); otherwise its arguments' usage
 * (`<server> [focus]`).
 */
export const commandUsage = (node: PromptCommandShape, from = 0): string => {
  const subcommands = node.subcommands ?? [];
  if (from === 0 && subcommands.length > 0) {
    const names = subcommands.map((sub) => sub.name).join("|");
    return node.run !== undefined && missingArgument(node, 0) === undefined ? `[${names}]` : `<${names}>`;
  }
  const args = node.args ?? [];
  const last = args.at(-1);
  if (from < args.length) return args.slice(from).map(argUsage).join(" ");
  return last?.repeats === true ? argUsage(last) : "";
};

/** The first required argument the words given do not reach, if any. */
export const missingArgument = (node: PromptCommandShape, given: number): PromptCommandArgument | undefined =>
  (node.args ?? []).slice(given).find((arg) => arg.optional !== true);

/**
 * Why a command that runs here cannot run as typed: a word it does not take (a subcommand it has not, an argument too
 * many), or a subcommand or an argument it still needs. Undefined when it can.
 */
export const commandProblem = (resolved: ResolvedCommand): string | undefined => {
  const { node, path, args } = resolved;
  const name = `/${path.join(" ")}`;
  const declared = node.args ?? [];
  const last = declared.at(-1);
  if (args.length > declared.length && last?.rest !== true && last?.repeats !== true) {
    const extra = args[declared.length]!;
    if (declared.length === 0 && (node.subcommands ?? []).length > 0) return `${name} has no subcommand “${extra}”: ${commandUsage(node)}`;
    return declared.length === 0 ? `${name} takes nothing after it, not “${extra}”` : `${name} takes ${commandUsage(node)}, not “${extra}” too`;
  }
  if (node.run !== undefined && missingArgument(node, args.length) === undefined) return undefined;
  const usage = commandUsage(node, args.length);
  return `${name} needs ${usage === "" ? "more" : usage}`;
};

/** Sending it as it is runs it, or has the host answer it: a subcommand to choose or a required argument is not missing. */
export const complete = (root: CommandNode, node: CommandNode, given: number): boolean =>
  missingArgument(node, given) === undefined && (node.run !== undefined || (!runsHere(root) && (node.subcommands ?? []).length === 0));

/** A prompt that is a command (`/mcp tool github x hidden`): what it names, and the text after its path. */
export const commandInvocation = (
  prompt: string,
  commands: readonly CommandNode[],
  trigger = "/",
): (ResolvedCommand & { readonly text: string }) | undefined => {
  const trimmed = prompt.trim();
  if (!trimmed.startsWith(trigger)) return undefined;
  const line = trimmed.slice(trigger.length);
  const words = commandWords(line);
  if (words[0]?.start !== 0) return undefined;
  const resolved = resolveCommand(
    commands,
    words.map((word) => word.text),
  );
  if (resolved === undefined) return undefined;
  const after = words[resolved.named];
  return { ...resolved, text: after === undefined ? "" : line.slice(after.start).trim() };
};

/** `PromptCommands` items as nodes: each one's id is its name. */
export const commandNodes = (items: readonly (PromptCommandShape & { readonly id: string })[]): readonly CommandNode[] =>
  items.map((item) => ({ ...item, name: item.id }));
