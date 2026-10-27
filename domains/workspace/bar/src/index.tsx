import { For, Show, createMemo, createSignal } from "solid-js";
import { WorkspaceChannels } from "@lemma/workspace";
import type { GitBranch, WorkspaceStatus } from "@lemma/workspace";
import { folderName, ProjectActions, Workspace, WorkspaceActionIds, WorktreeActions } from "@lemma/workspace/web";
import { Actions } from "@lemma/actions";
import { ActionMenu, Dialogs, Layers } from "@lemma/frame";
import { SectionIds, SettingsGroups } from "@lemma/settings";
import { ComposerNotices, ThreadCard, Threads, ThreadStart, threadCount } from "@lemma/threads";
import { Client, Notify, Slots, defineWebPlugin, usePlugin } from "@lemma/web";
import { copyAndTell } from "@lemma/web/clipboard";
import type { DialogsService } from "@lemma/frame";
import type { ThreadsService } from "@lemma/threads";
import type { ClientService, NotifyService, SlotsService } from "@lemma/web";
import type { WorkspaceService } from "@lemma/workspace/web";
import {
  ChatIcon,
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  Dialog,
  FolderIcon,
  FolderPlusIcon,
  GitBranchIcon,
  HistoryIcon,
  LaptopIcon,
  PenSquareIcon,
  PlusIcon,
  Popover,
  RefreshIcon,
  SettingRow,
  Toggle,
  TrashIcon,
  WorktreeIcon,
} from "@lemma/look";
import type { Placement } from "@lemma/look";
import styles from "./workspace-bar.css?inline";

const REMOVE_DIALOG = "workspace-bar.remove-worktree";

interface Deps {
  readonly client: ClientService;
  readonly threads: ThreadsService;
  readonly workspace: WorkspaceService;
  readonly notify: NotifyService;
  readonly slots: SlotsService;
  readonly dialogs: DialogsService;
  /** Asks before removing the worktree at a path. */
  readonly askRemove: (path: string) => void;
}

/**
 * Where a thread works within its project, a git repository: its own checkout (`local`), a worktree it starts on its
 * first prompt (`new`, a new thread's), or a worktree (`worktree`, also one removed since). Undefined outside git, and
 * for a thread of its own.
 */
type Where = "local" | "new" | "worktree";

const whereOf = (deps: { readonly threads: ThreadsService; readonly workspace: WorkspaceService }): Where | undefined => {
  const { threads, workspace } = deps;
  const dir = workspace.workingDir();
  if (dir === undefined || workspace.isStandalone(dir)) return undefined;
  const git = workspace.status()?.git;
  if (workspace.place(dir)?.worktree === true || git?.worktreeOf !== undefined) return "worktree";
  if (git === undefined) return undefined;
  // Only a thread not yet started goes on to a new worktree: one started works where it is.
  return threads.blank() && workspace.newWorktree() ? "new" : "local";
};

/** How each place is shown: its icon and name, on the start line and in the thread card. */
const WHERE: Record<Where, { readonly label: string; readonly icon: () => ReturnType<typeof LaptopIcon> }> = {
  local: { label: "Local", icon: LaptopIcon },
  new: { label: "New worktree", icon: WorktreeIcon },
  worktree: { label: "Worktree", icon: WorktreeIcon },
};

/** The worktrees of `project` its threads work in, most recently used first, with how many threads each has. */
const worktreesIn = (deps: Deps, project: string): { readonly path: string; readonly branch: string; readonly threads: number }[] => {
  const { threads, workspace } = deps;
  const found = new Map<string, { branch: string; threads: number; at: number }>();
  for (const session of threads.list()) {
    const place = workspace.place(session.cwd);
    if (session.archived === true || session.lastSeq === 0 || place === undefined || !place.worktree || !place.exists || place.project !== project) continue;
    const known = found.get(session.cwd);
    found.set(session.cwd, {
      branch: place.branch ?? folderName(session.cwd),
      threads: (known?.threads ?? 0) + 1,
      at: Math.max(known?.at ?? 0, session.updatedAt),
    });
  }
  return [...found.entries()].sort(([, a], [, b]) => b.at - a.at).map(([path, { branch, threads: count }]) => ({ path, branch, threads: count }));
};

/**
 * The thread card's row for an open thread's project (`ThreadCard`), or that it is a thread of its own; its menu is
 * the project's (`ProjectActions`). Fixed since the thread began.
 */
function ProjectRow(props: { deps: Deps }) {
  const { workspace, slots } = props.deps;
  const dir = () => workspace.workingDir() ?? "";
  const project = () => workspace.project() ?? dir();
  const actions = () => slots.list(ProjectActions).filter((action) => action.when?.(project()) ?? true);
  return (
    <Show
      when={!workspace.isStandalone(dir())}
      fallback={
        <div class="menu-item" data-tip="A thread of its own, in no project">
          <span class="menu-check">
            <ChatIcon />
          </span>
          <span class="menu-label">No project</span>
        </div>
      }
    >
      <Popover
        label="Project"
        tip={project()}
        triggerClass="menu-item"
        placement="bottom-end"
        disabled={actions().length === 0}
        trigger={
          <>
            <span class="menu-check">
              <FolderIcon />
            </span>
            <span class="menu-label">{workspace.projectName(dir())}</span>
            {/* A worktree gone says so in its own row. */}
            <span class="menu-hint workspace-warning">
              {workspace.status()?.exists === false && workspace.place(dir())?.worktree !== true ? "folder not found" : ""}
            </span>
          </>
        }
      >
        {(close) => <ActionMenu subject={project()} control={undefined} slot={ProjectActions} actions={actions()} close={close} />}
      </Popover>
    </Show>
  );
}

/**
 * The thread card's row for where in its project an open thread works: its local checkout, or a worktree, whose menu
 * is the worktree's (`WorktreeActions`), and which says when it has been removed.
 */
function WhereRow(props: { deps: Deps }) {
  const { workspace, slots, notify } = props.deps;
  const dir = () => workspace.workingDir() ?? "";
  const where = () => whereOf(props.deps);
  const gone = () => workspace.status()?.exists === false || workspace.place(dir())?.exists === false;
  const actions = () => slots.list(WorktreeActions).filter((action) => action.when?.(dir()) ?? true);
  return (
    <Show when={where()}>
      {(at) => (
        <Popover
          label={at() === "worktree" ? "Worktree" : "Local checkout"}
          tip={at() === "worktree" ? `A worktree of ${workspace.projectName(dir())}, at ${dir()}` : `The project's own checkout, at ${dir()}`}
          triggerClass="menu-item"
          placement="bottom-end"
          trigger={
            <>
              <span class="menu-check">{WHERE[at()].icon()}</span>
              <span class="menu-label">{at() === "worktree" ? "Worktree" : "Local checkout"}</span>
              <span class="menu-hint" classList={{ "workspace-warning": gone() }}>
                {gone() ? (at() === "worktree" ? "removed" : "folder not found") : ""}
              </span>
            </>
          }
        >
          {(close) => (
            <Show
              when={at() === "worktree"}
              fallback={
                <button
                  class="menu-item"
                  role="menuitem"
                  onClick={usePlugin().action("copy the path", () => {
                    close();
                    return copyAndTell(notify, dir());
                  })}
                >
                  <span class="menu-check">
                    <CopyIcon />
                  </span>
                  <span class="menu-label">Copy path</span>
                </button>
              }
            >
              <ActionMenu subject={dir()} control={undefined} slot={WorktreeActions} actions={actions()} close={close} />
            </Show>
          )}
        </Popover>
      )}
    </Show>
  );
}

/** A long branch name with its middle left out, as `backup/main-befo…014-021326`: both ends say which it is. */
const shortened = (name: string, max = 32): string => {
  if (name.length <= max) return name;
  const head = Math.ceil((max - 1) * 0.55);
  return `${name.slice(0, head)}…${name.slice(name.length - (max - 1 - head))}`;
};

/**
 * A new chat's start line (`ThreadStart`): its project; where in it the chat works, in a git repository (its local
 * checkout, a new worktree, or a worktree another thread works in); and the git branch it works on, or a new worktree
 * starts from. All chosen before it starts, and fixed once the first prompt is sent, when the thread card shows them.
 */
function WorkspaceStart(props: { deps: Deps }) {
  const { workspace } = props.deps;
  return (
    <Show when={workspace.workingDir() !== undefined}>
      <ProjectPicker deps={props.deps} />
      <WherePicker deps={props.deps} />
      {/* A thread of its own, in no project, has no branch to choose. */}
      <Show when={!workspace.isStandalone(workspace.workingDir() ?? "") && workspace.status()?.git}>
        {(git) => <BranchPicker deps={props.deps} git={git()} onChanged={workspace.setStatus} variant="chip" placement="bottom" />}
      </Show>
      <Show when={workspace.status()?.exists === false}>
        <span class="workspace-warning">Folder not found on the host</span>
      </Show>
    </Show>
  );
}

/** A new chat's project: the projects (never a worktree, which is a place in one), no project, or one to add. */
function ProjectPicker(props: { deps: Deps }) {
  const { threads, workspace, slots } = props.deps;
  const current = () => workspace.project() ?? "";
  const addProject = () => slots.get(Actions, WorkspaceActionIds.addProject);
  const standalone = () => workspace.isStandalone(current());
  const newStandalone = usePlugin().action("start a chat in no project", () => workspace.newStandalone());
  const pick = usePlugin().action("start the chat in the project picked", (path: string) => threads.newThread(path, { inPlace: true }));
  return (
    <Show when={threads.blank()}>
      <Popover
        label="Project"
        tip={standalone() ? "A thread of its own, in no project" : current()}
        trigger={
          <>
            <Show
              when={!standalone()}
              fallback={
                <>
                  <ChatIcon />
                  <span class="strip-label">No project</span>
                </>
              }
            >
              <FolderIcon />
              <span class="strip-label">{workspace.projectName(current())}</span>
            </Show>
            <ChevronDownIcon />
          </>
        }
        triggerClass="strip-chip start-chip"
        placement="bottom"
        menuClass="project-menu"
      >
        {(close) => (
          <>
            <div class="menu-section">Project</div>
            <For each={workspace.projects()}>
              {(path) => (
                <button
                  class="menu-item"
                  role="menuitemradio"
                  aria-checked={path === current()}
                  onClick={() => {
                    // Picked again from one of its worktrees, it goes back to the project's own checkout.
                    if (path !== workspace.workingDir()) pick(path);
                    close();
                  }}
                >
                  <span class="menu-check">
                    <Show when={path === current()}>
                      <CheckIcon />
                    </Show>
                  </span>
                  <span class="menu-label">{workspace.projectName(path)}</span>
                  <span class="menu-hint">{path.slice(0, path.length - folderName(path).length - 1)}</span>
                </button>
              )}
            </For>
            <button
              class="menu-item"
              role="menuitemradio"
              aria-checked={standalone()}
              onClick={() => {
                close();
                newStandalone();
              }}
            >
              <span class="menu-check">
                <Show when={standalone()} fallback={<ChatIcon />}>
                  <CheckIcon />
                </Show>
              </span>
              <span class="menu-label">No project</span>
              <span class="menu-hint">a thread of its own</span>
            </button>
            <Show when={addProject()}>
              {(action) => (
                <button
                  class="menu-item"
                  role="menuitem"
                  onClick={() => {
                    close();
                    action().run();
                  }}
                >
                  <span class="menu-check">
                    <FolderPlusIcon />
                  </span>
                  <span class="menu-label">Add project…</span>
                </button>
              )}
            </Show>
          </>
        )}
      </Popover>
    </Show>
  );
}

/**
 * Where in a git project a new chat works: its local checkout as it is, a new worktree on a branch of its own (named
 * from the first prompt), or a worktree its other threads work in, to go on there.
 */
function WherePicker(props: { deps: Deps }) {
  const { threads, workspace } = props.deps;
  const where = () => whereOf(props.deps);
  const project = () => workspace.project() ?? "";
  const dir = () => workspace.workingDir() ?? "";
  const worktrees = () => worktreesIn(props.deps, project());
  /** The project's own branch, for its Local item: known from its threads, or asked as the menu opens. */
  const localBranch = () => {
    const branch = workspace.place(project())?.branch;
    return branch === undefined ? "" : (branch ?? "detached");
  };
  const plugin = usePlugin();
  const go = plugin.action("move the chat to where was picked", async (path: string, newWorktree?: boolean) => {
    if (path !== dir()) await threads.newThread(path, { inPlace: true });
    if (newWorktree !== undefined) workspace.setWorktree(newWorktree);
  });
  return (
    <Show when={threads.blank() && where()}>
      {(at) => (
        <Popover
          label="Where to work"
          tip={
            at() === "local"
              ? `In ${folderName(project())} as it is`
              : at() === "new"
                ? "In a new worktree: its own checkout, on a new branch named from your first message, so its changes stay apart"
                : `In the worktree at ${dir()}`
          }
          trigger={
            <>
              {WHERE[at()].icon()}
              {/* Which worktree, its branch says beside it. */}
              <span class="strip-label">{WHERE[at()].label}</span>
              <ChevronDownIcon />
            </>
          }
          triggerClass="strip-chip start-chip"
          placement="bottom"
          menuClass="where-menu"
          onOpen={plugin.action("ask where the project is", () => workspace.refreshPlaces([project()]))}
        >
          {(close) => (
            <>
              <div class="menu-section">Work in</div>
              <button
                class="menu-item"
                role="menuitemradio"
                aria-checked={at() === "local"}
                data-tip={`The project's own checkout, ${project()}, as it is: changes there are the ones you see`}
                onClick={() => {
                  close();
                  go(project(), false);
                }}
              >
                <span class="menu-check">
                  <Show when={at() === "local"} fallback={<LaptopIcon />}>
                    <CheckIcon />
                  </Show>
                </span>
                <span class="menu-label">Local</span>
                <span class="menu-hint">{localBranch()}</span>
              </button>
              <button
                class="menu-item"
                role="menuitemradio"
                aria-checked={at() === "new"}
                data-tip="A checkout of its own, on a new branch named from your first message, so this thread's changes stay apart"
                onClick={() => {
                  close();
                  go(project(), true);
                }}
              >
                <span class="menu-check">
                  <Show when={at() === "new"} fallback={<WorktreeIcon />}>
                    <CheckIcon />
                  </Show>
                </span>
                <span class="menu-label">New worktree</span>
                <span class="menu-hint">new branch</span>
              </button>
              <Show when={worktrees().length > 0}>
                <div class="menu-sep" />
                <div class="menu-section">Worktrees</div>
                <div class="menu-list where-list">
                  <For each={worktrees()}>
                    {(tree) => (
                      <button
                        class="menu-item"
                        role="menuitemradio"
                        aria-checked={tree.path === dir()}
                        data-tip={`Go on in ${tree.path}`}
                        onClick={() => {
                          close();
                          go(tree.path);
                        }}
                      >
                        <span class="menu-check">
                          <Show when={tree.path === dir()} fallback={<GitBranchIcon />}>
                            <CheckIcon />
                          </Show>
                        </span>
                        <span class="menu-label branch-name">{shortened(tree.branch)}</span>
                        <span class="menu-hint">{threadCount(tree.threads)}</span>
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            </>
          )}
        </Popover>
      )}
    </Show>
  );
}

function BranchPicker(props: {
  deps: Deps;
  git: NonNullable<WorkspaceStatus["git"]>;
  onChanged: (status: WorkspaceStatus) => void;
  /** The start line's chip, or the thread card's row (`menu-item`, its counts as its hint). */
  variant: "chip" | "row";
  placement: Placement;
}) {
  const { client, threads, workspace, notify } = props.deps;
  const plugin = usePlugin();
  const workingDir = workspace.workingDir;
  const [branches, setBranches] = createSignal<readonly GitBranch[]>([]);
  const [query, setQuery] = createSignal("");
  const [switching, setSwitching] = createSignal(false);
  // Switching branches under a running turn would change files the agent is editing.
  const busyHere = () => threads.running().some((id) => threads.list().find((session) => session.id === id)?.cwd === workingDir());

  const load = async () => {
    setQuery("");
    const path = workingDir();
    if (path === undefined) return;
    try {
      setBranches(await client.channel.call(WorkspaceChannels.branches, { path }));
    } catch (error) {
      notify.report(error, "Could not list branches");
    }
  };
  const filtered = createMemo(() => {
    const needle = query().trim().toLowerCase();
    return needle === "" ? branches() : branches().filter((branch) => branch.name.toLowerCase().includes(needle));
  });
  /** A new chat headed for a new worktree: the menu picks the branch it starts from instead of switching. */
  const baseMode = () => threads.blank() && workspace.newWorktree();
  const base = () => workspace.worktree().base ?? props.git.branch ?? undefined;
  const canCreate = () => {
    if (baseMode()) return false;
    const name = query().trim();
    // `x` matching a remote `origin/x` checks that out instead of creating a new branch.
    return name !== "" && !branches().some((branch) => branch.name === name || (branch.remote && branch.name.slice(branch.name.indexOf("/") + 1) === name));
  };

  const checkout = async (branch: string, create: boolean, close: () => void) => {
    const path = workingDir();
    if (path === undefined) return;
    close();
    setSwitching(true);
    try {
      props.onChanged(await client.channel.call(WorkspaceChannels.checkout, create ? { path, branch, create: true } : { path, branch }));
    } catch (error) {
      notify.report(error, `Could not switch to ${branch}`);
    } finally {
      setSwitching(false);
    }
  };

  const here = () => props.git.branch ?? `detached ${props.git.head ?? ""}`.trim();
  /** The remote a new worktree can start from: the current branch's, else `origin`. */
  const remote = () => props.git.upstream?.split("/")[0] ?? "origin";
  /** What a new worktree starts from: the base branch, or its remote version when it starts from the remote. */
  const from = () => {
    const branch = base() ?? here();
    return workspace.fromRemote() && !branch.startsWith(`${remote()}/`) ? `${remote()}/${branch}` : branch;
  };
  const label = () => (baseMode() ? `from ${from()}` : here());
  const choose = (branch: GitBranch, close: () => void) => {
    if (baseMode()) {
      workspace.setWorktreeBase(branch.current ? undefined : branch.name);
      close();
      return;
    }
    if (branch.current) {
      close();
      return;
    }
    if (branch.worktree !== undefined) {
      close();
      // git keeps a branch in one worktree at a time; go to where it is instead.
      if (threads.blank()) void threads.newThread(branch.worktree, { inPlace: true });
      else notify.toast({ level: "info", message: `${branch.name} is checked out in the worktree at ${branch.worktree}` });
      return;
    }
    void checkout(branch.name, false, close);
  };
  /** The row's hint: uncommitted changes, and how far it is ahead of and behind its upstream. */
  const counts = () =>
    [
      props.git.changes > 0 ? `${props.git.changes} changed` : undefined,
      props.git.ahead > 0 ? `↑${props.git.ahead}` : undefined,
      props.git.behind > 0 ? `↓${props.git.behind}` : undefined,
    ]
      .filter(Boolean)
      .join(" · ");
  const checked = (branch: GitBranch) => (baseMode() ? branch.name === base() : branch.current);
  const title = () =>
    [
      props.git.branch === null ? "Detached HEAD" : `On ${props.git.branch}`,
      props.git.changes > 0 ? `${props.git.changes} uncommitted change${props.git.changes === 1 ? "" : "s"}` : "clean",
      props.git.upstream === undefined ? undefined : `${props.git.ahead} ahead, ${props.git.behind} behind ${props.git.upstream}`,
      busyHere() ? "Branch switching waits for the running turn" : undefined,
    ]
      .filter(Boolean)
      .join(" · ");

  return (
    <Popover
      label={baseMode() ? "Worktree base branch" : "Git branch"}
      tip={baseMode() ? "The branch the new worktree starts from; the worktree gets a new branch of its own, named from your first message" : title()}
      disabled={busyHere() || switching()}
      triggerClass={props.variant === "row" ? "menu-item" : "strip-chip start-chip"}
      placement={props.placement}
      menuClass="branch-menu"
      onOpen={plugin.action("load branches", () => load())}
      trigger={
        <Show
          when={props.variant === "chip"}
          fallback={
            <>
              <span class="menu-check">
                <GitBranchIcon />
              </span>
              <span class="menu-label">{switching() ? "Switching…" : label()}</span>
              <span class="menu-hint">{counts()}</span>
            </>
          }
        >
          <GitBranchIcon />
          <span class="strip-label">{switching() ? "Switching…" : label()}</span>
          <Show when={!baseMode()}>
            <Show when={props.git.changes > 0}>
              <span class="strip-dirty" aria-label={`${props.git.changes} uncommitted changes`}>
                {props.git.changes}
              </span>
            </Show>
            <Show when={props.git.ahead > 0}>
              <span class="strip-count">↑{props.git.ahead}</span>
            </Show>
            <Show when={props.git.behind > 0}>
              <span class="strip-count">↓{props.git.behind}</span>
            </Show>
          </Show>
        </Show>
      }
    >
      {(close) => (
        <>
          <input
            class="menu-search"
            placeholder={baseMode() ? "Search branches" : "Find or create a branch"}
            aria-label={baseMode() ? "Search branches" : "Find or create a branch"}
            autocomplete="off"
            spellcheck={false}
            data-autofocus
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
          <div class="menu-list">
            <Show when={canCreate()}>
              <button class="menu-item" role="menuitem" onClick={plugin.action("create branch", () => checkout(query().trim(), true, close))}>
                <span class="menu-check">
                  <PlusIcon />
                </span>
                <span class="menu-label">Create “{query().trim()}”</span>
                <span class="menu-hint">from {here()}</span>
              </button>
            </Show>
            <For each={filtered()}>
              {(branch) => (
                <button
                  class="menu-item"
                  role="menuitemradio"
                  aria-checked={checked(branch)}
                  data-tip={
                    !baseMode() && branch.worktree !== undefined
                      ? `Checked out in ${branch.worktree}`
                      : shortened(branch.name) === branch.name
                        ? undefined
                        : branch.name
                  }
                  onClick={() => choose(branch, close)}
                >
                  <span class="menu-check">
                    <Show when={checked(branch)}>
                      <CheckIcon />
                    </Show>
                  </span>
                  <span class="menu-label branch-name">{shortened(branch.name)}</span>
                  <span class="menu-hint">
                    {baseMode() && branch.current ? "current" : branch.worktree !== undefined ? "worktree" : branch.remote ? "remote" : ""}
                  </span>
                </button>
              )}
            </For>
            <Show when={filtered().length === 0 && !canCreate()}>
              <div class="picker-empty">No branches</div>
            </Show>
          </div>
          <Show
            when={baseMode()}
            fallback={
              <Show when={props.git.changes > 0}>
                <div class="menu-note">Uncommitted changes move with you; git refuses a switch that would overwrite them.</div>
              </Show>
            }
          >
            <div class="menu-toggle-row" data-tip={`Fetch the branch first and start from ${remote()}'s version of it, rather than this clone's`}>
              <RefreshIcon />
              <span class="menu-label">Start from {remote()}</span>
              <span class="spacer" />
              <Toggle label={`Start from ${remote()}`} checked={workspace.fromRemote()} onChange={workspace.setFromRemote} />
            </div>
          </Show>
        </>
      )}
    </Popover>
  );
}

/**
 * Asks before removing a worktree, saying what goes (its folder, and any uncommitted changes, which then need a second
 * word) and what stays (its branch and commits, and its threads, from which it can be made again).
 */
function RemoveWorktreeDialog(props: { deps: Deps; path: string; close: () => void }) {
  const { client, threads, workspace, notify } = props.deps;
  const [status, setStatus] = createSignal<WorkspaceStatus>();
  const [removing, setRemoving] = createSignal(false);
  void client.channel.call(WorkspaceChannels.status, { path: props.path }).then(setStatus, () => {});
  /** The worktree's own folder, which goes whole: the path asked about may be a folder in it. */
  const root = () => status()?.git?.root ?? props.path;
  const inIt = () =>
    threads.list().filter((session) => (session.cwd === props.path || session.cwd === root() || session.cwd.startsWith(`${root()}/`)) && session.lastSeq > 0);
  const running = () => inIt().some((session) => threads.running().includes(session.id));
  const changes = () => status()?.git?.changes ?? 0;
  const branch = () => status()?.git?.branch ?? workspace.place(props.path)?.branch ?? folderName(props.path);
  const remove = usePlugin().action("remove the worktree", async () => {
    setRemoving(true);
    try {
      await client.channel.call(WorkspaceChannels.removeWorktree, { path: props.path, ...(changes() > 0 ? { force: true } : {}) });
      props.close();
      notify.toast({ level: "info", message: `Removed the worktree of ${branch()}` });
    } catch (error) {
      notify.report(error, "Could not remove the worktree");
    } finally {
      setRemoving(false);
      await workspace.refreshPlaces([...new Set([props.path, ...inIt().map((session) => session.cwd)])]);
      await workspace.refresh();
    }
  });
  return (
    <Dialog
      title={`Remove the worktree of ${branch()}?`}
      onClose={props.close}
      class="remove-worktree-dialog"
      footer={
        <>
          <button class="button" data-autofocus onClick={props.close}>
            Cancel
          </button>
          <button class="button button-danger" disabled={running() || removing() || status() === undefined} onClick={remove}>
            {changes() > 0 ? "Remove, losing the changes" : "Remove worktree"}
          </button>
        </>
      }
    >
      <p>
        Its folder, <code>{root()}</code>, is deleted. The branch <code>{branch()}</code> and its commits stay
        {inIt().length > 0 ? `, and so do its ${threadCount(inIt().length)}, from which you can make it again` : ""}.
      </p>
      <Show when={changes() > 0}>
        <p class="workspace-warning-text">
          It has {changes()} uncommitted change{changes() === 1 ? "" : "s"}, which would be lost: commit them first to keep them.
        </p>
      </Show>
      <Show when={running()}>
        <p class="workspace-warning-text">A turn is running in it; stop it first.</p>
      </Show>
    </Dialog>
  );
}

/**
 * Where a thread works: a new chat's project, place in it, and branch, under its prompt (`ThreadStart`); an open
 * thread's, as rows of its card (`ThreadCard`), with what can be done with its worktree (`WorktreeActions`). And the
 * worktree setting for new chats.
 */
export default defineWebPlugin({
  id: "workspace.bar",
  styles,
  requires: { client: Client, threads: Threads, workspace: Workspace, notify: Notify, slots: Slots, dialogs: Dialogs },
  setup: ({ client, threads, workspace, notify, slots, dialogs }) => {
    const [removing, setRemoving] = createSignal<string>();
    const deps: Deps = {
      client,
      threads,
      workspace,
      notify,
      slots,
      dialogs,
      askRemove: (path) => {
        setRemoving(path);
        dialogs.open(REMOVE_DIALOG);
      },
    };
    slots.add(ThreadStart, { id: "workspace", order: 0, component: () => <WorkspaceStart deps={deps} /> });
    // An open thread's: its project, where in it it works, and its branch, which the row's menu switches (git keeps a running turn's).
    const status = workspace.status;
    slots.add(ThreadCard, { id: "workspace.folder", order: 10, group: "workspace", component: () => <ProjectRow deps={deps} /> });
    slots.add(ThreadCard, { id: "workspace.where", order: 15, group: "workspace", component: () => <WhereRow deps={deps} /> });
    slots.add(ThreadCard, {
      id: "workspace.branch",
      order: 20,
      group: "workspace",
      component: () => (
        <Show when={!workspace.isStandalone(workspace.workingDir() ?? "") && status()?.git}>
          {(git) => <BranchPicker deps={deps} git={git()} onChanged={workspace.setStatus} variant="row" placement="bottom-end" />}
        </Show>
      ),
    });

    const exists = (path: string) => workspace.place(path)?.exists !== false;
    slots.add(WorktreeActions, {
      id: "workspace-bar.new-thread",
      order: 10,
      label: () => "New thread here",
      icon: PenSquareIcon,
      when: exists,
      run: (path) => void threads.newThread(path),
    });
    slots.add(WorktreeActions, {
      id: "workspace-bar.copy-path",
      order: 20,
      label: () => "Copy path",
      icon: CopyIcon,
      run: (path) => void copyAndTell(notify, path),
    });
    /** Makes a removed worktree again where it was, on its branch: a thread whose worktree was removed goes on in it. */
    const restore = (path: string): Promise<unknown> =>
      client.channel.call(WorkspaceChannels.restoreWorktree, { path }).then(
        (status) => {
          notify.toast({ level: "info", message: `Restored the worktree at ${status.git?.root ?? path}` });
          // Every thread in it, a folder in it too, works there again.
          const root = status.git?.root ?? path;
          const cwds = threads.list().flatMap((session) => (session.cwd === root || session.cwd.startsWith(`${root}/`) ? [session.cwd] : []));
          return Promise.all([workspace.refreshPlaces([...new Set([path, ...cwds])]), workspace.refresh()]);
        },
        (error: unknown) => notify.report(error, "Could not restore the worktree"),
      );
    const removed = (path: string) => !exists(path) && workspace.place(path)?.worktree === true;
    slots.add(WorktreeActions, {
      id: "workspace-bar.restore",
      order: 30,
      label: () => "Restore worktree",
      icon: HistoryIcon,
      when: removed,
      run: (path) => void restore(path),
    });
    // A thread whose worktree is gone would work in a folder that is not there: say so where its next prompt is written.
    slots.add(ComposerNotices, {
      id: "workspace-bar.removed",
      order: 40,
      component: () => {
        const plugin = usePlugin();
        const dir = () => threads.active()?.cwd;
        return (
          <Show when={!threads.blank() && dir() !== undefined && removed(dir()!) && dir()}>
            {(path) => (
              <div
                class="callout callout-warn composer-callout"
                role="status"
                data-tip={`Its branch, ${workspace.place(path())?.branch ?? folderName(path())}, is kept: restoring makes the worktree again on it`}
              >
                <WorktreeIcon />
                <span>This thread's worktree was removed.</span>
                <button class="button small" onClick={plugin.action("restore the worktree", () => restore(path()))}>
                  Restore
                </button>
              </div>
            )}
          </Show>
        );
      },
    });
    slots.add(WorktreeActions, {
      id: "workspace-bar.remove",
      order: 90,
      section: true,
      danger: true,
      label: () => "Remove worktree…",
      icon: TrashIcon,
      when: exists,
      run: deps.askRemove,
    });
    slots.add(Layers, {
      id: REMOVE_DIALOG,
      order: 35,
      component: () => (
        <Show when={dialogs.current() === REMOVE_DIALOG && removing()} keyed>
          {(path) => <RemoveWorktreeDialog deps={deps} path={path} close={() => dialogs.open(undefined)} />}
        </Show>
      ),
    });

    slots.add(SettingsGroups, {
      id: "workspace-bar",
      section: SectionIds.general,
      title: "New threads",
      order: 10,
      entries: () => [
        {
          text: "Start in a new worktree git branch checkout workspace",
          view: () => (
            <SettingRow
              title="Start in a new worktree"
              description="In a git repository, a new thread gets its own checkout on a new branch, so its changes stay apart."
            >
              <Toggle label="Start in a new worktree" checked={workspace.worktree().enabled} onChange={workspace.setWorktree} />
            </SettingRow>
          ),
        },
      ],
    });
  },
});
