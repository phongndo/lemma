import { createEffect, createMemo, createSignal, on } from "solid-js";
import { WorkspaceChannels } from "@lemma/contracts";
import type { WorkspaceStatus } from "@lemma/contracts";
import { load, loadJson, save } from "../lib/storage.ts";
import { branchSlug } from "../model/format.ts";
import { knownProjects, patchProjectSettings, projectName } from "../model/prefs.ts";
import type { ProjectSettings } from "../model/prefs.ts";
import { Client, Notify, Threads, Workspace } from "../ui/contracts.ts";
import type { WorktreeDraft } from "../ui/contracts.ts";
import { defineUiPlugin } from "../ui/define.ts";

const PROJECTS_KEY = "lemma.projects";
const WORKTREE_KEY = "lemma.newWorktree";
const PROJECT_SETTINGS_KEY = "lemma.projectSettings";
const HIDDEN_KEY = "lemma.hiddenProjects";

/**
 * Projects and the directory the composer works in: its git status, kept
 * fresh while connected (a turn or a command may commit or switch branches),
 * and whether a new chat starts in its own worktree.
 */
export default defineUiPlugin({
  id: "workspace",
  requires: { client: Client, notify: Notify, threads: Threads },
  provides: { workspace: Workspace },
  setup: ({ client, notify, threads }, plugin) => {
    const [added, setAdded] = createSignal<readonly string[]>(loadJson(PROJECTS_KEY, []));
    const [status, setStatus] = createSignal<WorkspaceStatus>();
    const statusOf = (path: string) => client.channel.call(WorkspaceChannels.status, { path });
    const [settings, setSettings] = createSignal<Readonly<Record<string, ProjectSettings>>>(loadJson(PROJECT_SETTINGS_KEY, {}));
    const [worktree, setWorktreeDraft] = createSignal<WorktreeDraft>({ enabled: load(WORKTREE_KEY) === "1" });
    /** Whether a new thread in `cwd` starts in a worktree: its project's setting, else the global one. */
    const worktreeDefault = (cwd: string | undefined) => (cwd === undefined ? undefined : settings()[cwd]?.worktree) ?? load(WORKTREE_KEY) === "1";

    const standaloneDir = createMemo(() => {
      const home = client.info()?.home;
      return home === undefined ? undefined : `${home.replace(/\/+$/, "")}/scratch`;
    });
    const workingDir = createMemo(() => threads.active()?.cwd ?? threads.pendingCwd() ?? standaloneDir());
    const isStandalone = (cwd: string | undefined) => cwd !== undefined && cwd === standaloneDir();
    // Removed projects stay out of the list until a thread starts in them again (or they are added again).
    const [hidden, setHidden] = createSignal<readonly string[]>(loadJson(HIDDEN_KEY, []));
    const setHiddenSaved = (next: readonly string[]) => {
      setHidden(next);
      save(HIDDEN_KEY, next.length === 0 ? undefined : JSON.stringify(next));
    };
    // One at a time: two callers would both find the folder missing and race to create it.
    let startingStandalone: Promise<void> | undefined;
    /** `onlyIfIdle`: the automatic default, which gives way if a thread was opened or a project picked meanwhile. */
    const newStandalone = (onlyIfIdle = false): Promise<void> =>
      (startingStandalone ??= (async () => {
        const dir = standaloneDir();
        if (dir === undefined) return;
        try {
          if (!(await statusOf(dir)).exists) await client.channel.call(WorkspaceChannels.createDirectory, { path: dir });
          if (!onlyIfIdle) threads.newThread(dir);
          else if (threads.activeId() === undefined && threads.pendingCwd() === undefined) threads.startIn(dir);
        } catch (error) {
          notify.report(error, "Could not start a thread without a project");
        }
      })().finally(() => {
        startingStandalone = undefined;
      }));
    const projects = createMemo(() => knownProjects(threads.list(), added(), { hidden: hidden(), standalone: standaloneDir() }));
    const setWorktreeBase = (base: string | undefined) =>
      setWorktreeDraft((draft) => (base === undefined ? { enabled: draft.enabled } : { enabled: draft.enabled, base }));

    const refresh = async () => {
      const path = workingDir();
      if (path === undefined || !client.connected()) return;
      try {
        const next = await statusOf(path);
        if (workingDir() === path) setStatus(next);
      } catch {
        /* keep the last known status */
      }
    };
    createEffect(
      on([workingDir, client.connected], () => {
        if (status()?.path !== workingDir()) {
          setStatus(undefined);
          // A base branch belongs to the project it was picked in, and each project has its own default.
          setWorktreeDraft({ enabled: worktreeDefault(workingDir()) });
        }
        void refresh();
      }),
    );
    // A turn may have committed or switched branches.
    createEffect(
      on(
        () => threads.running().length,
        () => void refresh(),
        { defer: true },
      ),
    );
    // A new thread with no project picked starts in none: the host's own directory is not a default project.
    createEffect(() => {
      if (client.connected() && standaloneDir() !== undefined && threads.activeId() === undefined && threads.pendingCwd() === undefined)
        void newStandalone(true);
    });
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    plugin.onCleanup(() => window.removeEventListener("focus", onFocus));

    const add = (path: string) => {
      if (hidden().includes(path)) setHiddenSaved(hidden().filter((project) => project !== path));
      if (added().includes(path)) return;
      const next = [...added(), path];
      setAdded(next);
      save(PROJECTS_KEY, JSON.stringify(next));
    };

    return {
      workspace: {
        projects,
        added,
        add,
        remove: (path: string) => {
          const next = added().filter((project) => project !== path);
          setAdded(next);
          save(PROJECTS_KEY, JSON.stringify(next));
          if (!hidden().includes(path)) setHiddenSaved([...hidden(), path]);
        },
        projectSettings: (cwd: string) => settings()[cwd] ?? {},
        configureProject: (cwd, patch) => {
          const next = patchProjectSettings(settings(), cwd, patch);
          setSettings(next);
          save(PROJECT_SETTINGS_KEY, Object.keys(next).length === 0 ? undefined : JSON.stringify(next));
          if (cwd === workingDir() && "worktree" in patch) setWorktreeDraft({ enabled: worktreeDefault(cwd) });
        },
        projectName: (cwd: string) => projectName(cwd, settings()[cwd]),
        standaloneDir,
        isStandalone,
        newStandalone: () => newStandalone(),
        open: async (input: string) => {
          if (input.trim() === "") return false;
          try {
            const found = await statusOf(input.trim());
            if (!found.exists) {
              notify.toast({ level: "error", message: `No folder at ${found.path} on the host` });
              return false;
            }
            add(found.path);
            threads.newThread(found.path);
            return true;
          } catch (error) {
            notify.report(error, "Could not open the folder");
            return false;
          }
        },
        workingDir,
        status,
        setStatus,
        refresh,
        worktree,
        setWorktree: (enabled: boolean) => {
          save(WORKTREE_KEY, enabled ? "1" : undefined);
          setWorktreeDraft({ enabled });
        },
        setWorktreeBase,
        newChatDir: async (text: string) => {
          const current = status();
          const draft = worktree();
          if (!draft.enabled || current?.git === undefined || current.path !== workingDir()) return undefined;
          const created = await client.channel.call(WorkspaceChannels.createWorktree, {
            path: current.path,
            branch: branchSlug(text),
            ...(draft.base === undefined ? {} : { base: draft.base }),
          });
          setWorktreeBase(undefined);
          return created.path;
        },
      },
    };
  },
});
