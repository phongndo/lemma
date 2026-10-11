import type { MenuAction } from "@lemma/frame";
import { defineSlot } from "@lemma/web";
import type { Region } from "@lemma/web";
import type { WorkspaceStatus } from "../workspace.ts";
import { Context } from "effect";
import type { Accessor } from "solid-js";
import type { ProjectSettings } from "./projects.ts";

export interface WorktreeDraft {
  readonly enabled: boolean;
  /** The branch a new worktree starts from; the current one when unset. */
  readonly base?: string;
}

/**
 * Projects and the directory the composer works in. The host's directories,
 * branches, and worktrees themselves are `WorkspaceChannels`, which any plugin
 * calls through `Client`.
 */
export interface WorkspaceService {
  /** Folders with threads, most recently used first, then ones added by hand; never `standaloneDir`. */
  readonly projects: Accessor<readonly string[]>;
  /** Added by hand (remembered), so they are offered before they have threads. */
  readonly added: Accessor<readonly string[]>;
  readonly add: (path: string) => void;
  /** Stops listing a project until a thread starts in it or it is added again. */
  readonly remove: (path: string) => void;
  /** A project's settings (remembered in this browser); fields absent follow the defaults. */
  readonly projectSettings: (cwd: string) => ProjectSettings;
  /** Changes some of them; an undefined field, or a blank name, returns to the default. */
  readonly configureProject: (cwd: string, patch: { readonly [K in keyof ProjectSettings]?: ProjectSettings[K] | undefined }) => void;
  /** What to call a project: its name setting, else its folder's name. */
  readonly projectName: (cwd: string) => string;
  /** Where threads with no project run: a folder of the host's own (`<home>/scratch`), never listed among `projects`. */
  readonly standaloneDir: Accessor<string | undefined>;
  readonly isStandalone: (cwd: string | undefined) => boolean;
  /** Starts a thread with no project, making its folder on the host first if needed. */
  readonly newStandalone: () => Promise<void>;
  /** Starts a new chat in the folder at `input` (`~` allowed) once the host confirms it exists. */
  readonly open: (input: string) => Promise<boolean>;
  /** Where the composer works: the active session's directory, else the new chat's, else `standaloneDir`. */
  readonly workingDir: Accessor<string | undefined>;
  /** The working directory's status, kept fresh while connected. */
  readonly status: Accessor<WorkspaceStatus | undefined>;
  readonly setStatus: (status: WorkspaceStatus) => void;
  readonly refresh: () => Promise<void>;
  /** For a new thread in a git repository: whether it starts in a fresh worktree (the project's setting, else the remembered global one), and from which branch. */
  readonly worktree: Accessor<WorktreeDraft>;
  readonly setWorktree: (enabled: boolean) => void;
  readonly setWorktreeBase: (base: string | undefined) => void;
  /** Where a new chat's session goes: a fresh worktree named from `text` when one is chosen, else undefined. Throws when git refuses. */
  readonly newChatDir: (text: string) => Promise<string | undefined>;
}

export class Workspace extends Context.Service<Workspace, WorkspaceService>()("lemma-web/Workspace") {}

/** An item in a project's menu in the sidebar, by the project's directory. New thread and copy path are the sidebar's defaults; project settings and delete, the projects page's. */
export type ProjectAction = MenuAction<string>;

export const ProjectActions = defineSlot<ProjectAction>("project.actions");

/** An item in the workspace bar under the composer, at its start or end. The project, mode, and branch pickers are its defaults. */
export interface WorkspaceBarItem extends Region {
  readonly side: "start" | "end";
}

export const WorkspaceBarItems = defineSlot<WorkspaceBarItem>("workspace-bar.items");

/** Actions other plugins run by id (`slots.get(Actions, id)?.run()`), so a replacement keeps the id and what calls it keeps working. */
export const WorkspaceActionIds = { addProject: "add-project.open" } as const;
