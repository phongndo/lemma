import { For, Show, createMemo, createSignal, createUniqueId, onCleanup, onMount } from "solid-js";
import { WorkspaceChannels } from "@lemma/workspace";
import { Portal } from "solid-js/web";
import { listKey, quickKey } from "@lemma/web/keys";
import { createQuickHold } from "@lemma/web/quick-pick";
import { tildePath } from "@lemma/web/format";
import { Actions } from "@lemma/actions";
import { Dialogs, Layers } from "@lemma/frame";
import { Client, Notify, Slots, defineWebPlugin, Highlighted } from "@lemma/web";
import { Workspace, WorkspaceActionIds } from "@lemma/workspace/web";
import type { DialogsService } from "@lemma/frame";
import type { ClientService, NotifyService } from "@lemma/web";
import type { WorkspaceService } from "@lemma/workspace/web";
import { ChevronIcon, FolderIcon, FolderPlusIcon, GitBranchIcon, Spinner } from "@lemma/look";
import { above, listRows } from "./rows.ts";
import type { Listing, Row } from "./rows.ts";
import styles from "./add-project.css?inline";

const DIALOG = "add-project";

interface Deps {
  readonly client: ClientService;
  readonly workspace: WorkspaceService;
  readonly notify: NotifyService;
  readonly dialogs: DialogsService;
}

const withSlash = (path: string) => (path.endsWith("/") ? path : `${path}/`);

/**
 * Pick a folder on the host by typing its path. Matching folders list as you
 * type (letters in order match). As in every search list, ↑ and ↓ move, and
 * Enter, a click, or mod+1 … mod+9 picks a row: a folder opens, a name that
 * matches nothing is created. Tab, → at the end, or a row's chevron goes into
 * the highlighted folder; at a slash the first row opens the folder typed, and
 * `..` or Backspace goes up with the folder left highlighted. A key that picks
 * waits for the folders of what is typed, so it never acts on the last path's.
 */
function AddProjectDialog(props: { deps: Deps }) {
  // Unique per instance: the page could show two lists.
  const listId = `add-project-list-${createUniqueId()}`;
  const { client, workspace, notify, dialogs } = props.deps;
  const [value, setValue] = createSignal("");
  const [listing, setListing] = createSignal<Listing>();
  const [active, setActive] = createSignal(0);
  const [loading, setLoading] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [home, setHome] = createSignal<string>();
  let input!: HTMLInputElement;
  let list!: HTMLDivElement;
  let request = 0;
  let debounce: number | undefined;
  /** The path last asked for, and the one the folders shown answer (listed, or failed to be). */
  let asked: string | undefined;
  let answered: string | undefined;
  /** A key that picks, waiting for `answered` to catch up with what is typed. */
  let waiting: (() => void) | undefined;
  /** A row was moved to (↑/↓, the pointer) since the path last changed: the folders arriving leave it chosen. */
  let chosen = false;
  const previous = document.activeElement as HTMLElement | null;

  const rows = createMemo(() => listRows(value(), listing(), home()));

  const close = () => dialogs.open(undefined);
  /** List `typed`, highlighting the folder named `select` when it is there. */
  const refresh = async (typed: string, select?: string) => {
    const id = ++request;
    asked = typed;
    setLoading(true);
    try {
      const next = await client.channel.call(WorkspaceChannels.browse, { partialPath: typed });
      if (id !== request) return;
      setListing(next);
      const index = rows().findIndex((row) => row.kind === "entry" && row.entry.name === select);
      if (index !== -1 || !chosen) setActive(Math.max(index, 0));
      else setActive((at) => Math.min(at, rows().length - 1));
      list.scrollTop = 0;
      if (index > 0) list.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
    } catch {
      if (id === request) setListing(undefined);
    } finally {
      if (id === request) {
        setLoading(false);
        answered = typed;
        const run = waiting;
        waiting = undefined;
        run?.();
      }
    }
  };
  const update = (next: string, immediate = false, select?: string) => {
    setValue(next);
    waiting = undefined;
    chosen = false;
    window.clearTimeout(debounce);
    if (immediate) void refresh(next, select);
    else debounce = window.setTimeout(() => void refresh(next), 50);
  };
  const go = (path: string, select?: string) => {
    const next = withSlash(tildePath(path, home()));
    update(next, true, select);
    input.focus();
    input.setSelectionRange(next.length, next.length);
  };
  const up = () => {
    // `~/` goes up too, to the folder holding the home folder.
    const to = above(value(), home());
    if (to !== undefined) go(to.path, to.from);
  };

  const open = async (path: string) => {
    setBusy(true);
    const opened = await workspace.open(path);
    setBusy(false);
    if (opened) close();
  };
  const create = async (path: string) => {
    setBusy(true);
    try {
      const status = await client.channel.call(WorkspaceChannels.createDirectory, { path });
      if (await workspace.open(status.path)) close();
    } catch (error) {
      notify.report(error, "Could not create the folder");
    } finally {
      setBusy(false);
    }
  };
  const pick = (row: Row | undefined) => {
    if (busy()) return;
    if (row === undefined) {
      if (value().trim() !== "") void open(value());
      return;
    }
    switch (row.kind) {
      case "here":
        void open(row.path);
        return;
      case "up":
        go(row.path, row.from);
        return;
      case "entry":
        void open(row.entry.path);
        return;
      case "create":
        void create(row.path);
        return;
    }
  };
  const move = (delta: number) => {
    const count = rows().length;
    if (count === 0) return;
    chosen = true;
    setActive((index) => (index + delta + count) % count);
    list.querySelector(`[data-index="${active()}"]`)?.scrollIntoView({ block: "nearest" });
  };

  /** Runs a key that picks on the rows of what is typed: now, or once its folders arrive, asked for at once. */
  const settled = (act: () => void) => {
    if (answered === value()) return act();
    waiting = act;
    if (asked !== value()) {
      window.clearTimeout(debounce);
      void refresh(value());
    }
  };

  const caretAtEnd = () => input.selectionStart === value().length && input.selectionEnd === value().length;
  const hold = createQuickHold();
  const onKeyDown = (event: KeyboardEvent) => {
    hold.track(event);
    const list = event.isComposing ? undefined : listKey(event);
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (list !== undefined) {
      event.preventDefault();
      if (!("pick" in list)) move(list.move);
      else
        settled(() => {
          const row = rows()[list.pick];
          if (row !== undefined) pick(row);
        });
    } else if ((event.key === "Tab" && !event.shiftKey) || (event.key === "ArrowRight" && caretAtEnd())) {
      event.preventDefault();
      settled(() => {
        const row = rows()[active()];
        if (row?.kind === "entry") go(row.entry.path);
      });
    } else if (event.key === "Tab") {
      // Shift+Tab too: focus stays in the dialog.
      event.preventDefault();
    } else if (event.key === "Backspace" && value().endsWith("/") && caretAtEnd() && value().length > 1) {
      event.preventDefault();
      up();
    } else if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      settled(() => pick(rows()[active()]));
    }
  };

  onMount(() => {
    input.focus();
    const initial = "~/";
    update(initial, true);
    input.setSelectionRange(initial.length, initial.length);
    // The host user's home, for `~`: `..` from it, or a typed `/`, goes on to the disk's root.
    void client.channel.call(WorkspaceChannels.browse, { partialPath: "~/" }).then(
      (found) => setHome(found.parent),
      () => {
        /* absolute paths still work */
      },
    );
  });
  onCleanup(() => {
    window.clearTimeout(debounce);
    // Closed, nothing waiting may open a project.
    waiting = undefined;
    request++;
    previous?.focus?.();
  });

  return (
    <Portal>
      <div
        class="backdrop palette-backdrop"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) close();
        }}
      >
        <div class="palette" role="dialog" aria-modal="true" aria-label="Add project" onKeyDown={onKeyDown} onKeyUp={hold.track} onFocusOut={hold.track}>
          <div class="palette-input">
            <FolderIcon />
            <input
              ref={input}
              value={value()}
              placeholder="Type a folder path on the host"
              aria-label="Folder path"
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={rows().length > 0 ? `${listId}-${active()}` : undefined}
              autocomplete="off"
              autocapitalize="off"
              spellcheck={false}
              onInput={(event) => update(event.currentTarget.value)}
            />
            <Show when={loading() || busy()}>
              <Spinner />
            </Show>
          </div>
          <div class="palette-list" id={listId} role="listbox" ref={list}>
            <For each={rows()}>
              {(row, index) => (
                <div
                  id={`${listId}-${index()}`}
                  class="palette-row"
                  classList={{ create: row.kind === "create" }}
                  role="option"
                  data-index={index()}
                  data-active={String(index() === active())}
                  data-quick-key={hold.held() ? quickKey(index()) : undefined}
                  aria-selected={index() === active()}
                  onPointerMove={() => setActive(index())}
                  // The path keeps focus, so the keys still reach the list.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => pick(row)}
                >
                  {(() => {
                    switch (row.kind) {
                      case "here":
                        return (
                          <>
                            <FolderIcon />
                            <span class="palette-name">
                              Open <span class="palette-mono">{tildePath(row.path, home()).replace(/(.)\/+$/, "$1")}</span>
                            </span>
                          </>
                        );
                      case "up":
                        return (
                          <>
                            <FolderIcon />
                            <span class="palette-name palette-mono">
                              <span aria-hidden="true">..</span>
                              <span class="tw:sr-only">Up to {tildePath(row.path, home())}</span>
                            </span>
                          </>
                        );
                      case "create":
                        return (
                          <>
                            <FolderPlusIcon />
                            <span class="palette-name">
                              Create folder <span class="palette-mono">{tildePath(row.path, home())}</span>
                            </span>
                          </>
                        );
                      case "entry":
                        return (
                          <>
                            <Show when={row.entry.git} fallback={<FolderIcon />}>
                              <GitBranchIcon />
                            </Show>
                            <span class="palette-name">
                              <Highlighted text={row.entry.name} matches={row.entry.matches} />
                            </span>
                            <button
                              type="button"
                              class="icon-button palette-into"
                              aria-label={`Show folders in ${row.entry.name}`}
                              data-tip="Show folders inside"
                              tabindex="-1"
                              onClick={(event) => {
                                event.stopPropagation();
                                go(row.entry.path);
                              }}
                            >
                              <ChevronIcon />
                            </button>
                          </>
                        );
                    }
                  })()}
                </div>
              )}
            </For>
            <Show when={!loading() && listing() === undefined && value() !== ""}>
              <div class="palette-empty">No folder here. Check the path.</div>
            </Show>
            <Show when={listing()?.truncated}>
              <div class="palette-note">Showing the first {listing()?.entries.length}</div>
            </Show>
          </div>
        </div>
      </div>
    </Portal>
  );
}

/** Pick a folder on the host to start chats in. */
export default defineWebPlugin({
  id: "workspace.add-project",
  styles,
  requires: { client: Client, workspace: Workspace, notify: Notify, dialogs: Dialogs, slots: Slots },
  setup: (deps) => {
    const { dialogs, slots } = deps;
    slots.add(Layers, {
      id: DIALOG,
      order: 10,
      component: () => (
        <Show when={dialogs.current() === DIALOG}>
          <AddProjectDialog deps={deps} />
        </Show>
      ),
    });
    slots.add(Actions, {
      id: WorkspaceActionIds.addProject,
      order: 6,
      title: "Add project…",
      category: "Projects",
      keywords: ["open folder", "directory"],
      icon: FolderPlusIcon,
      run: () => dialogs.open(DIALOG),
    });
  },
});
