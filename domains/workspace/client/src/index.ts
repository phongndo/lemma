import { createEffect, createMemo, createSignal, on, untrack } from "solid-js";
import { WorkspaceChannels } from "@lemma/workspace";
import type { Place, WorkspaceStatus } from "@lemma/workspace";
import { load, loadJson, loadStrings, recordOf, save } from "@lemma/web/storage";
import { branchSlug } from "./slug.ts";
import { knownProjects, patchProjectSettings, projectName, Workspace, WORKSPACE_CONTRACT } from "@lemma/workspace/web";
import type { ProjectSettings, WorktreeDraft } from "@lemma/workspace/web";
import { Threads } from "@lemma/threads";
import { Client, Notify, defineWebPlugin } from "@lemma/web";

const PROJECTS_KEY = "lemma.projects";
const WORKTREE_KEY = "lemma.newWorktree";
const FROM_REMOTE_KEY = "lemma.worktreeFromRemote";
const PROJECT_SETTINGS_KEY = "lemma.projectSettings";
const HIDDEN_KEY = "lemma.hiddenProjects";
/** How long the host may take to remove a worktree, or make it again, after its thread is archived or unarchived. */
const WORKTREE_SETTLES = 1_500;

/**
 * Projects and the directory the composer works in: its git status, kept
 * fresh while connected (a turn or a command may commit or switch branches),
 * and whether a new chat starts in its own worktree.
 */
/** What a project's stored settings may hold: a name, and whether it starts threads in worktrees. */
const isProjectSettings = (value: unknown): value is ProjectSettings =>
  typeof value === "object" &&
  value !== null &&
  (!("name" in value) || typeof value.name === "string") &&
  (!("worktree" in value) || typeof value.worktree === "boolean");

export default defineWebPlugin({
  id: "workspace.client",
  implements: [WORKSPACE_CONTRACT],
  requires: { client: Client, notify: Notify, threads: Threads },
  provides: { workspace: Workspace },
  setup: ({ client, notify, threads }, plugin) => {
    const [added, setAdded] = createSignal<readonly string[]>(loadStrings(PROJECTS_KEY));
    const [status, setStatus] = createSignal<WorkspaceStatus>();
    const statusOf = (path: string) => client.channel.call(WorkspaceChannels.status, { path });
    const [settings, setSettings] = createSignal<Readonly<Record<string, ProjectSettings>>>(loadJson(PROJECT_SETTINGS_KEY, {}, recordOf(isProjectSettings)));
    const [worktree, setWorktreeDraft] = createSignal<WorktreeDraft>({ enabled: load(WORKTREE_KEY) === "1" });
    const [fromRemote, setFromRemote] = createSignal(load(FROM_REMOTE_KEY) === "1");

    // Where each thread's folder, and each folder added by hand, sits: asked for all those not yet asked about at once,
    // and again for one where a turn ended (it may have switched branches) or that `refreshPlaces` names.
    const [places, setPlaces] = createSignal<Readonly<Record<string, Place>>>({});
    /** Folders the host could not place (the call failed, or a replacement serves none): each its own project meanwhile. */
    const [unplaced, setUnplaced] = createSignal<ReadonlySet<string>>(new Set());
    const asked = new Set<string>();
    /** Each folder's latest request, so an answer to an older one that arrives after a newer one is dropped. */
    const latest = new Map<string, number>();
    let requests = 0;
    const refreshPlaces = async (paths: readonly string[]): Promise<void> => {
      if (paths.length === 0 || !client.connected()) return;
      const request = ++requests;
      for (const path of paths) {
        asked.add(path);
        latest.set(path, request);
      }
      try {
        const found = await client.channel.call(WorkspaceChannels.places, { paths: [...paths] });
        const fresh = found.flatMap((place, index) => (latest.get(paths[index]!) === request ? [[paths[index]!, place] as const] : []));
        if (fresh.length === 0) return;
        setPlaces((known) => ({ ...known, ...Object.fromEntries(fresh) }));
        if (fresh.some(([path]) => unplaced().has(path))) setUnplaced(new Set([...unplaced()].filter((path) => !fresh.some(([placed]) => placed === path))));
      } catch {
        // Each its own project until asked again: when the connection comes back, or a turn there ends. Not with each
        // change to the threads, which a turn makes with every event.
        const failed = paths.filter((path) => latest.get(path) === request);
        if (failed.length > 0) setUnplaced(new Set([...unplaced(), ...failed]));
      }
    };
    let wasConnected = false;
    createEffect(() => {
      const connected = client.connected();
      if (connected && !wasConnected) for (const path of untrack(unplaced)) asked.delete(path);
      wasConnected = connected;
      if (!connected) return;
      const unasked = [...new Set([...threads.list().map((session) => session.cwd), ...added()])].filter((cwd) => !asked.has(cwd));
      void refreshPlaces(unasked);
    });
    createEffect(
      on(threads.running, (running, before) => {
        const ended = (before ?? []).filter((id) => !running.includes(id));
        const cwds = ended.flatMap((id) => threads.list().find((session) => session.id === id)?.cwd ?? []);
        void refreshPlaces([...new Set(cwds)]);
      }),
    );
    const place = (cwd: string): Place | undefined => places()[cwd];
    const projectOf = (cwd: string): string => places()[cwd]?.project ?? cwd;
    /** The project a folder belongs to once known: undefined while it waits for the host to place it. */
    const placedProject = (cwd: string): string | undefined => places()[cwd]?.project ?? (unplaced().has(cwd) ? cwd : undefined);

    /** Whether a new thread in `cwd` starts in a worktree: its project's setting, else the global one. */
    const worktreeDefault = (cwd: string | undefined) => (cwd === undefined ? undefined : settings()[projectOf(cwd)]?.worktree) ?? load(WORKTREE_KEY) === "1";

    const standaloneDir = createMemo(() => {
      const home = client.info()?.home;
      return home === undefined ? undefined : `${home.replace(/\/+$/, "")}/scratch`;
    });
    const workingDir = createMemo(() => threads.active()?.cwd ?? threads.pendingCwd() ?? standaloneDir());
    const project = createMemo(() => {
      const dir = workingDir();
      return dir === undefined ? undefined : projectOf(dir);
    });
    const isStandalone = (cwd: string | undefined) => cwd !== undefined && cwd === standaloneDir();
    // Removed projects stay out of the list until a thread starts in them again (or they are added again).
    const [hidden, setHidden] = createSignal<readonly string[]>(loadStrings(HIDDEN_KEY));
    const setHiddenSaved = (next: readonly string[]) => {
      setHidden(next);
      save(HIDDEN_KEY, next.length === 0 ? undefined : JSON.stringify(next));
    };
    // A new thread starts in the project of the one shown, not in its worktree: another task there starts afresh. Not in
    // one just removed (its threads deleted with it), where a new thread would bring it back.
    createEffect(() => {
      const shown = threads.active();
      if (shown === undefined) return;
      const home = projectOf(shown.cwd);
      if (!hidden().includes(home)) threads.startIn(home);
    });
    // One at a time: two callers would both find the folder missing and race to create it.
    let startingStandalone: Promise<void> | undefined;
    /** `onlyIfIdle`: the automatic default, which gives way if a thread was opened or a project picked meanwhile. */
    const newStandalone = (onlyIfIdle = false): Promise<void> =>
      (startingStandalone ??= (async () => {
        const dir = standaloneDir();
        if (dir === undefined) return;
        try {
          if (!(await statusOf(dir)).exists) await client.channel.call(WorkspaceChannels.createDirectory, { path: dir });
          if (!onlyIfIdle) await threads.newThread(dir, { inPlace: true });
          else if (threads.activeId() === undefined && threads.pendingCwd() === undefined) threads.startIn(dir);
        } catch (error) {
          notify.report(error, "Could not start a thread without a project");
        }
      })().finally(() => {
        startingStandalone = undefined;
      }));
    const projects = createMemo(() => knownProjects(threads.list(), added(), { hidden: hidden(), standalone: standaloneDir(), projectOf: placedProject }));
    /** A new thread here starts in a new worktree: the draft on, in a checkout that is not a worktree already. */
    const newWorktree = () => {
      const git = status()?.git;
      return worktree().enabled && git !== undefined && git.worktreeOf === undefined && !isStandalone(workingDir());
    };
    const setWorktreeBase = (base: string | undefined) =>
      setWorktreeDraft((draft) => (base === undefined ? { enabled: draft.enabled } : { enabled: draft.enabled, base }));

    const refresh = async () => {
      const path = workingDir();
      if (path === undefined || !client.connected()) return;
      // Where it sits too: the host may have removed its worktree (its thread archived) or made it again.
      void refreshPlaces([path]);
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
    plugin.listen(window, "focus", refresh);
    // The shown thread archived or unarchived: the host may remove its worktree or make it again (workspace.tidy), a
    // moment after. Asked now, and once more when it has had time.
    createEffect(
      on(
        () => threads.active()?.archived === true,
        () => {
          void refresh();
          plugin.after(WORKTREE_SETTLES, () => void refresh(), { name: "ask again where the thread works" });
        },
        { defer: true },
      ),
    );

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
          // Also a folder added by hand that is in it (one added before folders were placed: a worktree of it, say).
          const next = added().filter((folder) => folder !== path && projectOf(folder) !== path);
          setAdded(next);
          save(PROJECTS_KEY, JSON.stringify(next));
          if (!hidden().includes(path)) setHiddenSaved([...hidden(), path]);
          // Not where the next new thread starts, either: that would bring it back.
          const pending = threads.pendingCwd();
          if (pending !== undefined && projectOf(pending) === path) threads.startIn(undefined);
        },
        projectSettings: (cwd: string) => settings()[projectOf(cwd)] ?? {},
        configureProject: (cwd, patch) => {
          const next = patchProjectSettings(settings(), projectOf(cwd), patch);
          setSettings(next);
          save(PROJECT_SETTINGS_KEY, Object.keys(next).length === 0 ? undefined : JSON.stringify(next));
          if (projectOf(cwd) === project() && "worktree" in patch) setWorktreeDraft({ enabled: worktreeDefault(workingDir()) });
        },
        projectName: (cwd: string) => projectName(projectOf(cwd), settings()[projectOf(cwd)]),
        place,
        projectOf,
        refreshPlaces,
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
            // Its project is what is added: a worktree of a repository opened here is a place in that repository's.
            await refreshPlaces([found.path]);
            add(projectOf(found.path));
            await threads.newThread(found.path, { inPlace: true });
            return true;
          } catch (error) {
            notify.report(error, "Could not open the folder");
            return false;
          }
        },
        workingDir,
        project,
        status,
        setStatus,
        refresh,
        worktree,
        newWorktree,
        setWorktree: (enabled: boolean) => {
          save(WORKTREE_KEY, enabled ? "1" : undefined);
          setWorktreeDraft({ enabled });
        },
        setWorktreeBase,
        fromRemote,
        setFromRemote: (on: boolean) => {
          save(FROM_REMOTE_KEY, on ? "1" : undefined);
          setFromRemote(on);
        },
        newChatDir: async (text: string) => {
          const current = status();
          const draft = worktree();
          if (!newWorktree() || current === undefined || current.path !== workingDir()) return undefined;
          const created = await client.channel.call(WorkspaceChannels.createWorktree, {
            path: current.path,
            branch: branchSlug(text),
            ...(draft.base === undefined ? {} : { base: draft.base }),
            ...(fromRemote() ? { fromRemote: true } : {}),
          });
          setWorktreeBase(undefined);
          // The thread works in the same folder of the worktree as it would in the project (a package of a monorepo, its
          // package), placed by the host before it moves there, so it is filed under its project from its first moment.
          const main = created.git?.worktreeOf;
          const project = projectOf(current.path);
          const inside = main === undefined || !project.startsWith(`${main}/`) ? "" : project.slice(main.length + 1);
          const dir = inside === "" ? created.path : `${created.path}/${inside}`;
          await refreshPlaces(inside === "" ? [dir] : [dir, created.path]);
          // A folder the new branch does not have (one git does not track) leaves the worktree's root.
          return place(dir)?.exists === false ? created.path : dir;
        },
      },
    };
  },
});
