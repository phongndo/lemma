import { createMemo, createSignal, createEffect, onCleanup, untrack } from "solid-js";
import { ComposerCompletions, findCommandLine, findTrigger } from "@lemma/threads";
import type { ComposerCompletion, ComposerCompletionAnswer, ComposerSuggestion, TriggerMatch } from "@lemma/threads";
import type { SlotItem, SlotsService } from "@lemma/web";
import { wrapStep } from "@lemma/web/keys";

/** What one completion source has for the word: its suggestions and note, or why it has none. */
export interface CompletionGroup {
  readonly source: SlotItem<ComposerCompletion>;
  readonly suggestions: readonly ComposerSuggestion[];
  readonly loading: boolean;
  readonly note?: string | undefined;
  readonly hint?: string | undefined;
  readonly error?: string;
}

/** A suggestion in the menu: its group, its place across all groups, and a key that stays with it as answers arrive. */
export interface CompletionItem {
  readonly group: CompletionGroup;
  readonly suggestion: ComposerSuggestion;
  readonly index: number;
  readonly key: string;
}

const sameWord = (a: TriggerMatch | undefined, b: TriggerMatch | undefined) =>
  a?.trigger === b?.trigger && a?.query === b?.query && a?.start === b?.start && a?.end === b?.end;

const settled = (answer: ComposerCompletionAnswer): Omit<CompletionGroup, "source"> =>
  "suggestions" in answer ? { suggestions: answer.suggestions, note: answer.note, hint: answer.hint, loading: false } : { suggestions: answer, loading: false };
const failed = (error: unknown): Omit<CompletionGroup, "source"> => ({
  suggestions: [],
  loading: false,
  error: error instanceof Error ? error.message : String(error),
});

/**
 * The completion menu's state: the trigger word at the cursor, what every
 * source with that trigger suggests for it, and which suggestion is active.
 * Escape dismisses the word until the cursor leaves it. It looks for a word only while `asking`.
 */
export function createCompletion(slots: SlotsService, text: () => string, cursor: () => number, asking: () => boolean) {
  const sources = () => slots.list(ComposerCompletions);
  const spanOf = (source: ComposerCompletion) => source.span ?? "word";
  const triggers = (span: "word" | "line") => [...new Set(sources().flatMap((source) => (spanOf(source) === span ? [source.trigger] : [])))];
  // A command line (`/thinking hi`): its trigger starts the prompt, and it runs across spaces.
  const word = createMemo(
    (): (TriggerMatch & { readonly span: "word" | "line" }) | undefined => {
      if (!asking()) return undefined;
      // A word trigger past the line's own (`/compact keep @src/a`) completes that word, as anywhere else.
      const found = findTrigger(text(), cursor(), triggers("word"));
      if (found !== undefined && found.start > 0) return { ...found, span: "word" };
      const line = findCommandLine(text(), cursor(), triggers("line"));
      if (line !== undefined) return { ...line, span: "line" };
      return found === undefined ? undefined : { ...found, span: "word" };
    },
    undefined,
    { equals: (a, b) => a?.span === b?.span && sameWord(a, b) },
  );
  // The run of words starting at one place: the same object while the cursor stays in a word starting there, a new one
  // once it leaves (or there is none), so a dismissal of one run never covers the next word typed there.
  const run = createMemo(() => ({ start: word()?.start }), undefined, { equals: (a, b) => a.start === b.start });
  const [dismissed, setDismissed] = createSignal<{ readonly start: number | undefined }>();
  const match = createMemo(() => (run() === dismissed() ? undefined : word()));

  const [groups, setGroups] = createSignal<readonly CompletionGroup[]>([]);
  let shown: TriggerMatch | undefined;
  createEffect(() => {
    const current = match();
    const answering = current === undefined ? [] : sources().filter((source) => source.trigger === current.trigger && spanOf(source) === current.span);
    // Typing on in a word keeps what shows until the next answers arrive. Another word starts empty, and so does the
    // same word asked again because what a source read changed (another project): its old answer is not this one.
    const kept =
      current !== undefined && shown !== undefined && !sameWord(current, shown) && shown.trigger === current.trigger && shown.start === current.start;
    shown = current;
    if (current === undefined) return void setGroups([]);
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    const before = untrack(groups);
    setGroups(
      answering.map((source) => ({
        source,
        suggestions: kept ? (before.find((group) => group.source.id === source.id)?.suggestions ?? []) : [],
        loading: true,
      })),
    );
    const settle = (id: string, group: Omit<CompletionGroup, "source">) => {
      if (!controller.signal.aborted) setGroups((all) => all.map((existing) => (existing.source.id === id ? { source: existing.source, ...group } : existing)));
    };
    for (const source of answering) {
      // Asked here, inside the effect, so the reactive values it reads before its first await are tracked.
      let answer: ReturnType<ComposerCompletion["suggest"]>;
      try {
        answer = source.suggest(current.query, { signal: controller.signal });
      } catch (error) {
        settle(source.id, failed(error));
        continue;
      }
      Promise.resolve(answer).then(
        (result) => settle(source.id, settled(result)),
        (error: unknown) => settle(source.id, failed(error)),
      );
    }
  });

  const items = createMemo(() => {
    let index = 0;
    return groups().flatMap((group) =>
      group.suggestions.map((suggestion): CompletionItem => ({ group, suggestion, index: index++, key: `${group.source.id}\u0000${suggestion.key}` })),
    );
  });
  /** The groups with suggestions, each with its items: what the listbox shows. */
  const sections = createMemo(() =>
    groups()
      .filter((group) => group.suggestions.length > 0)
      .map((group) => ({ group, items: items().filter((item) => item.group.source.id === group.source.id) })),
  );
  // The active suggestion by its key, so it stays put while answers arrive; a new word starts at the first.
  const [chosenIn, setChosenIn] = createSignal<{ readonly word: TriggerMatch | undefined; readonly key: string | undefined }>();
  const chosen = () => {
    const choice = chosenIn();
    return choice?.word === match() ? choice?.key : undefined;
  };
  const setChosen = (key: string | undefined) => setChosenIn({ word: match(), key });
  const active = () => {
    const key = chosen();
    return Math.max(0, key === undefined ? 0 : items().findIndex((item) => item.key === key));
  };
  return {
    match,
    groups,
    items,
    sections,
    active,
    /** Some source has yet to answer this word. */
    loading: () => groups().some((group) => group.loading),
    setActive: (index: number) => setChosen(items()[index]?.key),
    open: () => {
      const current = match();
      if (current === undefined || groups().length === 0) return false;
      // Past a command's name, a line no source has anything for is just a prompt that starts with `/` (a path).
      const quiet = groups().every((group) => !group.loading && group.suggestions.length === 0 && group.note === undefined && group.error === undefined);
      return !(current.span === "line" && /\s/.test(current.query) && quiet);
    },
    move: (by: number) => {
      const all = items();
      if (all.length > 0) setChosen(all[wrapStep(active(), by, all.length)]!.key);
    },
    dismiss: () => setDismissed(match() === undefined ? undefined : run()),
  };
}

/**
 * What shows muted after the cursor while it ends the prompt: the rest of the active suggestion, when what is typed
 * begins it, and what follows it (`/mcp rec` → `onnect <server>`); with none active, what the word takes (`<server>`).
 */
export function ghostText(
  value: string,
  word: TriggerMatch,
  cursor: number,
  active: ComposerSuggestion | undefined,
  groups: readonly Pick<CompletionGroup, "hint">[],
): string {
  if (cursor !== value.length) return "";
  if (active === undefined) return groups.find((group) => group.hint !== undefined)?.hint ?? "";
  const typed = value.slice(word.start, cursor);
  const { insert, hint } = active;
  if (!insert.toLowerCase().startsWith(typed.toLowerCase())) return "";
  const rest = insert.slice(typed.length);
  return hint === undefined ? rest : `${rest} ${hint}`;
}
