import { Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import type { Component } from "solid-js";
import type { InteractionRequest } from "@lemma/contracts";
import type { CommandInfo } from "@lemma/commands";
import { keysFor, overridesFrom, shownKeys, ActionIds, Actions, PaletteSources } from "@lemma/actions";
import { formatKeys, matchesKeys } from "@lemma/web/keys";
import { loadStrings, save } from "@lemma/web/storage";
import { relativeTime, tildePath } from "@lemma/web/format";
import { rank, remember } from "@lemma/web/match";
import type { Searchable } from "@lemma/web/match";
import { isBlank, sessionTitle, Threads, ThreadWaits, waitingOn } from "@lemma/threads";
import { SessionChannels } from "@lemma/sessions";
import type { SessionInfo } from "@lemma/sessions";
import { Commands } from "@lemma/commands/web";
import { Dialogs, Layers } from "@lemma/frame";
import { Client, Interactions, Slots, WebPlugins, defineWebPlugin, Isolated, Highlighted, usePlugin } from "@lemma/web";
import { Workspace } from "@lemma/workspace/web";
import type { PaletteItem, PalettePage, PaletteSource } from "@lemma/actions";
import type { DialogsService } from "@lemma/frame";
import type { InteractionsService, SlotsService } from "@lemma/web";
import {
  ArrowLeftIcon,
  ChatIcon,
  CheckIcon,
  ChevronIcon,
  CommandIcon,
  FolderIcon,
  GitBranchIcon,
  KeyIcon,
  PuzzleIcon,
  RefreshIcon,
  SearchIcon,
  SearchList,
  Spinner,
} from "@lemma/look";
import type { SearchListRow } from "@lemma/look";
import styles from "./palette.css?inline";

const DIALOG = "palette";
/** What opens it, and closes it while it shows. */
const CLOSE_KEYS = "mod+k";

interface Deps {
  readonly interactions: InteractionsService;
  readonly dialogs: DialogsService;
  readonly slots: SlotsService;
  /** An action to ask for at once when the palette opens: its keys were pressed and it needs a value. Taken once read. */
  readonly takeRequested: () => string | undefined;
  /** The keys that open it, and close it while it shows: its own, or what the user bound it to. Reactive. */
  readonly closeKeys: () => readonly string[];
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
  /** What Escape does to it, as the footer says: cancels a command's question, goes back from an item's, or closes the palette that opened at it. */
  readonly escape: "cancel" | "back" | "close";
}

/** A page opened above the top level, and how the list it was opened from was left: what was typed, the row chosen. */
interface Opened {
  readonly page: PalettePage;
  readonly from: { readonly query: string; readonly active: number; readonly key: string | undefined };
}

const RECENT_KEY = "lemma.palette.recent";
const RESULTS = 60;
/** A source's `search` is asked once this many letters are typed, and typing has paused this long (ms). */
const SEARCH_MIN = 2;
const SEARCH_PAUSE = 200;

const loadRecent = (): string[] => loadStrings(RECENT_KEY);

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

/** A question the palette shows: any but a form, which the question dialog draws. */
type PaletteQuestion = Exclude<InteractionRequest, { readonly type: "form" }>;
const inPalette = (request: InteractionRequest): request is PaletteQuestion => request.type !== "form";

const fromInteraction = (request: PaletteQuestion): Question => {
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
 * share one ranked list; an item with a `page` opens a list of its own in its
 * place. While open, the palette shows the host's questions in place of the
 * question dialog, so a command that asks (which branch? what name?)
 * continues here.
 */
function Palette(props: { deps: Deps }) {
  const { interactions, dialogs, slots } = props.deps;
  const [query, setQuery] = createSignal("");
  const [filter, setFilter] = createSignal("");
  const [active, setActive] = createSignal(0);
  const [opened, setOpened] = createSignal<readonly Opened[]>([]);
  /** The page showing, if not the top level. */
  const page = () => opened().at(-1)?.page;
  /** How many pages it opened at: one when an action's keys opened it at its page, which is then where it starts. */
  const [start, setStart] = createSignal(0);
  /** There is a list to go back to: a page opened from another, not the one it opened at. */
  const canGoBack = () => opened().length > start();
  const [running, setRunning] = createSignal<Item | undefined>();
  const [local, setLocal] = createSignal<Asking | undefined>();
  const [recent, setRecent] = createSignal(loadRecent());
  let input!: HTMLInputElement;
  let disposed = false;
  // The host's questions show here while the palette is open, but a form, which needs its dialog.
  onCleanup(interactions.claim(inPalette));

  const close = () => {
    dialogs.open(undefined);
  };
  const choose = (item: Item) => {
    const next = remember(recent(), item.key);
    setRecent(next);
    save(RECENT_KEY, JSON.stringify(next));
    if (item.page !== undefined) return openPage(item.page());
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
    setActive(0);
    const outcome = await Promise.resolve(item.run?.()).catch(() => false);
    // This palette may have closed while it ran; a palette opened since is not its to close.
    if (disposed || running() !== item) return;
    setRunning(undefined);
    if (outcome !== false && dialogs.current() === DIALOG) close();
  };

  // ---------------------------------------------------------------- items

  /**
   * An item that asks for a value first asks here; answering runs it. Dismissed, it goes back to the list, or closes the
   * palette when the item's keys opened it asking (`opening`), as there is no list the person saw to go back to.
   */
  const askFor = (item: Item, question: { readonly title: string; readonly placeholder?: string }, opening = false): Asking => ({
    id: `input:${item.key}`,
    question: { type: "ask", title: question.title, placeholder: question.placeholder },
    answer: (value) => {
      setLocal(undefined);
      close();
      void item.run?.(value);
    },
    dismiss: () => (opening ? close() : setLocal(undefined)),
    escape: opening ? "close" : "back",
  });

  const sources = () => slots.list(PaletteSources);
  /** What a search at the top level looks through: every source's items. */
  const pool = (): Item[] => sources().flatMap((source) => [...source.items()]);

  // ---------------------------------------------------------------- pages

  /**
   * Shows `next` in place of the list, at its current item if it marks one (the theme showing); the list is kept as it
   * was left, to go back to.
   */
  const openPage = (next: PalettePage) => {
    setOpened((stack) => [...stack, { page: next, from: { query: query(), active: active(), key: items()[active()]?.item.key } }]);
    setQuery("");
    setActive(
      Math.max(
        0,
        items().findIndex((row) => row.item.current === true),
      ),
    );
  };
  /** Goes back to the list the page showing was opened from, as it was left: at the row chosen, though rows moved. */
  const back = () => {
    const top = opened().at(-1);
    if (top === undefined) return;
    setOpened((stack) => stack.slice(0, -1));
    setQuery(top.from.query);
    const at = items().findIndex((row) => row.item.key === top.from.key);
    setActive(at === -1 ? Math.min(top.from.active, Math.max(items().length - 1, 0)) : at);
  };
  /** What is typed: a question's answer or filter, else the search; either starts again at the first row. */
  const type = (next: string) => {
    if (asking() !== undefined) setFilter(next);
    else setQuery(next);
    setActive(0);
  };

  // ---------------------------------------------------------------- questions

  // Host questions take precedence: a running command is waiting on them.
  const asking = createMemo((): Asking | undefined => {
    const request = interactions.open().find(inPalette);
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
      escape: "cancel",
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

  // ---------------------------------------------------------------- search

  /** What the sources' `search` found for `text`, by source; `pending` until each has answered. */
  interface Found {
    readonly text: string;
    readonly labels: readonly string[];
    readonly groups: readonly { readonly label: string; readonly items: readonly Item[]; readonly error?: string }[];
    readonly pending: boolean;
  }
  const [found, setFound] = createSignal<Found>();
  const plugin = usePlugin();
  createEffect(() => {
    const typed = query().trim();
    const shown = page();
    // At the top level every source's search; on a page, its own.
    const lists =
      shown === undefined
        ? sources().map((source) => ({ search: source.search, label: source.searchLabel ?? source.label }))
        : [{ search: shown.search, label: shown.searchLabel ?? shown.title.toLowerCase() }];
    const searching = lists.flatMap(({ search, label }) => (search === undefined ? [] : [{ label, search }]));
    if (asking() !== undefined || running() !== undefined || typed.length < SEARCH_MIN || searching.length === 0) return void setFound(undefined);
    const labels = searching.map((source) => source.label);
    setFound({ text: typed, labels, groups: [], pending: true });
    const abort = new AbortController();
    const cancel = plugin.after(SEARCH_PAUSE, () => {
      const answers = searching.map((source) =>
        source.search(typed, { signal: abort.signal }).then(
          (items) => ({ label: source.label, items }),
          (error: unknown) => ({ label: source.label, items: [], error: error instanceof Error ? error.message : String(error) }),
        ),
      );
      void Promise.all(answers).then((groups) => {
        if (!abort.signal.aborted) setFound({ text: typed, labels, groups, pending: false });
      });
    });
    onCleanup(() => {
      cancel();
      abort.abort();
    });
  });

  // ---------------------------------------------------------------- rows

  type Row =
    | { readonly type: "heading"; readonly label: string }
    | { readonly type: "note"; readonly label: string }
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
    const shown = page();
    const text = query();
    let index = 0;
    const item = (entry: { item: Item; matches: readonly number[] }): Row => ({ type: "item", ...entry, index: index++ });
    if (text.trim() !== "") {
      const ranked = rank(shown === undefined ? pool() : [...shown.items()], text, recent())
        .slice(0, RESULTS)
        .map(item);
      // Then what the sources found elsewhere (`search`), but for what is listed already.
      const more = found();
      if (more === undefined || more.text !== text.trim()) return ranked;
      if (more.pending) return [...ranked, { type: "note", label: `Searching ${more.labels.join(" and ")}…` }];
      const listed = new Set(ranked.flatMap((row) => (row.type === "item" ? [row.item.key] : [])));
      return [
        ...ranked,
        ...more.groups.flatMap((group): Row[] => {
          if (group.error !== undefined)
            return [
              { type: "heading", label: `In ${group.label}` },
              { type: "note", label: group.error },
            ];
          const items = group.items.filter((entry) => !listed.has(entry.key));
          return items.length === 0 ? [] : [{ type: "heading", label: `In ${group.label}` }, ...items.map((entry) => item({ item: entry, matches: [] }))];
        }),
      ];
    }
    if (shown !== undefined) return shown.items().map((entry) => item({ item: entry, matches: [] }));
    // Browsing: recent choices, then each source in order, up to its `browse` (the commands, and what plugins add;
    // threads and projects show as a search finds them).
    const byKey = new Map(pool().map((entry) => [entry.key, entry]));
    const recentItems = recent()
      .map((key) => byKey.get(key))
      .filter((entry): entry is Item => entry !== undefined)
      .slice(0, 5);
    const listed = new Set(recentItems.map((entry) => entry.key));
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
            .filter((entry) => !listed.has(entry.key))
            .slice(0, source.browse ?? Number.POSITIVE_INFINITY),
        ),
      ),
    ];
  });

  const items = createMemo(() => rows().filter((row): row is Extract<Row, { type: "item" }> => row.type === "item"));

  // ---------------------------------------------------------------- keys

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

  /** Its own keys, before the list's (`SearchList`): those that close it, and Backspace back out of a question or page. */
  const onKeyDown = (event: KeyboardEvent) => {
    // Its own keys close it, as its footer says, before a list takes them (Ctrl+K moves up one where mod is Ctrl).
    if (props.deps.closeKeys().some((keys) => matchesKeys(keys, event))) {
      event.preventDefault();
      close();
    } else if (event.key === "Backspace" && local()?.escape === "back" && filter() === "") {
      event.preventDefault();
      setLocal(undefined);
    } else if (event.key === "Backspace" && asking() === undefined && running() === undefined && canGoBack() && query() === "") {
      event.preventDefault();
      back();
    }
  };
  const escape = () => {
    const current = asking();
    // Dismissing a command's question cancels the command; the palette stays for the next thing.
    if (current !== undefined) current.dismiss();
    else if (running() === undefined && query() !== "") type("");
    else if (running() === undefined && canGoBack()) back();
    else close();
  };

  onMount(() => {
    const requested = props.deps.takeRequested();
    const item = requested === undefined ? undefined : pool().find((candidate) => candidate.key === `action:${requested}`);
    // Opened by an action's keys at its page or its question, it starts there: Escape closes it, not going back to a list never seen.
    if (item?.page !== undefined) {
      openPage(item.page());
      setStart(1);
    } else if (item?.input !== undefined) setLocal(askFor(item, item.input(), true));
  });
  onCleanup(() => {
    disposed = true;
  });

  // ---------------------------------------------------------------- view

  const value = () => (asking() === undefined ? query() : filter());
  const placeholder = () => {
    const question = asking()?.question;
    if (question?.type === "ask") return question.placeholder ?? "Type an answer";
    if (question !== undefined) return "Filter";
    if (running() !== undefined) return `Running ${running()!.title.replace(/…$/, "")}…`;
    // A page names itself in the empty field: `Dark theme`.
    if (page() !== undefined) return page()!.placeholder ?? page()!.title;
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
  /** Rows in a list where some have an icon keep its room without one, so their names line up. */
  const iconRoom = createMemo(() => items().some((row) => row.item.icon !== undefined));
  /** And the room of the chevron of a row that opens a page, so their shortcuts end in line. */
  const moreRoom = createMemo(() => items().some((row) => row.item.page !== undefined));
  /** A question the palette did not claim (a form) shows over it: it steps out of sight, keeping its field to go back to. */
  const behind = () => interactions.open().some((request) => !interactions.claimed(request));

  /** What an option shows: its icon, name, detail, keys, and whether it is current or opens a page. */
  const content = (row: Extract<Row, { type: "item" }>) => (
    <>
      <Show when={row.item.icon} fallback={iconRoom() ? <span class="palette-icon-room" aria-hidden="true" /> : undefined}>
        {(icon) => <Isolated component={icon()} />}
      </Show>
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
      <Show when={row.item.page} fallback={moreRoom() ? <span class="palette-more" aria-hidden="true" /> : undefined}>
        <span class="palette-more" aria-hidden="true">
          <ChevronIcon />
        </span>
      </Show>
    </>
  );
  const listed = createMemo(() =>
    rows().map((row): SearchListRow => (row.type === "item" ? { type: "option", index: row.index, content: () => content(row) } : row)),
  );

  return (
    <SearchList
      label="Command palette"
      class="palette-text"
      behind={behind()}
      heading={
        <Show when={heading()}>
          <div class="palette-heading">{heading()}</div>
        </Show>
      }
      lead={
        <Show
          when={running() !== undefined && asking() === undefined}
          fallback={
            <Show when={canGoBack() && asking() === undefined} fallback={<ChevronIcon />}>
              <button
                type="button"
                class="icon-button palette-back"
                aria-label="Back"
                data-tip="Back"
                onMouseDown={(event) => event.preventDefault()}
                onClick={back}
              >
                <ArrowLeftIcon />
              </button>
            </Show>
          }
        >
          <Spinner />
        </Show>
      }
      value={value()}
      onInput={type}
      fieldLabel={asking()?.question.title ?? (page() === undefined ? "Search commands, threads, and projects" : `Filter ${page()!.title}`)}
      placeholder={placeholder()}
      secret={secret()}
      // While a command runs: what is typed waits for its question, and Escape still reaches it.
      readOnly={asking() === undefined && running() !== undefined}
      field={(element) => (input = element)}
      detail={<Show when={questionDetail()}>{(detail) => <p class="palette-question-detail">{detail()}</p>}</Show>}
      rows={listed()}
      empty={
        rows().length === 0 && asking() === undefined && running() === undefined
          ? query().trim() !== ""
            ? `Nothing matches “${query().trim()}”`
            : page() === undefined
              ? "Nothing to show"
              : `Nothing in ${page()!.title}`
          : undefined
      }
      active={active()}
      onActive={setActive}
      onPick={(index) => {
        if (index >= items().length) return;
        setActive(index);
        submit();
      }}
      onSubmit={submit}
      onEscape={escape}
      onClose={close}
      onKeyDown={onKeyDown}
      footer={
        <Show
          when={asking() === undefined}
          fallback={
            <>
              <span>
                <kbd>↵</kbd> {asking()?.question.type === "ask" ? "submit" : "choose"}
              </span>
              <span>
                <kbd>esc</kbd> {asking()?.escape}
              </span>
            </>
          }
        >
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> move
          </span>
          <span>
            <kbd>↵</kbd> {items()[active()]?.item.page === undefined ? "run" : "open"}
          </span>
          <Show when={canGoBack()}>
            <span>
              <kbd>esc</kbd> back
            </span>
          </Show>
          {/* At the page its keys opened it at, Escape closes it; elsewhere, its own keys do. */}
          <Show
            when={page() === undefined || canGoBack()}
            fallback={
              <span class="palette-foot-end">
                <kbd>esc</kbd> close
              </span>
            }
          >
            <Show when={props.deps.closeKeys()[0]}>
              {(keys) => (
                <span class="palette-foot-end">
                  <kbd>{formatKeys(keys())}</kbd> close
                </span>
              )}
            </Show>
          </Show>
        </Show>
      }
    />
  );
}

/** Search and run everything: plugins' actions, the host's commands, threads, projects. */
export default defineWebPlugin({
  id: "actions.palette",
  styles,
  requires: {
    client: Client,
    threads: Threads,
    workspace: Workspace,
    commands: Commands,
    interactions: Interactions,
    dialogs: Dialogs,
    webPlugins: WebPlugins,
    slots: Slots,
  },
  setup: (services) => {
    const { client, threads, workspace, commands, dialogs, interactions, webPlugins, slots } = services;
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
      closeKeys: () => keysFor(ActionIds.palette, CLOSE_KEYS, overridesFrom(webPlugins.list())),
    };
    // Its own sources go through the slot a plugin adds a source to (files, symbols): they are defaults, not built in.
    const source = (id: string, order: number, value: PaletteSource) => slots.add(PaletteSources, { id, order, ...value });
    source("palette.commands", 0, {
      label: "commands",
      items: () => [
        ...slots
          .list(Actions)
          .filter((action) => action.hidden !== true && (action.when?.() ?? true))
          .map((action): PaletteItem => {
            const keys = shownKeys(action, webPlugins.list());
            return {
              key: `action:${action.id}`,
              category: action.category,
              title: action.title,
              detail: action.detail,
              keywords: action.keywords,
              shortcut: keys === undefined ? undefined : formatKeys(keys),
              icon: action.icon,
              input: action.input,
              page: action.page,
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
    /** What a thread is doing that the person would want to know: waiting on them, or at work; archived, else when it was used. */
    const stateOf = (session: SessionInfo) =>
      waitingOn(slots.list(ThreadWaits), session.id) ??
      (threads.running().includes(session.id) ? "Working" : session.archived === true ? "Archived" : relativeTime(session.updatedAt));
    const threadItem = (session: SessionInfo, detail: string): PaletteItem => ({
      key: `session:${session.id}`,
      title: sessionTitle(session),
      detail,
      keywords: [
        workspace.projectName(session.cwd),
        basename(session.cwd),
        session.id,
        ...(session.pinned === true ? ["pinned"] : []),
        ...(session.archived === true ? ["archived"] : []),
      ],
      current: session.id === threads.activeId(),
      icon: ChatIcon,
      run: () => void threads.select(session.id),
    });
    const threadItems = () =>
      threads
        .list()
        .filter((session) => !isBlank(session))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((session) => threadItem(session, `${workspace.projectName(session.cwd)} · ${stateOf(session)}`));
    // What was said in them, the host's search: each thread its title doesn't already list, with the words around it.
    const searchThreads: NonNullable<PaletteSource["search"]> = async (text, { signal }) => {
      const matches = await client.channel.call(SessionChannels.search, { query: text }, { signal });
      const byId = new Map(threads.list().map((session) => [session.id, session]));
      return matches.flatMap((match) => {
        const session = byId.get(match.sessionId);
        return session === undefined ? [] : [threadItem(session, `${match.role === "user" ? "You: " : ""}${match.snippet}`)];
      });
    };
    // Threads and projects show as what is typed finds them, not among the commands; Search threads lists the threads.
    source("palette.threads", 10, { label: "threads", browse: 0, items: threadItems, searchLabel: "messages", search: searchThreads });
    source("palette.projects", 20, {
      label: "projects",
      browse: 0,
      items: () => {
        return workspace.projects().map((path) => ({
          key: `project:${path}`,
          title: workspace.projectName(path),
          detail: tildePath(path, client.info()?.home),
          keywords: [path, basename(path)],
          icon: FolderIcon,
          run: () => void threads.newThread(path, { inPlace: true }),
        }));
      },
    });
    slots.add(Layers, {
      id: DIALOG,
      order: 30,
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
      keys: CLOSE_KEYS,
      // Opens over any other dialog; a question the host asks keeps the screen until answered.
      global: true,
      when: () => dialogs.current() === DIALOG || interactions.open().length === 0,
      // With an action's id, opens asking for that action's value (the keymap does this for an action that needs one), or at its page.
      run: (actionId) => {
        if (actionId !== undefined) {
          requested = actionId;
          dialogs.open(undefined);
          queueMicrotask(() => dialogs.open(DIALOG));
        } else dialogs.open(dialogs.current() === DIALOG ? undefined : DIALOG);
      },
    });
    slots.add(Actions, {
      id: ActionIds.searchThreads,
      title: "Search threads",
      category: "Thread",
      icon: SearchIcon,
      keys: "mod+p",
      global: true,
      when: () => interactions.open().length === 0,
      page: () => ({ title: "Threads", items: threadItems, search: searchThreads, searchLabel: "messages" }),
      // Its keys open the palette at its page.
      run: () => {
        requested = ActionIds.searchThreads;
        dialogs.open(undefined);
        queueMicrotask(() => dialogs.open(DIALOG));
      },
    });
  },
});
