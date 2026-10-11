import type { PromptContent, QueuedPrompt, TurnOptions } from "@lemma/agent";
import type { MenuAction } from "@lemma/frame";
import type { IconName } from "@lemma/look";
import type { LedgerRecord, SessionEvent, SessionInfo, SessionMarks } from "@lemma/sessions";
import { defineSlot } from "@lemma/web";
import type { Region } from "@lemma/web";
import { Context } from "effect";
import type { Accessor, Component } from "solid-js";
import type { LiveState } from "./live.ts";
import type { ToolSummary } from "./summary.ts";
import type { ToolResultView } from "./transcript.ts";

/** The open thread's log as it reads it (`sessions.log`). */
export interface LogState {
  /** Its events so far have arrived; from here on each one appended follows. */
  readonly loaded: boolean;
  /** Why the log stopped (the session is gone, or unreadable); cleared once it reads again. */
  readonly error?: string;
}

export interface ThreadsService {
  readonly list: Accessor<readonly SessionInfo[]>;
  readonly loaded: Accessor<boolean>;
  readonly activeId: Accessor<string | undefined>;
  readonly active: Accessor<SessionInfo | undefined>;
  /** The active session's events on its current branch, oldest first. */
  readonly branch: Accessor<readonly SessionEvent[]>;
  readonly log: Accessor<LogState>;
  /** The active session's streaming drafts. */
  readonly live: Accessor<LiveState>;
  /** Threads with a turn running. */
  readonly running: Accessor<readonly string[]>;
  /** The active session has a turn running. */
  readonly busy: Accessor<boolean>;
  /** Where a new chat starts, when not in the host's directory. */
  readonly pendingCwd: Accessor<string | undefined>;
  /** Goes to a thread (keeping the view shown), or to a new one; resolves once its log has loaded. */
  readonly select: (sessionId: string | undefined) => Promise<void>;
  /** A thread's address, in `view` (a `Views` item's id) when not the first. */
  readonly href: (sessionId: string, view?: string) => string;
  /** Fetches a thread's log ahead of opening it (a link to it hovered), so it shows at once. */
  readonly preload: (sessionId: string) => void;
  /** A new thread, created by its first prompt, in `cwd` or the host's directory. */
  readonly newThread: (cwd?: string) => void;
  /** Sets where the next new thread starts without going to it (no `select`): a default, not a choice. */
  readonly startIn: (cwd: string | undefined) => void;
  readonly rename: (sessionId: string, title: string) => Promise<void>;
  /** Pins or archives it; failures are reported. */
  readonly mark: (sessionId: string, marks: SessionMarks) => Promise<void>;
  /** Deletes it for good, leaving it first if it is open; failures (a running turn) are reported. */
  readonly remove: (sessionId: string) => Promise<void>;
  /**
   * Sends a prompt, creating the session first for a new chat (in `cwd`, else the pending directory). Resolves false when
   * it was refused. While a turn runs it steers that turn or follows it (`whenBusy`, default steer). `requestId` makes it
   * exactly-once: sending again with the same id (after a lost connection) cannot place it twice.
   */
  readonly send: (
    content: PromptContent,
    options?: {
      readonly turn?: TurnOptions | undefined;
      readonly cwd?: string | undefined;
      readonly requestId?: string | undefined;
      readonly whenBusy?: "steer" | "follow-up" | undefined;
    },
  ) => Promise<boolean>;
  /** The active thread's queue: prompts sent while a turn ran, waiting to steer it or to follow it. */
  readonly queue: Accessor<readonly QueuedPrompt[]>;
  /**
   * The active thread's last prompt that a plugin answered instead of placing it (`AgentInputHook`): handled (and
   * what it said it did) or refused (and why), and by which plugin. Until the next is sent, or it is dismissed.
   */
  readonly answer: Accessor<PromptAnswer | undefined>;
  readonly dismissAnswer: () => void;
  /** Takes a prompt out of the active thread's queue. */
  readonly withdraw: (requestId: string) => Promise<void>;
  readonly cancel: () => void;
  /** Moves the active session's leaf: the next prompt branches from `eventId`. */
  readonly checkout: (eventId: string) => Promise<void>;
}

export class Threads extends Context.Service<Threads, ThreadsService>()("lemma-web/Threads") {}

/** A prompt a plugin answered instead of placing it (see `ThreadsService.answer`). */
export interface PromptAnswer {
  readonly sessionId: string;
  readonly kind: "handled" | "refused";
  /** The plugin. */
  readonly by: string;
  /** What it did, or why it refused; may be empty for one it handled. */
  readonly message: string;
}

/** What a session's menu item can do to its row. */
export interface ThreadRowControl {
  /** Edits the title in place. */
  readonly rename: () => void;
}

/** An item in a session's menu in the sidebar (its row's ⋯ button, or a right-click). Rename, pin, archive, and delete are the sidebar's defaults. */
export type ThreadAction = MenuAction<SessionInfo, ThreadRowControl>;

export const ThreadActions = defineSlot<ThreadAction>("thread.actions");

export interface ThreadView {
  readonly title: string;
  readonly icon: Component;
  readonly component: Component;
  /** The composer shows under it. */
  readonly composer?: boolean;
}

/** The main area's views of a thread over the same log: the transcript (order 0), the trajectory (10). The first by order is where a new thread opens. */
export const Views = defineSlot<ThreadView>("views");

export const ComposerRegion = defineSlot<Region>("composer", { shows: "first" });

/** What a composer button can do to the prompt being written. */
export interface ComposerActionProps {
  /** Attaches images (other files are refused with a notice). */
  readonly addFiles: (files: Iterable<File>) => Promise<void>;
  /** Inserts text at the cursor. */
  readonly insert: (text: string) => void;
}

/** Buttons beside send: attaching images is the default one. */
export const ComposerActions = defineSlot<Region<ComposerActionProps>>("composer.actions");

/** Something the composer offers to put in place of the word being typed. */
export interface ComposerSuggestion {
  /** Unique within its source. */
  readonly key: string;
  readonly label: string;
  /** Muted after the label: a file's folder. */
  readonly detail?: string | undefined;
  readonly icon?: Component | undefined;
  /** Indices into `label`, and into `detail`, that the query matched, for highlighting. */
  readonly matches?: readonly number[] | undefined;
  readonly detailMatches?: readonly number[] | undefined;
  /** Replaces the trigger and the word (`@src/app.ts`); a space follows unless one is there. */
  readonly insert: string;
  /** The start of a longer word (a directory, to look inside): no space follows, and completing goes on. */
  readonly partial?: boolean | undefined;
}

/** What a completion source answers: its suggestions, and optionally a line to show under them (`Still reading…`). */
export type ComposerCompletionAnswer =
  | readonly ComposerSuggestion[]
  | { readonly suggestions: readonly ComposerSuggestion[]; readonly note?: string | undefined };

/**
 * A source of completions: while the word at the cursor starts with its
 * `trigger` (at the start of the prompt or after whitespace; `@"…"` quotes a
 * word with spaces), the composer shows a menu of what every source with that
 * trigger suggests, in slot order, and picking one replaces the word. Arrow
 * keys move, Enter or Tab picks, Escape closes it until the cursor leaves the
 * word. File mentions (`@`) are the bundled source; a plugin adds its own
 * trigger (`#` for threads) or more suggestions for `@`.
 */
export interface ComposerCompletion {
  /** What starts a word to complete: `@`, `#`, `$`. */
  readonly trigger: string;
  /** What it suggests (`Files`): the menu's heading for its group when several sources answer. */
  readonly label: string;
  /**
   * Suggestions for what follows the trigger (`query`, possibly empty; a
   * quoted word's text inside the quotes), best first. Called again whenever
   * the word changes, and whenever a reactive value it read before its first
   * `await` changes (the project, the connection): read those first. `signal`
   * aborts once its answer is no longer wanted, so a source asking the host
   * can wait a moment and ask once. A rejection's message shows in the menu.
   */
  readonly suggest: (query: string, context: { readonly signal: AbortSignal }) => ComposerCompletionAnswer | Promise<ComposerCompletionAnswer>;
}

export const ComposerCompletions = defineSlot<ComposerCompletion>("composer.completions");

/** An item in the session's header bar, at its start (after the sidebar toggle) or its end. */
export interface ThreadHeaderItem extends Region {
  readonly side: "start" | "end";
}

/** The session's header: the sidebar toggle, title, running chip, and view tabs are its default items. */
export const ThreadHeader = defineSlot<ThreadHeaderItem>("thread.header");

/** Above the composer box: the connection notice, the provider callout. */
export const ComposerNotices = defineSlot<Region>("composer.notices");

/** The composer's toolbar, left of its buttons: the model and reasoning pickers. */
export const ComposerControls = defineSlot<Region>("composer.controls");

/** Under the composer: the workspace bar. */
export const ComposerFooter = defineSlot<Region>("composer.footer");

export interface ToolBodyProps {
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown> | undefined;
  readonly result: ToolResultView | undefined;
  readonly state: "running" | "queued" | "ok" | "error" | "interrupted";
  /** The last lines a running tool printed, until its result arrives. */
  readonly output?: string | undefined;
}

/**
 * How the chat and the trajectory show calls to one tool; the item's id is the tool's name. A tool's plugin adds its
 * own from its web half, as the bundled tools do. What a view leaves out is the chat's own: the call named, with a
 * generic icon, its first short string argument, and when opened its arguments and output.
 */
export interface ToolView {
  /** The kind of thing a call does, beside its line. A call with an icon and a summary is not also named. */
  readonly icon?: IconName;
  /** A call's arguments in a line. */
  readonly summary?: (args: Record<string, unknown> | undefined, context: { readonly cwd?: string; readonly home?: string }) => ToolSummary;
  /** The string argument shown while a call's arguments stream in, before they parse (`command`, `path`). */
  readonly streaming?: string;
  /**
   * What calls to it did, past tense, for one and for many (`["ran", "command", "commands"]`), when the chat sums up a
   * run of calls ("Ran 3 commands and changed 1 file"). Calls whose words are the same are counted together.
   */
  readonly action?: readonly [verb: string, one: string, many: string];
  /** A call opened, in the chat and the trajectory. */
  readonly body?: Component<ToolBodyProps>;
}

export const ToolViews = defineSlot<ToolView>("chat.tools");

/** An inspector tab in the trajectory view, for the records `when` picks. */
export interface TrajectoryTab {
  readonly label: string;
  readonly when: (record: LedgerRecord) => boolean;
  readonly component: Component<{ readonly record: LedgerRecord }>;
}

/** Tabs added after the trajectory view's own for a selected record. A tool's `ToolViews` body is one already. */
export const TrajectoryTabs = defineSlot<TrajectoryTab>("trajectory.tabs");

/** An item in a trajectory record's context menu, after the view's own. */
export interface TrajectoryAction {
  readonly label: string;
  readonly when?: (record: LedgerRecord) => boolean;
  readonly run: (record: LedgerRecord) => void;
}

export const TrajectoryActions = defineSlot<TrajectoryAction>("trajectory.actions");

/** Actions other plugins run by id (`slots.get(Actions, id)?.run()`), so a replacement keeps the id and what calls it keeps working. */
export const ThreadsActionIds = { focusComposer: "composer.focus" } as const;
