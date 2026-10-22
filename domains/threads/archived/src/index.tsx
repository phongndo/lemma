import { For, Show, createEffect, createMemo, createSignal, on } from "solid-js";
import type { JSX } from "solid-js";
import type { SessionInfo } from "@lemma/sessions";
import { relativeTime, tildePath } from "@lemma/web/format";
import { typing } from "@lemma/web/keys";
import { createNow } from "@lemma/web/now";
import { Actions } from "@lemma/actions";
import { Dialogs, Layers } from "@lemma/frame";
import { Settings, SettingsSections } from "@lemma/settings";
import { DeleteThreadsDialog, sessionTitle, Threads, ThreadWaits, waitingOn } from "@lemma/threads";
import type { ThreadsService } from "@lemma/threads";
import { Workspace } from "@lemma/workspace/web";
import type { WorkspaceService } from "@lemma/workspace/web";
import { Client, Slots, defineWebPlugin } from "@lemma/web";
import type { SlotsService, WebPluginContext } from "@lemma/web";
import {
  AgentIcon,
  ArchiveIcon,
  CheckIcon,
  ConfirmDelete,
  FilterIcon,
  Popover,
  QuestionIcon,
  RedoIcon,
  SearchField,
  Spinner,
  TrashIcon,
  WorktreeIcon,
  XIcon,
} from "@lemma/look";
import { archivedOf, dayLabel, extendSelection, filterArchived, groupBy, notArchived, selectionOf, threadCount, withSelection } from "./archived.ts";
import styles from "./archived-page.css?inline";

const SECTION = "archived";
const DELETE_DIALOG = "archived-page.delete";
/** No project (`projectOf`'s `""`) in the page's address, where an empty value would drop the filter; a project is a path. */
const NO_PROJECT = "none";

interface Deps {
  /** This plugin's handle: the page is drawn by the settings page, so its rows take it from here. */
  readonly plugin: Pick<WebPluginContext<unknown>, "action">;
  readonly threads: ThreadsService;
  readonly workspace: WorkspaceService;
  readonly slots: SlotsService;
  readonly now: () => number;
  /** The project a thread is filed under: its folder's (`projectOf`), or `""` for a thread with no project. */
  readonly projectOf: (cwd: string) => string;
  /** What to call a project (`projectOf`'s). */
  readonly projectName: (project: string) => string;
  /** Everything the search finds a thread by: its title, project, folder, and branch. */
  readonly text: (session: SessionInfo) => string;
  /** The page's search and project, kept in its address (`?q=…&project=…`), as a browser's history keeps its search. */
  readonly query: () => string;
  readonly setQuery: (query: string) => void;
  readonly project: () => string | undefined;
  readonly setProject: (project: string | undefined) => void;
  /** The archived threads the search and project keep, the most recently used first. */
  readonly shown: () => readonly SessionInfo[];
  readonly selection: Selection;
  /** Asks before deleting these threads for good. */
  readonly askDelete: (ids: readonly string[]) => void;
}

/**
 * The threads selected, kept by the plugin while the page shows, so its keys (Escape, ⌘A) reach it wherever focus is;
 * leaving the page drops it. A plain pick sets the anchor and keeps the selection as it then is (`base`): a Shift-pick
 * sets the run from the anchor over that, so a second one grows or shrinks the run (`extendSelection`).
 */
interface Selection {
  readonly selected: () => ReadonlySet<string>;
  readonly anchor: () => string | undefined;
  /** Sets the selection, and the anchor a Shift-pick runs from (none: a Shift-pick then starts one). */
  readonly settle: (next: ReadonlySet<string>, anchor: string | undefined) => void;
  /** With Shift: the run from the anchor to `id`, through `order`, over the selection as the anchor found it. */
  readonly extend: (order: readonly string[], id: string) => void;
  /** Takes these out, the anchor staying: threads no longer archived. */
  readonly drop: (ids: readonly string[]) => void;
  readonly clear: () => void;
}

const createSelection = (): Selection => {
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set());
  const [anchor, setAnchor] = createSignal<string>();
  let base: ReadonlySet<string> = new Set();
  const settle = (next: ReadonlySet<string>, from: string | undefined) => {
    setSelected(next);
    setAnchor(from);
    base = next;
  };
  return {
    selected,
    anchor,
    settle,
    extend: (order, id) => setSelected(extendSelection(base, order, anchor(), id)),
    drop: (ids) => {
      base = withSelection(base, ids, false);
      setSelected(withSelection(selected(), ids, false));
    },
    clear: () => settle(new Set(), undefined),
  };
};

/** A checkbox drawn with the look's tokens: checked, unchecked, or mixed (some of what it stands for). */
function Check(props: { state: boolean | "mixed"; label: string; nav?: string; onToggle: (event: MouseEvent) => void }) {
  return (
    <button
      type="button"
      role="checkbox"
      class="archived-check"
      aria-checked={props.state}
      aria-label={props.label}
      data-nav={props.nav}
      onClick={(event) => props.onToggle(event)}
    >
      <span class="archived-box">
        <Show when={props.state === true}>
          <CheckIcon />
        </Show>
        <Show when={props.state === "mixed"}>
          <span class="archived-dash" />
        </Show>
      </span>
    </button>
  );
}

const checkState = (selection: "all" | "some" | "none"): boolean | "mixed" => (selection === "all" ? true : selection === "some" ? "mixed" : false);

/** A row's place in a selection: whether it is selected, and picking it (with Shift, the run from the last one picked). */
interface RowSelection {
  readonly selected: () => boolean;
  readonly pick: (event: MouseEvent | KeyboardEvent) => void;
}

/**
 * An archived thread, on the settings' row grid: a checkbox to select it, its lead; its title, which opens it, after an
 * agent's mark (whose thread it works for, in its tooltip); under it, its project and its worktree's branch; at the
 * end, when it was last used, or a mark while a turn still runs in it, and under the pointer, Unarchive and Delete,
 * which asks in place (`ConfirmDelete`). Its project is a link that sets the page's project filter,
 * left out while the filter already names one.
 */
function ArchivedRow(props: { deps: Deps; session: SessionInfo; selection: RowSelection }) {
  const { deps } = props;
  const id = () => props.session.id;
  const title = () => sessionTitle(props.session);
  const project = () => deps.projectOf(props.session.cwd);
  const running = () => deps.threads.running().includes(id());
  const waiting = () => waitingOn(deps.slots.list(ThreadWaits), id());
  const place = () => deps.workspace.place(props.session.cwd);
  const branch = () => (place()?.worktree === true ? (place()?.branch ?? undefined) : undefined);
  const parent = () => {
    const started = props.session.parent?.sessionId;
    return started === undefined ? undefined : deps.threads.list().find((session) => session.id === started);
  };
  const open = deps.plugin.action("open thread", () => deps.threads.select(id()));
  const unarchive = deps.plugin.action("unarchive thread", () => deps.threads.mark(id(), { archived: false }));
  const remove = deps.plugin.action("delete thread", () => deps.threads.remove(id()));
  // While Delete asks, the row's actions stay shown.
  const [armed, setArmed] = createSignal(false);
  return (
    <div
      class="setting-row setting-row-pick archived-row"
      classList={{ selected: props.selection.selected() }}
      data-archived-row={id()}
      // Anywhere on the row but its title and buttons picks it, as its checkbox does.
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("a, button") !== null) return;
        props.selection.pick(event);
        // The keyboard goes on from the row picked.
        event.currentTarget.querySelector<HTMLElement>("[data-nav=check]")?.focus({ preventScroll: true });
      }}
    >
      <span class="setting-lead">
        <Check state={props.selection.selected()} label={`Select ${title()}`} nav="check" onToggle={(event) => props.selection.pick(event)} />
      </span>
      <div class="setting-text">
        <div class="archived-line">
          <Show when={parent()}>
            {(started) => (
              <span class="archived-agent" data-tip={`Agent of ${sessionTitle(started())}`}>
                <AgentIcon />
              </span>
            )}
          </Show>
          <a
            class="archived-title"
            href={deps.threads.href(id())}
            draggable={false}
            data-nav="title"
            onPointerEnter={() => deps.threads.preload(id())}
            onClick={(event) => {
              // Shift picks the run to it, as on the rest of the row; a plain click opens it here; with another modifier,
              // the browser opens the link elsewhere.
              if (event.shiftKey) {
                event.preventDefault();
                props.selection.pick(event);
                return;
              }
              if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey) return;
              event.preventDefault();
              open();
            }}
          >
            {title()}
          </a>
        </div>
        <div class="archived-meta">
          <Show when={deps.project() === undefined}>
            <button class="archived-project-link" data-tip={`Only ${deps.projectName(project())}`} onClick={() => deps.setProject(project())}>
              {deps.projectName(project())}
            </button>
          </Show>
          <Show when={branch()}>
            {(name) => (
              <span
                class="archived-branch"
                classList={{ gone: place()?.exists === false }}
                data-tip={place()?.exists === false ? "Worktree removed; unarchiving makes it again" : props.session.cwd}
              >
                <WorktreeIcon />
                {name()}
              </span>
            )}
          </Show>
        </div>
      </div>
      <div class="setting-control archived-side">
        <Show
          when={waiting() ?? (running() ? "Working" : undefined)}
          fallback={
            <span class="archived-time" data-tip={`Last used ${new Date(props.session.updatedAt).toLocaleString()}`}>
              {relativeTime(props.session.updatedAt, deps.now())}
            </span>
          }
        >
          {(state) => (
            <span class="archived-time archived-state" classList={{ waiting: waiting() !== undefined }} data-tip={state()} aria-label={state()}>
              <Show when={waiting() === undefined} fallback={<QuestionIcon />}>
                <Spinner />
              </Show>
            </span>
          )}
        </Show>
        <div class="archived-actions" classList={{ armed: armed() }}>
          <button class="icon-button" aria-label={`Unarchive ${title()}`} data-tip="Unarchive" onClick={unarchive}>
            <RedoIcon />
          </button>
          <ConfirmDelete label={`Delete ${title()}`} blocked={running() ? "Stop its turn to delete it" : undefined} onArmed={setArmed} onConfirm={remove} />
        </div>
      </div>
    </div>
  );
}

/** Which project the page shows: all of them, or one, from those with archived threads. */
function ProjectFilter(props: { deps: Deps; projects: readonly string[] }) {
  const { deps } = props;
  const count = (project: string) => archivedOf(deps.threads.list()).filter((session) => deps.projectOf(session.cwd) === project).length;
  const pick = (project: string | undefined, close: () => void) => {
    deps.setProject(project);
    close();
  };
  const item = (project: string | undefined, label: string, close: () => void, detail?: string): JSX.Element => (
    <button class="menu-item" role="menuitemradio" aria-checked={deps.project() === project} onClick={() => pick(project, close)}>
      <span class="menu-check">
        <Show when={deps.project() === project}>
          <CheckIcon />
        </Show>
      </span>
      <span class="menu-label">{label}</span>
      <Show when={detail}>{(text) => <span class="menu-hint">{text()}</span>}</Show>
    </button>
  );
  return (
    <Popover
      label={deps.project() === undefined ? "Filter by project" : `Only ${deps.projectName(deps.project()!)}`}
      trigger={
        <Show when={deps.project()} fallback={<FilterIcon />}>
          {(chosen) => (
            <>
              <FilterIcon />
              <span class="archived-filter-label">{deps.projectName(chosen())}</span>
            </>
          )}
        </Show>
      }
      triggerClass={deps.project() === undefined ? "icon-button archived-filter" : "icon-button archived-filter active"}
      placement="bottom-end"
    >
      {(close) => (
        <>
          {item(undefined, "All projects", close)}
          <div class="menu-sep" role="separator" />
          <For each={props.projects}>{(project) => item(project, deps.projectName(project), close, String(count(project)))}</For>
        </>
      )}
    </Popover>
  );
}

/**
 * Every archived thread, as a browser's history lists what was visited: searched, narrowed to a project, grouped by
 * when each was last used, and selected to unarchive or delete together: one by one (a row or its checkbox), a run
 * with Shift (by click, or with the arrows), a group, or all shown (⌘A). The selection outlives the search, so it can
 * gather threads from several. Arrows move between rows and back up to the search, Space picks the row in focus, and
 * Escape clears the selection. With none archived yet, what archiving is and where to do it.
 */
function ArchivedPage(props: { deps: Deps }) {
  const { deps } = props;
  const all = createMemo(() => archivedOf(deps.threads.list()));
  const shown = deps.shown;
  const groups = createMemo(() => groupBy(shown(), (session) => dayLabel(session.updatedAt, deps.now())));
  const byId = createMemo(() => new Map(all().map((session) => [session.id, session])));
  // Listed by key and id, so a row holds still (and Delete stays armed) as its thread changes.
  const keys = createMemo(() => groups().map((group) => group.key), undefined, { equals: (a, b) => a.join("\n") === b.join("\n") });
  const idsIn = (key: string) =>
    groups()
      .find((group) => group.key === key)
      ?.sessions.map((session) => session.id) ?? [];
  /** The ids shown, in the order they show: what a range, ⌘A, and the arrows go through. */
  const order = createMemo(() => groups().flatMap((group) => group.sessions.map((session) => session.id)));
  const projects = createMemo(() => [...new Set(all().map((session) => deps.projectOf(session.cwd)))]);
  const filtered = () => deps.query().trim() !== "" || deps.project() !== undefined;

  // The selection outlives the search, so one can be built across several; the toolbar counts those it hides.
  const { selection } = deps;
  const selected = selection.selected;
  const shownIds = createMemo(() => new Set(order()));
  /** The archived threads selected, shown or not: a thread unarchived or deleted meanwhile leaves the selection. */
  const chosen = createMemo(() => all().flatMap((session) => (selected().has(session.id) ? [session.id] : [])));
  const hidden = () => chosen().filter((id) => !shownIds().has(id)).length;
  const clear = selection.clear;
  const pick = (id: string, event: MouseEvent | KeyboardEvent) => {
    if (event.shiftKey && selection.anchor() !== undefined) selection.extend(order(), id);
    else selection.settle(withSelection(selected(), [id], !selected().has(id)), id);
  };
  const rowSelection = (id: string): RowSelection => ({ selected: () => selected().has(id), pick: (event) => pick(id, event) });
  const toggleAll = (ids: readonly string[]) => selection.settle(withSelection(selected(), ids, selectionOf(selected(), ids) !== "all"), undefined);
  // Each leaves the selection once unarchived (`notArchived`); one that fails, which `mark` reports, stays selected.
  const unarchive = deps.plugin.action("unarchive threads", () => Promise.all(chosen().map((id) => deps.threads.mark(id, { archived: false }))));

  let list!: HTMLDivElement;
  let search: HTMLInputElement | undefined;
  /** A row's element to focus: its checkbox, or its title (`nav`). */
  const focusRow = (row: HTMLElement | undefined, nav: string) => {
    const focus = row?.querySelector<HTMLElement>(`[data-nav=${nav}]`) ?? row?.querySelector<HTMLElement>("[data-nav]");
    if (focus === null || focus === undefined) return false;
    focus.focus();
    focus.scrollIntoView({ block: "nearest" });
    return true;
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return;
    const target = event.target as HTMLElement;
    const rows = () => [...list.querySelectorAll<HTMLElement>("[data-archived-row]")];
    const row = target.closest<HTMLElement>("[data-archived-row]");
    const rowId = row?.dataset.archivedRow;
    if (event.key === "ArrowDown" && target === search) {
      // From the search down into the list, at its first row.
      if (focusRow(rows()[0], "check")) event.preventDefault();
    } else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && row !== null && rowId !== undefined) {
      // To the next row or the previous, at its checkbox or title as here; up from the first, back to the search. With
      // Shift, the run from the anchor (this row, when there is none) follows.
      const at = rows().indexOf(row);
      const next = rows()[at + (event.key === "ArrowDown" ? 1 : -1)];
      event.preventDefault();
      if (next === undefined) {
        if (event.key === "ArrowUp") search?.focus();
        return;
      }
      focusRow(next, target.closest<HTMLElement>("[data-nav]")?.dataset.nav ?? "check");
      if (!event.shiftKey) return;
      if (selection.anchor() === undefined) selection.settle(withSelection(selected(), [rowId], true), rowId);
      selection.extend(order(), next.dataset.archivedRow!);
    } else if (event.key === " " && rowId !== undefined && target.closest("[data-nav=title]") !== null) {
      // Space on a title picks its row, as on its checkbox, rather than scrolling the page.
      event.preventDefault();
      pick(rowId, event);
    }
  };

  return (
    <Show
      when={all().length > 0}
      fallback={
        <div class="archived-empty">
          <ArchiveIcon />
          <h2>No archived threads</h2>
          <p class="muted">
            Archive a thread to put it away without deleting it: from its {"⋯\u00a0menu"}, or from its row in the sidebar. It waits here, to open, unarchive, or
            delete.
          </p>
        </div>
      }
    >
      <div
        class="archived-page"
        onKeyDown={onKey}
        // Shift-clicking picks a run of rows; it should not also select their text.
        onMouseDown={(event) => {
          if (event.shiftKey && (event.target as HTMLElement).closest("[data-archived-row]") !== null) event.preventDefault();
        }}
      >
        {/* One row: the search, always; beside it, the selection while there is one, then the project. */}
        <div class="archived-toolbar">
          <SearchField
            value={deps.query()}
            onInput={deps.setQuery}
            placeholder="Search archived threads"
            label="Search archived threads"
            ref={(input) => (search = input)}
          >
            <Show
              when={chosen().length > 0}
              fallback={<span class="archived-count">{filtered() ? `${order().length} of ${all().length}` : threadCount(all().length)}</span>}
            >
              <div class="archived-selection" role="group" aria-label="Selection">
                <Check
                  state={checkState(selectionOf(selected(), order()))}
                  label={selectionOf(selected(), order()) === "all" ? "Select none shown" : "Select all shown"}
                  onToggle={() => toggleAll(order())}
                />
                <span class="archived-chosen">{chosen().length} selected</span>
                <Show when={hidden() > 0}>
                  <span class="archived-hidden" data-tip="Selected, though the search hides them">
                    {hidden()} hidden
                  </span>
                </Show>
                <button class="icon-button" aria-label="Unarchive selected" data-tip="Unarchive" onClick={unarchive}>
                  <RedoIcon />
                </button>
                <button class="icon-button archived-bar-delete" aria-label="Delete selected" data-tip="Delete" onClick={() => deps.askDelete(chosen())}>
                  <TrashIcon />
                </button>
                <button class="icon-button" aria-label="Clear selection" data-tip="Clear · Esc" onClick={clear}>
                  <XIcon />
                </button>
              </div>
            </Show>
            <ProjectFilter deps={deps} projects={projects()} />
          </SearchField>
        </div>
        <div class="archived-list" classList={{ selecting: chosen().length > 0 }} ref={list}>
          <For
            each={keys()}
            fallback={
              <div class="archived-none">
                <p class="settings-empty">No archived threads match{deps.query().trim() === "" ? " here" : ` “${deps.query().trim()}”`}</p>
                <button
                  class="button small"
                  onClick={() => {
                    deps.setQuery("");
                    deps.setProject(undefined);
                  }}
                >
                  Show all
                </button>
              </div>
            }
          >
            {(key) => (
              <section class="archived-group">
                <h3 class="archived-group-title">
                  <span class="setting-lead">
                    <Check state={checkState(selectionOf(selected(), idsIn(key)))} label={`Select ${key}`} onToggle={() => toggleAll(idsIn(key))} />
                  </span>
                  <span>{key}</span>
                </h3>
                <div class="archived-rows">
                  <For each={idsIn(key)}>
                    {(id) => <Show when={byId().get(id)}>{(session) => <ArchivedRow deps={deps} session={session()} selection={rowSelection(id)} />}</Show>}
                  </For>
                </div>
              </section>
            )}
          </For>
        </div>
      </div>
    </Show>
  );
}

/**
 * Settings › Archived: every archived thread, as a browser's history lists what was visited. It is searched (by title,
 * project, folder, or branch), narrowed to a project, grouped by date, and its threads are opened, or selected and
 * unarchived or deleted together; deleting asks first. The palette (⌘P), not the settings search, finds a thread.
 */
export default defineWebPlugin({
  id: "threads.archived",
  styles,
  requires: { client: Client, threads: Threads, workspace: Workspace, settings: Settings, dialogs: Dialogs, slots: Slots },
  setup: ({ client, threads, workspace, settings, dialogs, slots }, plugin) => {
    const projectOf = (cwd: string) => (workspace.isStandalone(cwd) ? "" : workspace.projectOf(cwd));
    const projectName = (project: string) => (project === "" ? "No project" : workspace.projectName(project));
    const text = (session: SessionInfo) => {
      const branch = workspace.place(session.cwd)?.branch;
      return `${sessionTitle(session)} ${projectName(projectOf(session.cwd))} ${tildePath(session.cwd, client.info()?.home)} ${branch ?? ""}`;
    };
    // "3m ago", and which day's heading a thread is under, move on while the page shows.
    const now = createNow(30_000, () => settings.section() === SECTION);
    const here = (): Readonly<Record<string, string | undefined>> => (settings.section() === SECTION ? settings.params() : {});
    const [deleting, setDeleting] = createSignal<readonly string[]>([]);
    const askDelete = (ids: readonly string[]) => {
      setDeleting(ids);
      dialogs.open(DELETE_DIALOG);
    };
    const selection = createSelection();
    // Leaving the page drops the selection.
    createEffect(
      on(
        () => settings.section() === SECTION,
        (open) => open || selection.clear(),
        { defer: true },
      ),
    );
    // It holds archived threads only: one unarchived (here or elsewhere) or deleted leaves it, so archiving it again
    // does not bring it back selected, into a bulk delete; one whose unarchiving failed stays, to try again.
    createEffect(() => {
      const gone = notArchived(selection.selected(), threads.list());
      if (gone.length > 0) selection.drop(gone);
    });
    const query = () => here().q ?? "";
    const project = () => {
      const value = here().project;
      return value === NO_PROJECT ? "" : value;
    };
    const shown = createMemo(() => filterArchived(threads.list(), { query: query(), project: project() }, projectOf, text));
    /** The threads the delete dialog asks about, still archived: one deleted or unarchived meanwhile drops out. */
    const asked = () => deleting().flatMap((id) => threads.list().find((session) => session.id === id && session.archived === true) ?? []);
    // The selection outlives the search, so some may be out of sight: the dialog says so, as the toolbar does, before they go.
    const hiddenAsked = () => {
      const seen = new Set(shown().map((session) => session.id));
      return asked().filter((session) => !seen.has(session.id)).length;
    };
    const deps: Deps = {
      plugin,
      threads,
      workspace,
      slots,
      now,
      projectOf,
      projectName,
      text,
      query,
      setQuery: (next) => settings.setParams({ q: next }),
      project,
      setProject: (next) => settings.setParams({ project: next === "" ? NO_PROJECT : next }),
      shown,
      selection,
      askDelete,
    };
    const showing = () => settings.section() === SECTION;
    // Escape clears the selection before it closes settings, and ⌘A selects every thread shown, wherever focus is on
    // the page but a field, whose ⌘A selects its text: a key with a modifier reaches actions in a field too.
    slots.add(Actions, {
      id: "archived-page.clear-selection",
      title: "Clear the archived threads' selection",
      category: "Settings",
      hidden: true,
      keys: "escape",
      whileTyping: true,
      order: -20,
      when: () => showing() && selection.selected().size > 0,
      run: () => selection.clear(),
    });
    slots.add(Actions, {
      id: "archived-page.select-all",
      title: "Select every archived thread shown",
      category: "Settings",
      hidden: true,
      keys: "mod+a",
      order: -20,
      when: () => showing() && shown().length > 0 && !typing(document.activeElement),
      run: () =>
        selection.settle(
          withSelection(
            selection.selected(),
            shown().map((session) => session.id),
            true,
          ),
          undefined,
        ),
    });

    slots.add(SettingsSections, {
      id: SECTION,
      order: 27,
      title: "Archived",
      icon: ArchiveIcon,
      description: "Threads put away without deleting them, to open, unarchive, or delete for good.",
      body: () => <ArchivedPage deps={deps} />,
    });
    slots.add(Layers, {
      id: DELETE_DIALOG,
      order: 35,
      component: () => (
        <Show when={dialogs.current() === DELETE_DIALOG}>
          <DeleteThreadsDialog threads={threads} sessions={asked()} hidden={hiddenAsked()} close={() => dialogs.open(undefined)} />
        </Show>
      ),
    });
    slots.add(Actions, {
      id: "archived-page.open",
      order: 10,
      title: "Archived threads",
      category: "Thread",
      keywords: ["archive", "unarchive", "restore", "hidden", "delete", "history", "settings"],
      icon: ArchiveIcon,
      run: () => settings.open(SECTION),
    });
  },
});
