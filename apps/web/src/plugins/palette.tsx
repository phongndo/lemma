import { For, Show, createEffect, createMemo, createSignal, createUniqueId, on, onCleanup, onMount } from "solid-js";
import type { Component } from "solid-js";
import { Portal } from "solid-js/web";
import type { CommandInfo, InteractionRequest } from "@lemma/contracts";
import { shownKeys } from "../model/keybindings.ts";
import { formatKeys, shortcut } from "../lib/keys.ts";
import { load, save } from "../lib/storage.ts";
import { relativeTime, tildePath } from "../model/format.ts";
import { parseQuery, rank, remember } from "../model/palette.ts";
import type { Searchable } from "../model/palette.ts";
import { sessionTitle } from "../model/threads.ts";
import { ActionIds, Actions, Client, Commands, Dialogs, Interactions, Layers, PaletteSources, Threads, Slots, UiPlugins, Workspace } from "../ui/contracts.ts";
import type { DialogsService, InteractionsService, PaletteItem, PaletteSource } from "../ui/contracts.ts";
import { defineUiPlugin } from "../ui/define.ts";
import type { SlotsService } from "../ui/slots.ts";
import {
  ChatIcon,
  CheckIcon,
  ChevronIcon,
  CommandIcon,
  FolderIcon,
  GitBranchIcon,
  Isolated,
  KeyIcon,
  PuzzleIcon,
  RefreshIcon,
  Spinner,
  Highlighted,
} from "../ui/parts.tsx";
import styles from "./palette.css?inline";

const DIALOG = "palette";

interface Deps {
  readonly interactions: InteractionsService;
  readonly dialogs: DialogsService;
  readonly slots: SlotsService;
  /** An action to ask for at once when the palette opens: its keys were pressed and it needs a value. Taken once read. */
  readonly takeRequested: () => string | undefined;
}

/** A row: a source's item, or an option of a question (which has nothing to run). */
type Item = Omit<PaletteItem, "run"> & Searchable & { readonly run?: PaletteItem["run"] };

/** What the palette asks: a host question, or one of its own (renaming a session). */
type Question =
  | { readonly type: "select"; readonly title: string; readonly detail?: string | undefined; readonly options: readonly Item[] }
  | { readonly type: "ask"; readonly title: string; readonly placeholder?: string | undefined; readonly secret?: boolean | undefined }
  | { readonly type: "confirm"; readonly title: string; readonly detail?: string | undefined };

interface Asking {
  readonly id: string;
  readonly question: Question;
  readonly answer: (value: string) => void;
  readonly dismiss: () => void;
}

const RECENT_KEY = "lemma.palette.recent";
const SESSIONS_BROWSED = 8;
const RESULTS = 60;

const loadRecent = (): string[] => {
  try {
    const parsed: unknown = JSON.parse(load(RECENT_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === "string") : [];
  } catch {
    return [];
  }
};

const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

const hostIcon = (command: CommandInfo): Component => {
  switch (command.category) {
    case "Git":
      return GitBranchIcon;
    case "Host":
      return command.id === "host.reload" ? RefreshIcon : PuzzleIcon;
    case "Providers":
      return KeyIcon;
    default:
      return CommandIcon;
  }
};

const fromInteraction = (request: InteractionRequest): Question => {
  switch (request.type) {
    case "select":
      return {
        type: "select",
        title: request.title,
        detail: request.detail,
        options: request.options.map((option) => ({
          key: option.value,
          title: option.label,
          detail: option.description,
          keywords: [option.value, ...(option.description === undefined ? [] : [option.description])],
        })),
      };
    case "ask":
      return { type: "ask", title: request.title, placeholder: request.placeholder, secret: request.secret };
    case "confirm":
      return { type: "confirm", title: request.title, detail: request.detail };
  }
};

const CONFIRM: readonly Item[] = [
  { key: "yes", title: "Yes" },
  { key: "no", title: "No" },
];

/**
 * Cmd+K (Ctrl+K on Windows and Linux): search everything the app can do or
 * open. Every plugin's actions, the host's commands, threads, and projects
 * share one ranked list; `>`, `@`, and `#` narrow it. While open, the palette
 * shows the host's questions in place of the question dialog, so a command
 * that asks (which branch? what name?) continues here.
 */
function Palette(props: { deps: Deps }) {
  const { interactions, dialogs, slots } = props.deps;
  const [query, setQuery] = createSignal("");
  const [filter, setFilter] = createSignal("");
  const [active, setActive] = createSignal(0);
  const [running, setRunning] = createSignal<Item | undefined>();
  const [local, setLocal] = createSignal<Asking | undefined>();
  const [recent, setRecent] = createSignal(loadRecent());
  let input!: HTMLInputElement;
  let list!: HTMLDivElement;
  const previous = document.activeElement as HTMLElement | null;
  let disposed = false;
  // The host's questions show here while the palette is open.
  onCleanup(interactions.claim());

  const close = () => {
    dialogs.open(undefined);
  };
  const choose = (item: Item) => {
    const next = remember(recent(), item.key);
    setRecent(next);
    save(RECENT_KEY, JSON.stringify(next));
    if (item.input !== undefined) return void setLocal(askFor(item, item.input()));
    if (item.keepOpen === true) return void execute(item);
    // Closing puts focus back first, so an item that opens a dialog or focuses the prompt keeps its focus.
    close();
    queueMicrotask(() => void item.run?.());
  };
  /** Runs with the palette open, showing the questions it asks, until it settles. */
  const execute = async (item: Item) => {
    setRunning(item);
    setQuery("");
    const outcome = await Promise.resolve(item.run?.()).catch(() => false);
    // This palette may have closed while it ran; a palette opened since is not its to close.
    if (disposed || running() !== item) return;
    setRunning(undefined);
    if (outcome !== false && dialogs.current() === DIALOG) close();
  };

  // ---------------------------------------------------------------- items

  /** An item that asks for a value first asks here; answering runs it. */
  const askFor = (item: Item, question: { readonly title: string; readonly placeholder?: string }): Asking => ({
    id: `input:${item.key}`,
    question: { type: "ask", title: question.title, placeholder: question.placeholder },
    answer: (value) => {
      setLocal(undefined);
      close();
      void item.run?.(value);
    },
    dismiss: () => setLocal(undefined),
  });

  const sources = () => slots.list(PaletteSources);
  const prefixes = createMemo(() => sources().flatMap((source) => (source.prefix === undefined ? [] : [source.prefix])));
  /** What a search looks through: every source, or the one whose prefix leads the query. */
  const pool = (prefix: string | undefined): Item[] =>
    (prefix === undefined ? sources() : sources().filter((source) => source.prefix === prefix)).flatMap((source) => [...source.items()]);

  // ---------------------------------------------------------------- questions

  // Host questions take precedence: a running command is waiting on them.
  const asking = createMemo((): Asking | undefined => {
    const request = interactions.open()[0];
    if (request === undefined) return local();
    return {
      id: request.id,
      question: fromInteraction(request),
      answer: (value) =>
        interactions.answer(
          request.id,
          request.type === "confirm"
            ? { type: "confirm", value: value === "yes" }
            : request.type === "ask"
              ? { type: "ask", value }
              : { type: "select", value },
        ),
      dismiss: () => interactions.dismiss(request.id),
    };
  });

  // A new question starts with an empty field and the first option.
  createEffect(
    on(
      () => asking()?.id,
      () => {
        setFilter("");
        setActive(0);
        queueMicrotask(() => input?.focus());
      },
    ),
  );

  // ---------------------------------------------------------------- rows

  type Row =
    | { readonly type: "heading"; readonly label: string }
    | { readonly type: "item"; readonly item: Item; readonly matches: readonly number[]; readonly index: number };

  const rows = createMemo((): Row[] => {
    const current = asking();
    if (current !== undefined) {
      const question = current.question;
      if (question.type === "ask") return [];
      const options = question.type === "confirm" ? CONFIRM : question.options;
      return rank(options, filter()).map((ranked, index) => ({ type: "item", item: ranked.item, matches: ranked.matches, index }));
    }
    if (running() !== undefined) return [];
    const { prefix, text } = parseQuery(query(), prefixes());
    let index = 0;
    const item = (entry: { item: Item; matches: readonly number[] }): Row => ({ type: "item", ...entry, index: index++ });
    if (text.trim() !== "") return rank(pool(prefix), text, recent()).slice(0, RESULTS).map(item);
    if (prefix !== undefined) return pool(prefix).map((entry) => item({ item: entry, matches: [] }));
    // Browsing: recent choices, then each source in order (commands, the latest threads, projects, and what plugins add).
    const all = pool(undefined);
    const byKey = new Map(all.map((entry) => [entry.key, entry]));
    const recentItems = recent()
      .map((key) => byKey.get(key))
      .filter((entry): entry is Item => entry !== undefined)
      .slice(0, 5);
    const shown = new Set(recentItems.map((entry) => entry.key));
    // A source without a heading (commands) leads; the others are named so the switch from actions to places is visible.
    const section = (label: string | undefined, items: readonly Item[]): Row[] =>
      items.length === 0
        ? []
        : [...(label === undefined ? [] : [{ type: "heading" as const, label }]), ...items.map((entry) => item({ item: entry, matches: [] }))];
    return [
      ...section("Recent", recentItems),
      ...sources().flatMap((source) =>
        section(
          source.heading,
          source
            .items()
            .filter((entry) => !shown.has(entry.key))
            .slice(0, source.browse ?? Number.POSITIVE_INFINITY),
        ),
      ),
    ];
  });

  const items = createMemo(() => rows().filter((row): row is Extract<Row, { type: "item" }> => row.type === "item"));

  createEffect(on([query, filter], () => setActive(0), { defer: true }));
  createEffect(
    on(active, (index) => {
      list?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
    }),
  );

  // ---------------------------------------------------------------- keys

  const move = (by: number) => {
    const count = items().length;
    if (count > 0) setActive((index) => (index + by + count) % count);
  };

  const submit = () => {
    const current = asking();
    if (current !== undefined) {
      if (current.question.type === "ask") {
        if (filter().trim() !== "") current.answer(filter());
        return;
      }
      const picked = items()[active()];
      if (picked !== undefined) current.answer(picked.item.key);
      return;
    }
    const picked = items()[active()]?.item;
    if (picked === undefined) return;
    choose(picked);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.isComposing) return;
    const ctrlOnly = event.ctrlKey && !event.metaKey && !event.altKey;
    if (event.key === "ArrowDown" || (ctrlOnly && event.key === "n")) {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowUp" || (ctrlOnly && event.key === "p")) {
      event.preventDefault();
      move(-1);
    } else if (event.key === "PageDown") {
      event.preventDefault();
      move(Math.min(8, items().length - 1 - active()));
    } else if (event.key === "PageUp") {
      event.preventDefault();
      move(-Math.min(8, active()));
    } else if (event.key === "Enter") {
      event.preventDefault();
      submit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      const current = asking();
      // Dismissing a command's question cancels the command; the palette stays for the next thing.
      if (current !== undefined) current.dismiss();
      else if (running() === undefined && query() !== "") setQuery("");
      else close();
    } else if (event.key === "Backspace" && local() !== undefined && filter() === "") {
      event.preventDefault();
      setLocal(undefined);
    } else if (event.key === "Tab") {
      event.preventDefault();
    }
  };

  onMount(() => {
    const requested = props.deps.takeRequested();
    const item = requested === undefined ? undefined : pool(undefined).find((candidate) => candidate.key === `action:${requested}`);
    if (item?.input !== undefined) setLocal(askFor(item, item.input()));
    queueMicrotask(() => input.focus());
  });
  onCleanup(() => {
    disposed = true;
    previous?.focus?.();
  });

  // ---------------------------------------------------------------- view

  const value = () => (asking() === undefined ? query() : filter());
  const setValue = (next: string) => (asking() === undefined ? setQuery(next) : setFilter(next));
  const placeholder = () => {
    const question = asking()?.question;
    if (question?.type === "ask") return question.placeholder ?? "Type an answer";
    if (question !== undefined) return "Filter";
    if (running() !== undefined) return `Running ${running()!.title.replace(/…$/, "")}…`;
    return "Search commands, threads, and projects";
  };
  const heading = () => {
    const question = asking()?.question;
    const command = running()?.title.replace(/…$/, "");
    if (question === undefined) return command;
    return command === undefined ? question.title : `${command} › ${question.title}`;
  };
  const secret = () => {
    const question = asking()?.question;
    return question?.type === "ask" && question.secret === true;
  };
  /** What a question is about (the command a tool asks to run, say), shown under the field. */
  const questionDetail = () => {
    const question = asking()?.question;
    return question?.type === "confirm" || question?.type === "select" ? question.detail : undefined;
  };
  // Unique per instance: the page could show two lists.
  const listId = `palette-list-${createUniqueId()}`;
  const activeId = () => (items()[active()] === undefined ? undefined : `${listId}-${active()}`);

  return (
    <Portal>
      <div
        class="backdrop palette-backdrop"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) close();
        }}
      >
        <div class="palette" role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={onKeyDown}>
          <Show when={heading()}>
            <div class="palette-heading">{heading()}</div>
          </Show>
          <div class="palette-input palette-input-text">
            <Show when={running() !== undefined && asking() === undefined} fallback={<ChevronIcon />}>
              <Spinner />
            </Show>
            <input
              ref={input}
              type={secret() ? "password" : "text"}
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={activeId()}
              aria-label={asking()?.question.title ?? "Search commands, threads, and projects"}
              autocomplete="off"
              autocapitalize="off"
              spellcheck={false}
              placeholder={placeholder()}
              // Read-only, not disabled, while a command runs: a disabled field drops focus, and with it Esc and typing once the command ends.
              readOnly={asking() === undefined && running() !== undefined}
              value={value()}
              onInput={(event) => setValue(event.currentTarget.value)}
            />
          </div>
          <Show when={questionDetail()}>{(detail) => <p class="palette-question-detail">{detail()}</p>}</Show>
          <Show when={rows().length > 0}>
            <div ref={list} id={listId} class="palette-list" role="listbox" aria-label="Results">
              <For each={rows()}>
                {(row) =>
                  row.type === "heading" ? (
                    <div class="palette-section" role="presentation">
                      {row.label}
                    </div>
                  ) : (
                    <div
                      id={`${listId}-${row.index}`}
                      class="palette-row"
                      role="option"
                      data-index={row.index}
                      data-active={String(row.index === active())}
                      aria-selected={row.index === active()}
                      onPointerMove={() => setActive(row.index)}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        setActive(row.index);
                        submit();
                      }}
                    >
                      <Show when={row.item.icon}>{(icon) => <Isolated component={icon()} />}</Show>
                      <span class="palette-name">
                        <Show when={row.item.category}>
                          <span class="palette-category">{row.item.category}: </span>
                        </Show>
                        <Highlighted text={row.item.title} matches={row.matches} />
                      </span>
                      <span class="palette-hint">{row.item.detail}</span>
                      <Show when={row.item.shortcut}>
                        <kbd class="palette-kbd">{row.item.shortcut}</kbd>
                      </Show>
                      <Show when={row.item.current}>
                        <span class="palette-current" aria-label="current">
                          <CheckIcon />
                        </span>
                      </Show>
                    </div>
                  )
                }
              </For>
            </div>
          </Show>
          <Show when={rows().length === 0 && asking() === undefined && running() === undefined}>
            <div class="palette-empty">Nothing matches “{parseQuery(query(), prefixes()).text.trim()}”</div>
          </Show>
          <footer class="palette-foot">
            <Show
              when={asking() === undefined}
              fallback={
                <>
                  <span>
                    <kbd>↵</kbd> {asking()?.question.type === "ask" ? "submit" : "choose"}
                  </span>
                  <span>
                    <kbd>esc</kbd> {local() === undefined ? "cancel" : "back"}
                  </span>
                </>
              }
            >
              <span>
                <kbd>↑</kbd>
                <kbd>↓</kbd> move
              </span>
              <span>
                <kbd>↵</kbd> run
              </span>
              <span>
                <For each={sources().filter((source) => source.prefix !== undefined)}>
                  {(source) => (
                    <>
                      <kbd>{source.prefix}</kbd> {source.label}{" "}
                    </>
                  )}
                </For>
              </span>
              <span class="palette-foot-end">
                <kbd>{shortcut("mod", "K")}</kbd> close
              </span>
            </Show>
          </footer>
        </div>
      </div>
    </Portal>
  );
}

/** Search and run everything: plugins' actions, the host's commands, threads, projects. */
export default defineUiPlugin({
  id: "palette",
  styles,
  requires: {
    client: Client,
    threads: Threads,
    workspace: Workspace,
    commands: Commands,
    interactions: Interactions,
    dialogs: Dialogs,
    uiPlugins: UiPlugins,
    slots: Slots,
  },
  setup: (services) => {
    const { client, threads, workspace, commands, dialogs, interactions, uiPlugins, slots } = services;
    let requested: string | undefined;
    const deps: Deps = {
      interactions,
      dialogs,
      slots,
      takeRequested: () => {
        const id = requested;
        requested = undefined;
        return id;
      },
    };
    // Its own sources go through the slot a plugin adds a source to (files, symbols): they are defaults, not built in.
    const source = (id: string, order: number, value: PaletteSource) => slots.add(PaletteSources, { id, order, ...value });
    source("palette.commands", 0, {
      label: "commands",
      prefix: ">",
      items: () => [
        ...slots
          .list(Actions)
          .filter((action) => action.hidden !== true && (action.when?.() ?? true))
          .map((action): PaletteItem => {
            const keys = shownKeys(action, uiPlugins.list());
            return {
              key: `action:${action.id}`,
              category: action.category,
              title: action.title,
              detail: action.detail,
              keywords: action.keywords,
              shortcut: keys === undefined ? undefined : formatKeys(keys),
              icon: action.icon,
              input: action.input,
              run: (value) => action.run(value),
            };
          }),
        // The host's commands run with the palette open, which shows the questions they ask.
        ...commands.list().map((command): PaletteItem => ({
          key: `command:${command.id}`,
          category: command.category,
          title: command.title,
          detail: command.description,
          keywords: [...(command.keywords ?? []), ...(command.category === undefined ? [] : [command.category]), command.id],
          icon: hostIcon(command),
          keepOpen: true,
          run: () => commands.run(command),
        })),
      ],
    });
    source("palette.threads", 10, {
      label: "threads",
      heading: "Threads",
      prefix: "@",
      browse: SESSIONS_BROWSED,
      items: () =>
        [...threads.list()]
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .map((session) => ({
            key: `session:${session.id}`,
            title: sessionTitle(session),
            detail: `${workspace.projectName(session.cwd)} · ${relativeTime(session.updatedAt)}`,
            keywords: [workspace.projectName(session.cwd), basename(session.cwd), session.id],
            current: session.id === threads.activeId(),
            icon: ChatIcon,
            run: () => void threads.select(session.id),
          })),
    });
    source("palette.projects", 20, {
      label: "projects",
      heading: "Projects",
      prefix: "#",
      items: () => {
        return workspace.projects().map((path) => ({
          key: `project:${path}`,
          title: workspace.projectName(path),
          detail: tildePath(path, client.info()?.home),
          keywords: [path, basename(path)],
          icon: FolderIcon,
          run: () => threads.newThread(path),
        }));
      },
    });
    slots.add(Layers, {
      id: DIALOG,
      component: () => (
        <Show when={dialogs.current() === DIALOG}>
          <Palette deps={deps} />
        </Show>
      ),
    });
    slots.add(Actions, {
      id: ActionIds.palette,
      title: "Command palette",
      icon: CommandIcon,
      hidden: true,
      keys: "mod+k",
      // Opens over any other dialog; a question the host asks keeps the screen until answered.
      global: true,
      when: () => dialogs.current() === DIALOG || interactions.open().length === 0,
      // With an action's id, opens asking for that action's value (the keymap does this for an action that needs one).
      run: (actionId) => {
        if (actionId !== undefined) {
          requested = actionId;
          dialogs.open(undefined);
          queueMicrotask(() => dialogs.open(DIALOG));
        } else dialogs.open(dialogs.current() === DIALOG ? undefined : DIALOG);
      },
    });
  },
});
