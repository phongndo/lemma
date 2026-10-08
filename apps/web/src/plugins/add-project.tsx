import { For, Show, createMemo, createSignal, createUniqueId, onCleanup, onMount } from "solid-js";
import { WorkspaceChannels } from "@lemma/contracts";
import type { DirectoryEntry } from "@lemma/contracts";
import { Portal } from "solid-js/web";
import { listKey, quickKey } from "../lib/keys.ts";
import { createQuickHold } from "../lib/quick-pick.ts";
import { tildePath } from "../model/format.ts";
import { ActionIds, Actions, Client, Dialogs, Layers, Notify, Slots, Workspace } from "../ui/contracts.ts";
import type { ClientService, DialogsService, NotifyService, WorkspaceService } from "../ui/contracts.ts";
import { defineUiPlugin } from "../ui/define.ts";
import { ChevronIcon, FolderIcon, FolderPlusIcon, GitBranchIcon, Highlighted, Spinner } from "../ui/parts.tsx";
import styles from "./add-project.css?inline";

const DIALOG = "add-project";

interface Deps {
  readonly client: ClientService;
  readonly workspace: WorkspaceService;
  readonly notify: NotifyService;
  readonly dialogs: DialogsService;
}

type Row =
  | { readonly kind: "here"; readonly path: string }
  | { readonly kind: "entry"; readonly entry: DirectoryEntry }
  | { readonly kind: "create"; readonly path: string };

const withSlash = (path: string) => (path.endsWith("/") ? path : `${path}/`);

/**
 * Pick a folder on the host by typing its path. Matching folders list as you
 * type (letters in order match), the arrow keys move, Tab or → goes into the
 * highlighted folder, Backspace after a slash goes up, Enter opens. A name
 * that matches nothing can be created as a new folder.
 */
function AddProjectDialog(props: { deps: Deps }) {
  // Unique per instance: the page could show two lists.
  const listId = `add-project-list-${createUniqueId()}`;
  const { client, workspace, notify, dialogs } = props.deps;
  const [value, setValue] = createSignal("");
  const [listing, setListing] = createSignal<{ parent: string; entries: readonly DirectoryEntry[]; truncated: boolean }>();
  const [active, setActive] = createSignal(0);
  const [loading, setLoading] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [home, setHome] = createSignal<string>();
  let input!: HTMLInputElement;
  let list!: HTMLDivElement;
  let request = 0;
  let debounce: number | undefined;
  const previous = document.activeElement as HTMLElement | null;

  /** The part after the last slash: what the listing is filtered by. */
  const needle = () => value().slice(value().lastIndexOf("/") + 1);

  const rows = createMemo((): Row[] => {
    const current = listing();
    if (current === undefined) return [];
    const typed = needle();
    const out: Row[] = [];
    if (typed === "") out.push({ kind: "here", path: current.parent });
    out.push(...current.entries.map((entry): Row => ({ kind: "entry", entry })));
    const exact = current.entries.some((entry) => entry.name.toLowerCase() === typed.toLowerCase());
    if (typed !== "" && !exact) out.push({ kind: "create", path: `${withSlash(current.parent)}${typed}` });
    return out;
  });

  const close = () => dialogs.open(undefined);
  const refresh = async (typed: string) => {
    const id = ++request;
    setLoading(true);
    try {
      const next = await client.channel.call(WorkspaceChannels.browse, { partialPath: typed });
      if (id !== request) return;
      setListing(next);
      setActive(0);
      list.scrollTop = 0;
    } catch {
      if (id === request) setListing(undefined);
    } finally {
      if (id === request) setLoading(false);
    }
  };
  const update = (next: string, immediate = false) => {
    setValue(next);
    window.clearTimeout(debounce);
    if (immediate) void refresh(next);
    else debounce = window.setTimeout(() => void refresh(next), 50);
  };
  const go = (path: string) => {
    const next = withSlash(tildePath(path, home()));
    update(next, true);
    input.focus();
    input.setSelectionRange(next.length, next.length);
  };
  const up = () => {
    const trimmed = value().replace(/\/+$/, "");
    const cut = trimmed.lastIndexOf("/");
    if (cut < 0) return;
    go(trimmed.slice(0, cut) || "/");
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
    setActive((index) => (index + delta + count) % count);
    list.querySelector(`[data-index="${active()}"]`)?.scrollIntoView({ block: "nearest" });
  };

  const caretAtEnd = () => input.selectionStart === value().length && input.selectionEnd === value().length;
  const hold = createQuickHold();
  const onKeyDown = (event: KeyboardEvent) => {
    hold.track(event);
    const row = rows()[active()];
    const list = event.isComposing ? undefined : listKey(event);
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (list !== undefined) {
      event.preventDefault();
      if (!("pick" in list)) move(list.move);
      else if (list.pick < rows().length) pick(rows()[list.pick]);
    } else if ((event.key === "Tab" && !event.shiftKey) || (event.key === "ArrowRight" && caretAtEnd())) {
      if (row?.kind === "entry") {
        event.preventDefault();
        go(row.entry.path);
      } else if (event.key === "Tab") event.preventDefault();
    } else if (event.key === "Backspace" && value().endsWith("/") && caretAtEnd() && value().length > 1) {
      event.preventDefault();
      up();
    } else if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      pick(row);
    }
  };

  onMount(async () => {
    input.focus();
    // Learn the host user's home, then start beside the host's project.
    let userHome: string | undefined;
    try {
      userHome = (await client.channel.call(WorkspaceChannels.browse, { partialPath: "~/" })).parent;
      setHome(userHome);
    } catch {
      /* absolute paths still work */
    }
    const cwd = client.info()?.cwd;
    const initial = cwd === undefined ? "~/" : withSlash(tildePath(cwd.slice(0, cwd.lastIndexOf("/")) || "/", userHome));
    update(initial, true);
    input.setSelectionRange(initial.length, initial.length);
  });
  onCleanup(() => {
    window.clearTimeout(debounce);
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
              aria-activedescendant={`${listId}-${active()}`}
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
                  onClick={() => pick(row)}
                >
                  {(() => {
                    switch (row.kind) {
                      case "here":
                        return (
                          <>
                            <FolderIcon />
                            <span class="palette-name">
                              Open <span class="palette-mono">{tildePath(row.path, home())}</span>
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
            <Show when={!loading() && listing() !== undefined && rows().length === 0}>
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
export default defineUiPlugin({
  id: "add-project",
  styles,
  requires: { client: Client, workspace: Workspace, notify: Notify, dialogs: Dialogs, slots: Slots },
  setup: (deps) => {
    const { dialogs, slots } = deps;
    slots.add(Layers, {
      id: DIALOG,
      component: () => (
        <Show when={dialogs.current() === DIALOG}>
          <AddProjectDialog deps={deps} />
        </Show>
      ),
    });
    slots.add(Actions, {
      id: ActionIds.addProject,
      order: 6,
      title: "Add project…",
      category: "Projects",
      keywords: ["open folder", "directory"],
      icon: FolderPlusIcon,
      run: () => dialogs.open(DIALOG),
    });
  },
});
