import type { SessionInfo, SessionMarks } from "@lemma/sessions";
import type { ThreadsService } from "@lemma/threads";
import type { LayoutService } from "@lemma/frame";
import type { WorkspaceService } from "@lemma/workspace/web";
import type { SlotsService, WebPluginsService } from "@lemma/web";
import type { Marks, NestedAgent, sections } from "./list.ts";

/** What the plugin's views draw from: the sidebar and the tab strip alike. */
export interface Deps {
  readonly threads: ThreadsService;
  readonly slots: SlotsService;
  readonly webPlugins: WebPluginsService;
  readonly layout: LayoutService;
  readonly workspace: WorkspaceService;
  readonly now: () => number;
  readonly lists: () => ReturnType<typeof sections>;
  /** Each thread's agents, and theirs, listed under it (`nestedAgents`). */
  readonly agents: () => ReadonlyMap<string, readonly NestedAgent[]>;
  readonly unread: () => ReadonlySet<string>;
  readonly runningSince: (id: string) => number | undefined;
  /** What the folder `cwd` has checked out, once asked. */
  readonly place: (cwd: string) => { readonly branch?: string | undefined; readonly project: string; readonly worktree: boolean };
  readonly archive: (session: SessionInfo) => void;
  readonly unarchive: (session: SessionInfo) => void;
  readonly pin: (session: SessionInfo, pinned: boolean) => void;
  readonly archivedAt: (id: string) => number | undefined;
  /** The new threads left mid-prompt, shown above the rest. */
  readonly drafts: () => readonly SessionInfo[];
  /** A drop's new order, and the change to the thread dropped (`dropped`). */
  readonly drop: (session: SessionInfo, marks: Marks, change: SessionMarks | undefined) => Promise<void>;
  readonly marks: () => Marks;
  /** The keys that go to a thread, while all but their last are held down (`Action.onHold`). */
  readonly shortcut: (id: string) => string | undefined;
}
