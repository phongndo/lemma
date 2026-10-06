import { For, Show, createEffect, createMemo, createSignal, on } from "solid-js";
import type { JSX } from "solid-js";
import type { SessionInfo } from "@lemma/contracts";
import { copyText } from "../lib/clipboard.ts";
import { tildePath } from "../model/format.ts";
import { folderName } from "../model/prefs.ts";
import {
  ActionIds,
  Actions,
  Client,
  Dialogs,
  Layers,
  Notify,
  ProjectActions,
  Threads,
  Settings,
  SettingsGroups,
  SettingsSections,
  Slots,
  Workspace,
} from "../ui/contracts.ts";
import type { ClientService, ThreadsService, WorkspaceService } from "../ui/contracts.ts";
import { defineUiPlugin } from "../ui/define.ts";
import { CheckIcon, ChevronDownIcon, CopyIcon, Dialog, FolderIcon, FolderPlusIcon, GearIcon, Popover, Segmented, SettingRow, TrashIcon } from "../ui/parts.tsx";
import styles from "./projects-page.css?inline";

const SECTION = "projects";
const DELETE_DIALOG = "projects-page.delete";

const threadCount = (n: number) => `${n} thread${n === 1 ? "" : "s"}`;

/** A project's threads, archived ones included. */
const threadsIn = (threads: ThreadsService, cwd: string): SessionInfo[] => threads.list().filter((session) => session.cwd === cwd);

/** Asks before deleting a project's threads, saying what goes and what stays. */
function DeleteProjectDialog(props: { client: ClientService; threads: ThreadsService; workspace: WorkspaceService; cwd: string; close: () => void }) {
  const { threads, workspace } = props;
  const inProject = () => threadsIn(threads, props.cwd);
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
      <p class="dialog-detail muted">The project's files on disk are not touched.</p>
      <Show when={running() > 0}>
        <p class="dialog-detail delete-project-running">
          {threadCount(running())} still running {running() === 1 ? "is" : "are"} kept; stop {running() === 1 ? "it" : "them"} to delete the project.
        </p>
      </Show>
    </Dialog>
  );
}

/** Settings for one project at a time: its name, where it is, how new threads start there, and removing it. */
export default defineUiPlugin({
  id: "projects-page",
  styles,
  requires: { client: Client, threads: Threads, workspace: Workspace, settings: Settings, dialogs: Dialogs, notify: Notify, slots: Slots },
  setup: ({ client, threads, workspace, settings, dialogs, notify, slots }) => {
    /** The project chosen, in the address (`?project=<directory>`). */
    const chosen = () => (settings.section() === SECTION ? settings.params().project : undefined);
    const setChosen = (cwd: string) => settings.setParams({ project: cwd });
    /** The project the page shows: the one chosen, while it exists, else the first. */
    const current = createMemo(() => {
      const pick = chosen();
      return pick !== undefined && workspace.projects().includes(pick) ? pick : workspace.projects()[0];
    });
    // Opening the section without a project in mind shows the one being worked in.
    createEffect(
      on(settings.section, (section, previous) => {
        const here = workspace.workingDir();
        if (section === SECTION && previous !== SECTION && chosen() === undefined && here !== undefined && !workspace.isStandalone(here)) setChosen(here);
      }),
    );
    const [deleting, setDeleting] = createSignal<string | undefined>();
    const askDelete = (cwd: string) => {
      setDeleting(cwd);
      dialogs.open(DELETE_DIALOG);
    };
    const path = (cwd: string) => tildePath(cwd, client.info()?.home);

    const picker = () => (
      <Show when={current()}>
        {(cwd) => (
          <div class="settings-rows project-picker-row">
            <SettingRow title="Project" description="The project these settings apply to.">
              <Popover
                label="Choose a project"
                tip={path(cwd())}
                trigger={
                  <>
                    <span class="project-picker-label">{workspace.projectName(cwd())}</span>
                    <ChevronDownIcon />
                  </>
                }
                triggerClass="button small project-picker"
                placement="bottom-end"
              >
                {(close) => (
                  <For each={workspace.projects()}>
                    {(project) => (
                      <button
                        class="menu-item"
                        role="menuitemradio"
                        aria-checked={project === cwd()}
                        onClick={() => {
                          setChosen(project);
                          close();
                        }}
                      >
                        <span class="menu-check">
                          <Show when={project === cwd()}>
                            <CheckIcon />
                          </Show>
                        </span>
                        <span class="menu-label">{workspace.projectName(project)}</span>
                        <span class="menu-hint">{path(project)}</span>
                      </button>
                    )}
                  </For>
                )}
              </Popover>
            </SettingRow>
          </div>
        )}
      </Show>
    );

    slots.add(SettingsSections, {
      id: SECTION,
      order: 40,
      title: "Projects",
      icon: FolderIcon,
      intro: picker,
      actions: () => (
        <Show when={slots.get(Actions, ActionIds.addProject)}>
          {(action) => (
            <button class="button small" onClick={() => action().run()}>
              <FolderPlusIcon /> Add project
            </button>
          )}
        </Show>
      ),
      empty: () => <p class="settings-empty">No projects yet. Add one to start threads in it.</p>,
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

    group("projects-page.general", 0, undefined, (cwd) => [
      {
        text: `project name rename ${workspace.projectName(cwd)}`,
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
                }}
                onBlur={() => workspace.configureProject(cwd, { name: input.value })}
              />
            </SettingRow>
          );
        },
      },
      {
        text: `project location path folder directory ${cwd}`,
        view: () => (
          <SettingRow title="Location" description={cwd === client.info()?.cwd ? "The host's own directory." : "The folder on the host that threads work in."}>
            <div class="project-location">
              <code>{path(cwd)}</code>
              <button
                class="icon-button"
                aria-label="Copy path"
                data-tip="Copy path"
                onClick={() =>
                  void copyText(cwd).then((copied) =>
                    notify.toast(copied ? { level: "info", message: "Path copied" } : { level: "error", message: "Could not copy" }),
                  )
                }
              >
                <CopyIcon />
              </button>
            </div>
          </SettingRow>
        ),
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
              description="In a git repository, gives each new thread its own branch. Default follows General › New threads."
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

    group("projects-page.danger", 20, "Danger zone", (cwd) => [
      {
        text: "project delete remove forget threads",
        view: () => {
          const count = () => threadsIn(threads, cwd).length;
          return (
            <SettingRow
              title="Delete project"
              description={
                count() === 0
                  ? "Removes it from your projects. Files on disk are not touched."
                  : `Deletes its ${threadCount(count())} for good, archived ones included, and removes it from your projects. Files on disk are not touched.`
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
