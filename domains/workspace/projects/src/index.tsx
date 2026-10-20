import { For, Show, createEffect, createMemo, createSignal, on } from "solid-js";
import type { JSX } from "solid-js";
import { tildePath, relativeTime } from "@lemma/web/format";
import { createNow } from "@lemma/web/now";
import { WorkspaceChannels } from "@lemma/workspace";
import type { Worktree } from "@lemma/workspace";
import { folderName, ProjectActions, Workspace, WorkspaceActionIds, WorktreeActions } from "@lemma/workspace/web";
import { Actions } from "@lemma/actions";
import { ActionMenu, Dialogs, Layers } from "@lemma/frame";
import { Settings, SettingsGroups, SettingsSections } from "@lemma/settings";
import type { SettingsEntry } from "@lemma/settings";
import { Threads } from "@lemma/threads";
import { Client, Slots, defineWebPlugin, usePlugin } from "@lemma/web";
import type { SlotsService, ClientService } from "@lemma/web";
import type { ThreadsService } from "@lemma/threads";
import type { WorkspaceService } from "@lemma/workspace/web";
import { CopyButton, Dialog, FolderIcon, FolderPlusIcon, GearIcon, MoreIcon, PenSquareIcon, Popover, Segmented, SettingRow, TrashIcon } from "@lemma/look";
import { initialOf, projectStats, threadCount, threadsIn, worktreeRows } from "./model.ts";
import type { ProjectStats } from "./model.ts";
import styles from "./projects-page.css?inline";

const SECTION = "projects";
const DELETE_DIALOG = "projects-page.delete";

/** Asks before deleting a project's threads, saying what goes and what stays. */
function DeleteProjectDialog(props: { client: ClientService; threads: ThreadsService; workspace: WorkspaceService; cwd: string; close: () => void }) {
  const { threads, workspace } = props;
  const inProject = () => threadsIn(threads.list(), props.cwd, workspace.projectOf);
  const archived = () => inProject().filter((session) => session.archived === true).length;
  const running = () => inProject().filter((session) => threads.running().includes(session.id)).length;
  const remove = () => {
    // A running thread cannot be deleted; it is left, and keeps the project listed.
    for (const session of inProject()) if (!threads.running().includes(session.id)) void threads.remove(session.id);
    if (running() === 0) workspace.remove(props.cwd);
    props.close();
  };
  return (
    <Dialog
      title={`Delete ${workspace.projectName(props.cwd)}?`}
      onClose={props.close}
      class="delete-project-dialog"
      footer={
        <>
          <button class="button" data-autofocus onClick={props.close}>
            Cancel
          </button>
          <button class="button button-danger" onClick={remove}>
            {inProject().length === 0 ? "Delete project" : `Delete ${threadCount(inProject().length - running())}`}
          </button>
        </>
      }
    >
      <p class="dialog-detail">
        <Show when={inProject().length > 0} fallback={<>It has no threads; it leaves your projects until you start a thread in it or add it again.</>}>
          This permanently deletes {threadCount(inProject().length)} in <code>{tildePath(props.cwd, props.client.info()?.home)}</code>
          {archived() > 0 ? `, ${archived()} of them archived` : ""}, and removes the project from your list. It cannot be undone.
        </Show>
      </p>
      <p class="dialog-detail muted">
        The project's folder is not touched. Worktrees Lemma made for its threads may go with them, unless they hold uncommitted work; their branches stay.
      </p>
      <Show when={running() > 0}>
        <p class="dialog-detail delete-project-running">
          {threadCount(running())} still running {running() === 1 ? "is" : "are"} kept; stop {running() === 1 ? "it" : "them"} to delete the project.
        </p>
      </Show>
    </Dialog>
  );
}

/** A project's mark: its initial on a tile. */
function Mark(props: { name: string; large?: boolean }) {
  return (
    <span class="project-mark" classList={{ large: props.large === true }} aria-hidden="true">
      {initialOf(props.name)}
    </span>
  );
}

/** What a project holds, in a line: its threads, those running and archived, and when it was last used. */
function statsLine(stats: ProjectStats, now: number): string {
  if (stats.threads === 0) return "No threads yet";
  return [
    threadCount(stats.threads),
    ...(stats.running > 0 ? [`${stats.running} running`] : []),
    ...(stats.archived > 0 ? [`${stats.archived} archived`] : []),
    ...(stats.lastActive === undefined ? [] : [`active ${relativeTime(stats.lastActive, now)}`]),
  ].join(" · ");
}

interface Deps {
  readonly client: ClientService;
  readonly threads: ThreadsService;
  readonly workspace: WorkspaceService;
  readonly slots: SlotsService;
  /** The project shown, and choosing another. */
  readonly current: () => string | undefined;
  readonly choose: (cwd: string) => void;
  readonly path: (cwd: string) => string;
  readonly stats: (cwd: string) => ProjectStats;
  readonly now: () => number;
  /** Adding a project, while a plugin offers it. */
  readonly addAction: () => { readonly run: () => unknown } | undefined;
}

/** The section's groups from every plugin, in order, for the project shown; groups with the same title merge. */
function Groups(props: { slots: SlotsService }) {
  const groups = createMemo(() => {
    const merged: { title?: string; entries: SettingsEntry[] }[] = [];
    for (const group of props.slots.list(SettingsGroups)) {
      if (group.section !== SECTION) continue;
      const same = merged.find((candidate) => candidate.title === group.title);
      if (same === undefined) merged.push({ ...(group.title === undefined ? {} : { title: group.title }), entries: [...group.entries()] });
      else same.entries.push(...group.entries());
    }
    return merged.filter((group) => group.entries.length > 0);
  });
  return (
    <For each={groups()}>
      {(group) => (
        <section class="settings-group">
          <Show when={group.title}>{(title) => <h3 class="settings-group-title">{title()}</h3>}</Show>
          <div class="settings-rows">
            <For each={group.entries}>{(entry) => entry.view()}</For>
          </div>
        </section>
      )}
    </For>
  );
}

/** The project chosen: its mark, name, and where it is, what it holds, a new thread in it, then its settings. */
function Detail(props: { deps: Deps; cwd: string }) {
  const { deps } = props;
  const name = () => deps.workspace.projectName(props.cwd);
  return (
    <div class="project-detail">
      <header class="project-head">
        <Mark name={name()} large />
        <div class="project-head-text">
          <h2>{name()}</h2>
          <div class="project-head-path">
            <code data-tip={props.cwd}>{deps.path(props.cwd)}</code>
            <CopyButton text={props.cwd} label="Copy path" />
          </div>
          <span class="project-head-stats">{statsLine(deps.stats(props.cwd), deps.now())}</span>
        </div>
        <button class="button small" onClick={usePlugin().action("new thread", () => deps.threads.newThread(props.cwd))}>
          <PenSquareIcon /> New thread
        </button>
      </header>
      <Groups slots={deps.slots} />
    </div>
  );
}

/** Every project beside the one chosen; none yet, a way to add one. */
function ProjectsPage(props: { deps: Deps }) {
  const { deps } = props;
  return (
    <Show
      when={deps.workspace.projects().length > 0}
      fallback={
        <div class="projects-empty">
          <FolderIcon />
          <h2>No projects yet</h2>
          <p class="muted">A project is a folder on the host that threads work in. It shows here once a thread starts in it, or once you add it.</p>
          <Show when={deps.addAction()}>
            {(action) => (
              <button class="button" onClick={() => action().run()}>
                <FolderPlusIcon /> Add project
              </button>
            )}
          </Show>
        </div>
      }
    >
      <div class="projects">
        <nav class="projects-list" aria-label="Projects">
          <For each={deps.workspace.projects()}>
            {(cwd) => {
              const stats = () => deps.stats(cwd);
              return (
                <button
                  type="button"
                  class="project-item"
                  aria-current={deps.current() === cwd ? "true" : undefined}
                  data-tip={deps.path(cwd)}
                  onClick={() => deps.choose(cwd)}
                >
                  <Mark name={deps.workspace.projectName(cwd)} />
                  <span class="project-item-text">
                    <span class="project-item-name">{deps.workspace.projectName(cwd)}</span>
                    <span class="project-item-path">{deps.path(cwd)}</span>
                  </span>
                  <Show when={stats().running > 0}>
                    <span class="project-item-running" aria-label={`${stats().running} running`} />
                  </Show>
                  <span class="project-item-count" aria-label={threadCount(stats().threads)}>
                    {stats().threads}
                  </span>
                </button>
              );
            }}
          </For>
        </nav>
        <div class="projects-detail">
          <Show when={deps.current()} keyed>
            {(cwd) => <Detail deps={deps} cwd={cwd} />}
          </Show>
        </div>
      </div>
    </Show>
  );
}

/**
 * Settings › Projects: every project in a list beside the one chosen, which shows where it is, what it holds, a new
 * thread in it, and its settings: its name, how new threads start there, and deleting it. Other plugins add rows for
 * the project chosen to the section's groups.
 */
export default defineWebPlugin({
  id: "workspace.projects",
  styles,
  requires: { client: Client, threads: Threads, workspace: Workspace, settings: Settings, dialogs: Dialogs, slots: Slots },
  setup: ({ client, threads, workspace, settings, dialogs, slots }) => {
    /** The project chosen, in the address (`?project=<directory>`). */
    const chosen = () => (settings.section() === SECTION ? settings.params().project : undefined);
    const setChosen = (cwd: string) => settings.setParams({ project: cwd });
    /** The project the page shows: the one chosen, while it exists, else the first. */
    const current = createMemo(() => {
      const pick = chosen();
      return pick !== undefined && workspace.projects().includes(pick) ? pick : workspace.projects()[0];
    });
    // Opening the section without a project in mind shows the one being worked in: a worktree's, its repository.
    createEffect(
      on(settings.section, (section, previous) => {
        const here = workspace.project();
        if (section === SECTION && previous !== SECTION && chosen() === undefined && here !== undefined && !workspace.isStandalone(here)) setChosen(here);
      }),
    );
    const [deleting, setDeleting] = createSignal<string | undefined>();
    const askDelete = (cwd: string) => {
      setDeleting(cwd);
      dialogs.open(DELETE_DIALOG);
    };
    const path = (cwd: string) => tildePath(cwd, client.info()?.home);
    const stats = (cwd: string) => projectStats(threads.list(), threads.running(), cwd, workspace.projectOf);
    // "Active 3m ago" moves on while the page shows.
    const now = createNow(30_000, () => settings.section() === SECTION);
    const addAction = () => slots.get(Actions, WorkspaceActionIds.addProject);
    const deps: Deps = {
      client,
      threads,
      workspace,
      slots,
      current,
      choose: setChosen,
      path,
      stats,
      now,
      addAction,
    };

    slots.add(SettingsSections, {
      id: SECTION,
      order: 25,
      title: "Projects",
      icon: FolderIcon,
      actions: () => (
        <Show when={addAction()}>
          {(action) => (
            <button class="button small" onClick={() => action().run()}>
              <FolderPlusIcon /> Add project
            </button>
          )}
        </Show>
      ),
      body: () => <ProjectsPage deps={deps} />,
    });

    /** A settings group about the current project; none while there is no project. */
    const group = (id: string, order: number, title: string | undefined, entries: (cwd: string) => { text: string; view: () => JSX.Element }[]) =>
      slots.add(SettingsGroups, {
        id,
        order,
        section: SECTION,
        ...(title === undefined ? {} : { title }),
        entries: () => {
          const cwd = current();
          return cwd === undefined ? [] : entries(cwd);
        },
      });

    group("projects-page.project", 0, "Project", (cwd) => [
      {
        text: `project name rename title ${workspace.projectName(cwd)}`,
        view: () => {
          let input!: HTMLInputElement;
          return (
            <SettingRow title="Name" description="Shown in the sidebar, the header, and the project picker. Blank uses the folder's name.">
              <input
                ref={input}
                class="field project-name"
                aria-label="Project name"
                value={workspace.projectSettings(cwd).name ?? ""}
                placeholder={folderName(cwd)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") input.blur();
                  if (event.key === "Escape") {
                    input.value = workspace.projectSettings(cwd).name ?? "";
                    input.blur();
                  }
                }}
                onBlur={() => workspace.configureProject(cwd, { name: input.value })}
              />
            </SettingRow>
          );
        },
      },
    ]);

    group("projects-page.new-threads", 10, "New threads", (cwd) => [
      {
        text: "project new threads start in a new worktree git branch checkout",
        view: () => {
          const value = () => {
            const worktree = workspace.projectSettings(cwd).worktree;
            return worktree === undefined ? "default" : worktree ? "on" : "off";
          };
          return (
            <SettingRow
              title="Start in a new worktree"
              description={`In a git repository, gives each new thread its own branch. Default follows General › New threads (${workspace.worktree().enabled ? "on" : "off"}).`}
            >
              <Segmented
                label="Start in a new worktree"
                value={value()}
                options={[
                  { value: "default", label: "Default" },
                  { value: "on", label: "Always" },
                  { value: "off", label: "Never" },
                ]}
                onChange={(next) => workspace.configureProject(cwd, { worktree: next === "default" ? undefined : next === "on" })}
              />
            </SettingRow>
          );
        },
      },
    ]);

    // The project's worktrees, as git lists them and as its threads worked in them: asked again when the project changes,
    // and when one of them comes or goes (removed or made again). Each listed is placed, so its menu knows whether it is
    // there to work in or remove, or gone and to restore. An answer for a project no longer shown is dropped.
    const [listed, setListed] = createSignal<{ readonly project: string; readonly worktrees: readonly Worktree[] }>();
    /** Which of the project's worktrees are there, as one string: it changes only when one of them comes or goes. */
    const presence = createMemo(() => {
      const project = current();
      if (project === undefined) return "";
      const paths = new Set([
        ...threads.list().map((session) => session.cwd),
        ...(listed()?.project === project ? listed()!.worktrees.map((tree) => tree.path) : []),
      ]);
      return [...paths]
        .flatMap((path) => {
          const place = workspace.place(path);
          return place?.worktree === true && place.project === project ? [`${path}:${place.exists}`] : [];
        })
        .sort()
        .join("|");
    });
    let listing = 0;
    createEffect(
      on([current, () => settings.section() === SECTION, presence], ([project, shown]) => {
        if (project === undefined || !shown) return;
        const request = ++listing;
        void client.channel.call(WorkspaceChannels.worktrees, { path: project }).then(
          (worktrees) => {
            if (request !== listing) return;
            setListed({ project, worktrees });
            const unplaced = worktrees.filter((tree) => workspace.place(tree.path) === undefined).map((tree) => tree.path);
            void workspace.refreshPlaces(unplaced);
          },
          () => {
            if (request === listing) setListed({ project, worktrees: [] });
          },
        );
      }),
    );
    group("projects-page.worktrees", 20, "Worktrees", (cwd) =>
      worktreeRows(listed()?.project === cwd ? listed()!.worktrees : [], threads.list(), workspace.place, cwd).map((row) => ({
        text: `worktree worktrees branch checkout remove restore clean up ${row.branch ?? ""} ${row.path}`,
        view: () => {
          const actions = () => slots.list(WorktreeActions).filter((action) => action.when?.(row.path) ?? true);
          return (
            <SettingRow
              title={row.branch ?? `${folderName(row.path)} (detached)`}
              description={[row.path, row.threads === 0 ? "no threads" : threadCount(row.threads), ...(row.removed ? ["removed"] : [])].join(" · ")}
            >
              <Popover label={`Worktree ${row.branch ?? folderName(row.path)}`} trigger={<MoreIcon />} triggerClass="icon-button" placement="bottom-end">
                {(close) => <ActionMenu subject={row.path} control={undefined} slot={WorktreeActions} actions={actions()} close={close} />}
              </Popover>
            </SettingRow>
          );
        },
      })),
    );

    group("projects-page.danger", 90, "Danger zone", (cwd) => [
      {
        text: "project delete remove forget threads",
        view: () => {
          const count = () => threadsIn(threads.list(), cwd, workspace.projectOf).length;
          return (
            <SettingRow
              title="Delete project"
              description={
                count() === 0
                  ? "Removes it from your projects. Its folder is not touched."
                  : `Deletes its ${threadCount(count())} for good, archived ones included, and removes it from your projects. Its folder is not touched; worktrees Lemma made for them may go with them.`
              }
            >
              <button class="button small button-danger" onClick={() => askDelete(cwd)}>
                <TrashIcon /> Delete…
              </button>
            </SettingRow>
          );
        },
      },
    ]);

    slots.add(ProjectActions, {
      id: "projects-page.settings",
      order: 30,
      label: () => "Project settings",
      icon: GearIcon,
      run: (cwd) => settings.open(SECTION, { project: cwd }),
    });
    slots.add(Layers, {
      id: DELETE_DIALOG,
      order: 35,
      component: () => (
        <Show when={dialogs.current() === DELETE_DIALOG && deleting()}>
          {(cwd) => <DeleteProjectDialog client={client} threads={threads} workspace={workspace} cwd={cwd()} close={() => dialogs.open(undefined)} />}
        </Show>
      ),
    });
    slots.add(ProjectActions, {
      id: "projects-page.delete",
      order: 90,
      section: true,
      danger: true,
      label: () => "Delete project…",
      icon: TrashIcon,
      run: askDelete,
    });
    slots.add(Actions, {
      id: "projects-page.open",
      order: 9,
      title: "Project settings",
      category: "Projects",
      keywords: ["folders", "directories", "settings", "manage"],
      icon: FolderIcon,
      run: () => settings.open(SECTION),
    });
  },
});
