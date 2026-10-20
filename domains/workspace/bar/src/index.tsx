import { For, Show, createMemo, createSignal } from "solid-js";
import { WorkspaceChannels } from "@lemma/workspace";
import type { GitBranch, WorkspaceStatus } from "@lemma/workspace";
import { folderName, Workspace, WorkspaceActionIds } from "@lemma/workspace/web";
import { Actions } from "@lemma/actions";
import { SectionIds, SettingsGroups } from "@lemma/settings";
import { ThreadCard, Threads, ThreadStart } from "@lemma/threads";
import { Client, Notify, Slots, defineWebPlugin, usePlugin } from "@lemma/web";
import type { ThreadsService } from "@lemma/threads";
import type { ClientService, NotifyService, SlotsService } from "@lemma/web";
import type { WorkspaceService } from "@lemma/workspace/web";
import {
  ChatIcon,
  CheckIcon,
  ChevronDownIcon,
  FolderIcon,
  FolderPlusIcon,
  GitBranchIcon,
  PlusIcon,
  Popover,
  RefreshIcon,
  SettingRow,
  Toggle,
  WorktreeIcon,
} from "@lemma/look";
import type { Placement } from "@lemma/look";
import styles from "./workspace-bar.css?inline";

interface Deps {
  readonly client: ClientService;
  readonly threads: ThreadsService;
  readonly workspace: WorkspaceService;
  readonly notify: NotifyService;
  readonly slots: SlotsService;
}

/**
 * The thread card's row for where an open thread works (`ThreadCard`): its project (a worktree of one marked so, a
 * thread of its own as such), and a folder gone from the host. Fixed since the thread began, so it only shows.
 */
function FolderRow(props: { deps: Deps }) {
  const { workspace } = props.deps;
  const standalone = () => workspace.isStandalone(workspace.workingDir() ?? "");
  const git = () => workspace.status()?.git;
  const missing = () => workspace.status()?.exists === false;
  return (
    <Show when={workspace.workingDir()}>
      {(dir) => (
        <div
          class="menu-item"
          data-tip={
            standalone() ? "A thread of its own, in no project" : git()?.worktreeOf === undefined ? dir() : `A worktree of ${git()!.worktreeOf}, at ${dir()}`
          }
        >
          <span class="menu-check">{standalone() ? <ChatIcon /> : git()?.worktreeOf === undefined ? <FolderIcon /> : <WorktreeIcon />}</span>
          <span class="menu-label">{standalone() ? "No project" : workspace.projectName(git()?.worktreeOf ?? dir())}</span>
          <span class="menu-hint" classList={{ "workspace-warning": missing() }}>
            {missing() ? "folder not found" : git()?.worktreeOf === undefined ? "" : "worktree"}
          </span>
        </div>
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
 * A new chat's start line (`ThreadStart`): its project, with where in it to work in the project's menu, and the git
 * branch it works on (or a new worktree starts from), chosen before it starts.
 */
function WorkspaceStart(props: { deps: Deps }) {
  const { workspace } = props.deps;
  return (
    <Show when={workspace.workingDir() !== undefined}>
      <ProjectPicker deps={props.deps} />
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

/**
 * A new chat's project, and where in it the chat works: its current checkout, or a new worktree on a branch of its own.
 * Fixed once the first prompt is sent, when the thread card shows it.
 */
function ProjectPicker(props: { deps: Deps }) {
  const { threads, workspace, slots } = props.deps;
  const isNew = threads.blank;
  const projects = workspace.projects;
  const current = () => workspace.workingDir() ?? "";
  const addProject = () => slots.get(Actions, WorkspaceActionIds.addProject);
  const standalone = () => workspace.isStandalone(current());
  /** Its git checkout, when it has one: only then is a new worktree a choice. */
  const git = () => (standalone() ? undefined : workspace.status()?.git);
  const worktree = () => git() !== undefined && workspace.worktree().enabled;
  const branch = () => git()?.branch ?? "the current commit";
  const base = () => workspace.worktree().base ?? branch();
  const newStandalone = usePlugin().action("start a chat in no project", () => workspace.newStandalone());
  const pick = usePlugin().action("start the chat in the project picked", (path: string) => threads.newThread(path, { inPlace: true }));
  const where = (newWorktree: boolean, close: () => void) => {
    workspace.setWorktree(newWorktree);
    close();
  };
  const label = () => (
    <Show
      when={!standalone()}
      fallback={
        <>
          <ChatIcon />
          <span class="strip-label">No project</span>
        </>
      }
    >
      {worktree() ? <WorktreeIcon /> : <FolderIcon />}
      <span class="strip-label">{workspace.projectName(current())}</span>
    </Show>
  );
  return (
    <Show when={isNew()}>
      <Popover
        label="Project"
        tip={standalone() ? "A thread of its own, in no project" : worktree() ? `A new worktree of ${current()}` : current()}
        trigger={
          <>
            {label()}
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
            <For each={projects()}>
              {(path) => (
                <button
                  class="menu-item"
                  role="menuitemradio"
                  aria-checked={path === current()}
                  onClick={() => {
                    pick(path);
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
            <Show when={git()}>
              <div class="menu-sep" />
              <div class="menu-section">Workspace</div>
              <button
                class="menu-item"
                role="menuitemradio"
                aria-checked={!worktree()}
                data-tip={`Work in ${folderName(current())} as it is, on ${branch()}`}
                onClick={() => where(false, close)}
              >
                <span class="menu-check">
                  <Show when={!worktree()}>
                    <CheckIcon />
                  </Show>
                </span>
                <span class="menu-label">Current checkout</span>
                <span class="menu-hint">{branch()}</span>
              </button>
              <button
                class="menu-item"
                role="menuitemradio"
                aria-checked={worktree()}
                data-tip="A separate checkout in ~/.lemma/worktrees, on a new branch named from your first message, so this thread's changes stay apart"
                onClick={() => where(true, close)}
              >
                <span class="menu-check">
                  <Show when={worktree()}>
                    <CheckIcon />
                  </Show>
                </span>
                <span class="menu-label">New worktree</span>
                <span class="menu-hint">from {base()}</span>
              </button>
            </Show>
          </>
        )}
      </Popover>
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
  const baseMode = () => threads.blank() && workspace.worktree().enabled;
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

/** The project and branch: a new chat's, under its prompt (`ThreadStart`); an open thread's, in the thread card (`ThreadCard`). And the worktree setting for new chats. */
export default defineWebPlugin({
  id: "workspace.bar",
  styles,
  requires: { client: Client, threads: Threads, workspace: Workspace, notify: Notify, slots: Slots },
  setup: (deps) => {
    deps.slots.add(ThreadStart, { id: "workspace", order: 0, component: () => <WorkspaceStart deps={deps} /> });
    // An open thread's: where it works, and its branch, which the row's menu switches (git keeps a running turn's).
    const status = deps.workspace.status;
    deps.slots.add(ThreadCard, { id: "workspace.folder", order: 10, component: () => <FolderRow deps={deps} /> });
    deps.slots.add(ThreadCard, {
      id: "workspace.branch",
      order: 20,
      component: () => (
        <Show when={!deps.workspace.isStandalone(deps.workspace.workingDir() ?? "") && status()?.git}>
          {(git) => <BranchPicker deps={deps} git={git()} onChanged={deps.workspace.setStatus} variant="row" placement="bottom-end" />}
        </Show>
      ),
    });
    deps.slots.add(SettingsGroups, {
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
              <Toggle label="Start in a new worktree" checked={deps.workspace.worktree().enabled} onChange={deps.workspace.setWorktree} />
            </SettingRow>
          ),
        },
      ],
    });
  },
});
