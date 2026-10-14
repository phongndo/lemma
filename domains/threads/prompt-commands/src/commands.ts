import { rank } from "@lemma/web/match";
import { argumentAt, commandUsage, commandWord, commandWords, complete, resolveCommand } from "@lemma/threads";
import type { CommandNode, ComposerCompletionAnswer, ComposerSuggestion } from "@lemma/threads";

/**
 * The nodes the word `query` finds, best first, each once: by its name, or, once something is typed, by an alias
 * (then named so in its row). With nothing typed, all of them in order.
 */
const ranked = (nodes: readonly CommandNode[], query: string) => {
  const names = nodes.flatMap((node) => [
    { key: node.name, title: node.name, node, alias: false },
    ...(query === "" ? [] : (node.aliases ?? []).map((alias) => ({ key: `${node.name} ${alias}`, title: alias, node, alias: true }))),
  ]);
  const seen = new Set<CommandNode>();
  return rank(names, query).filter(({ item }) => {
    if (seen.has(item.node)) return false;
    seen.add(item.node);
    return true;
  });
};

/** A row for a command or subcommand, as `ranked` found it: what it takes, and what it does. */
const nodeRow = (root: CommandNode | undefined, found: ReturnType<typeof ranked>[number], before: string, top: boolean): ComposerSuggestion => {
  const { node, title, alias } = found.item;
  const usage = commandUsage(node);
  return {
    key: title,
    label: top ? `/${title}` : title,
    // The label's `/` is not in the name.
    matches: top ? found.matches.map((index) => index + 1) : found.matches,
    detail: alias ? `${top ? "/" : ""}${node.name} · ${node.description}` : node.description,
    hint: usage === "" ? undefined : usage,
    icon: node.icon,
    insert: `${before}${title}`,
    submit: complete(root ?? node, node, 0),
  };
};

/**
 * The `/` menu for a command line typed so far (`findCommandLine`'s query): the commands its first word finds; past
 * the words naming a command and its subcommands, the subcommands to choose and the values of the argument being
 * typed. Every row hints at what the line takes after it, and a line with nothing to offer hints at what it takes.
 * A pick writes the line up to it, and sends it (with Enter) once it needs nothing more.
 */
export const commandSuggestions = async (commands: readonly CommandNode[], query: string, signal: AbortSignal): Promise<ComposerCompletionAnswer> => {
  const words = commandWords(query);
  const last = words.at(-1);
  // The last word is being typed while the cursor is at its end, or inside its open quote.
  const typing = last !== undefined && (last.open || last.end === query.length);
  const current = typing ? last.text : "";
  const done = (typing ? words.slice(0, -1) : words).map((word) => word.text);
  if (done.length === 0) return ranked(commands, current).map((found) => nodeRow(undefined, found, "/", true));
  const resolved = resolveCommand(commands, done);
  if (resolved === undefined) return [];
  const { root, node, path, args } = resolved;
  const before = `/${done.map(commandWord).join(" ")} `;
  const rows = args.length === 0 ? ranked(node.subcommands ?? [], current).map((found) => nodeRow(root, found, before, false)) : [];
  const nodeArgs = node.args ?? [];
  // Past a `rest` argument, everything is its text.
  const restAt = nodeArgs.findIndex((arg) => arg.rest === true);
  const arg = restAt !== -1 && args.length > restAt ? undefined : argumentAt(nodeArgs, args.length);
  const hint = commandUsage(node, args.length);
  const values = arg?.values === undefined ? [] : await arg.values({ path, args, query: current, signal });
  const after = commandUsage(node, args.length + 1);
  const found =
    arg?.ranked === true
      ? values.map((item) => ({ item, matches: [] as readonly number[] }))
      : rank(
          values.map((value) => ({ ...value, key: value.value, title: value.value })),
          current,
        );
  for (const { item, matches } of found) {
    rows.push({
      key: `value:${item.value}`,
      label: item.value,
      matches,
      detail: item.detail,
      hint: after === "" ? undefined : after,
      insert: `${before}${commandWord(item.value)}`,
      submit: complete(root, node, args.length + 1),
    });
  }
  if (rows.length > 0) return { suggestions: rows, hint: current === "" ? hint : undefined };
  if (current !== "" && arg?.values !== undefined) return { suggestions: [], note: `No ${arg.name} matches “${current}”` };
  return { suggestions: [], hint: current === "" && hint !== "" ? hint : undefined };
};
