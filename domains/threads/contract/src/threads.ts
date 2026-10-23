import type { PromptContent, QueuedPrompt, TurnOptions } from "@lemma/agent";
import type { ImageContent, TextContent } from "@lemma/llm";
import type { MenuAction } from "@lemma/frame";
import type { IconName } from "@lemma/look";
import type { LedgerRecord, SessionEvent, SessionInfo, SessionMarks } from "@lemma/sessions";
import { defineSlot } from "@lemma/web";
import type { Region } from "@lemma/web";
import { Context } from "effect";
import type { Accessor, Component } from "solid-js";
import type { ThreadAttention } from "./attention.ts";
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
  /**
   * What each thread asks of the person now (`ThreadAttention`), by id; a thread at rest is absent. It waits on them
   * (`ThreadWaits`), a turn runs in it, or a turn ended (done, failed, out of steps) and they have not looked since: one
   * that ends while its thread is shown in a window they are looking at is seen at once, and one that ends otherwise is
   * seen once its thread shows in such a window. Unseen ends are kept in this browser, so they last a reload, and one
   * seen in another tab is seen here too. A turn the person cancelled leaves nothing to see.
   */
  readonly attention: Accessor<ReadonlyMap<string, ThreadAttention>>;
  /** Marks a thread's finished turn seen, or with no id every thread's: what showing a thread does for its own. */
  readonly markSeen: (sessionId?: string) => void;
  /** Nothing has gone into the thread shown yet (`isBlank`), or no thread is shown: what is sent next starts it. */
  readonly blank: Accessor<boolean>;
  /**
   * Where a new thread starts when nothing else says, rather than in the shown thread's directory or the host's: a
   * plugin keeps it (`startIn`), as the workspace keeps it at the shown thread's project.
   */
  readonly pendingCwd: Accessor<string | undefined>;
  /**
   * The prompts written in threads and not yet sent, by thread id: what the composer holds for each (it writes them,
   * `setDraft`), so a list can show a new thread left mid-prompt as a draft. Their text is kept in this browser, and
   * comes back after a reload, and another tab's arrive as it saves them; their images last while the page does. A
   * thread's goes with it when it is deleted.
   */
  readonly drafts: Accessor<ReadonlyMap<string, ThreadDraft>>;
  /** Keeps a thread's unsent prompt (`drafts`); one with no text and no images, or none, drops it. */
  readonly setDraft: (sessionId: string, draft: ThreadDraft | undefined) => void;
  /**
   * Goes to a thread, as it was left, or to the new-thread page, which shows a blank thread: the newest there is,
   * else a new one in `pendingCwd` once there is one. Resolves once its log has loaded.
   */
  readonly select: (sessionId: string | undefined) => Promise<void>;
  /** A thread's address; with `view` (a `Views` item's id, not the first), one that opens that view in its pane. */
  readonly href: (sessionId: string, view?: string) => string;
  /** Fetches a thread's log ahead of opening it (a link to it hovered), so it shows at once. */
  readonly preload: (sessionId: string) => void;
  /**
   * Creates an empty thread, as a browser opens a tab, in `cwd` (else `pendingCwd`, else the shown thread's directory,
   * else the host's) and goes to it; one made here in `cwd` with nothing sent or written yet (no `drafts` entry) is
   * gone to instead. `inPlace`: while the shown thread is blank and made here, it moves to `cwd` instead
   * (`sessions.relocate`), keeping its id. A blank thread made here and left with nothing written in it is deleted.
   */
  readonly newThread: (cwd?: string, options?: { readonly inPlace?: boolean }) => Promise<void>;
  /** Sets where a new thread starts when nothing else says (`pendingCwd`). */
  readonly startIn: (cwd: string | undefined) => void;
  readonly rename: (sessionId: string, title: string) => Promise<void>;
  /** Pins or archives it; failures are reported. */
  readonly mark: (sessionId: string, marks: SessionMarks) => Promise<void>;
  /** Deletes it for good, leaving it first if it is open; failures (a running turn) are reported. */
  readonly remove: (sessionId: string) => Promise<void>;
  /**
   * Sends a prompt to the shown thread: when none is shown, to one it creates (in `cwd`, else `pendingCwd`), and when
   * a blank one is in another directory than `cwd`, to it once moved there (`sessions.relocate`; one made in another
   * window stays, and a new thread there takes the prompt). With `background`, it goes to a new thread instead (in
   * `cwd`, else the shown thread's directory), which is not gone to.
   * Resolves false when it was refused. While a turn runs it steers that turn or follows it (`whenBusy`, default steer).
   * `requestId` makes it exactly-once: sending again with the same id (after a lost connection) cannot place it twice.
   */
  readonly send: (
    content: PromptContent,
    options?: {
      readonly turn?: TurnOptions | undefined;
      readonly cwd?: string | undefined;
      readonly requestId?: string | undefined;
      readonly whenBusy?: "steer" | "follow-up" | undefined;
      readonly background?: boolean | undefined;
    },
  ) => Promise<boolean>;
  /**
   * The active thread's prompts waiting to be placed: sent while a turn ran, to steer it or to follow it, in the
   * agent's order. The log is the truth: a prompt it has placed is not here, and one that just left the agent's queue
   * stays until the log shows it (`waitingPrompts`), as the two reach the page apart. A prompt keeps its object while
   * it waits. `queuePlaces` splits it between the conversation and the composer.
   */
  readonly queue: Accessor<readonly QueuedPrompt[]>;
  /**
   * The active thread's last prompt that a plugin answered instead of placing it (`AgentInputHook`): handled (and
   * what it said it did) or refused (and why), and by which plugin; with no thread shown, the new-thread page's. Until
   * the next is sent, or it is dismissed.
   */
  readonly answer: Accessor<PromptAnswer | undefined>;
  readonly dismissAnswer: () => void;
  /** Takes a prompt out of the active thread's queue. */
  readonly withdraw: (requestId: string) => Promise<void>;
  /** Makes a follow-up in the active thread's queue a steer: the running turn places it after its current step. */
  readonly promote: (requestId: string) => Promise<void>;
  readonly cancel: () => void;
  /** Moves the active session's leaf: the next prompt branches from `eventId`. Resolves whether it moved; a failure is reported. */
  readonly checkout: (eventId: string) => Promise<boolean>;
  /**
   * Copies the active thread's branch up to `eventId` (its leaf when absent) into a new thread (`sessions.fork`), and
   * goes to it: how a thread whose log is damaged (`SessionInfo.damaged`) goes on. Failures are reported.
   */
  readonly fork: (eventId?: string) => Promise<void>;
}

export class Threads extends Context.Service<Threads, ThreadsService>()("lemma-web/Threads") {}

/** A prompt written in a thread and not yet sent (see `ThreadsService.drafts`). */
export interface ThreadDraft {
  readonly text: string;
  readonly images: readonly ImageContent[];
}

/** Holds something to send: text other than whitespace, or an image. What counts as a draft (`Threads.drafts`). */
export const written = (prompt: { readonly text: string; readonly images: readonly unknown[] } | undefined): boolean =>
  prompt !== undefined && (prompt.text.trim() !== "" || prompt.images.length > 0);

/**
 * What a plugin keeps for a thread with nothing sent in it yet (the inspection pane's tabs, a browser page in one):
 * `holds` says whether it keeps something for the thread now; reactive. While anything holds a blank thread made here
 * (or it has a draft), leaving it does not delete it, and it is kept on the host (`SessionMarks.kept`), which deletes
 * empty sessions left a while otherwise.
 */
export interface ThreadHold {
  readonly holds: (sessionId: string) => boolean;
}

export const ThreadHolds = defineSlot<ThreadHold>("thread.holds");

/** A prompt a plugin answered instead of placing it (see `ThreadsService.answer`). */
export interface PromptAnswer {
  /** The thread it was written in; `""` for the new-thread page with no thread shown. */
  readonly sessionId: string;
  readonly kind: "handled" | "refused";
  /** The plugin. */
  readonly by: string;
  /** What it did, or why it refused; may be empty for one it handled. */
  readonly message: string;
}

/**
 * Threads waiting on the person: the agent's questions (the ask tool's), a question a turn asked the host to put
 * (an approval). `waiting` says what a thread waits for, as a short label (`Needs input`, `Needs approval`), or
 * nothing; reactive. `Threads.attention` has such a thread waiting, with the first label an item gives, by order, above
 * its being at work or done.
 */
export interface ThreadWait {
  readonly waiting: (sessionId: string) => string | undefined;
}

export const ThreadWaits = defineSlot<ThreadWait>("thread.waits");

/** What a thread waits on the person for (`ThreadWaits`): the first item's label, by order, or none. */
export const waitingOn = (waits: readonly ThreadWait[], sessionId: string): string | undefined => {
  for (const wait of waits) {
    const label = wait.waiting(sessionId);
    if (label !== undefined) return label;
  }
  return undefined;
};

/** A prompt placed in the open thread, as the transcript shows it. */
export interface PromptInfo {
  readonly sessionId: string;
  /** Its message's event in the log. */
  readonly eventId: string;
  /** When it was placed. */
  readonly at: number;
  readonly content: readonly (TextContent | ImageContent)[];
  /** A steer: placed in its turn after the work began. */
  readonly steer: boolean;
}

export interface PromptActionProps {
  readonly prompt: PromptInfo;
}

/**
 * Buttons under a prompt in the transcript, after its time, shown while the pointer is on it, in order: the composer's
 * "Edit from here" (10), and the transcript's copy (20) and link to the prompt (30). An item draws its own button
 * (`icon-button`), or nothing for a prompt it does not apply to.
 */
export const PromptActions = defineSlot<Region<PromptActionProps>>("prompt.actions");

/** A model request that failed, as the transcript shows it: the provider and model asked, and what went wrong. */
export interface ErrorActionProps {
  readonly provider: string;
  readonly model: string;
  readonly message: string;
}

/**
 * Buttons under a failed model request in the transcript, in order: what would fix it, such as signing in again to
 * the provider that refused it. An item draws its own button (`button small`), or nothing for an error it cannot help.
 */
export const ErrorActions = defineSlot<Region<ErrorActionProps>>("transcript.error-actions");

/** What a session's menu item can do to its row. */
export interface ThreadRowControl {
  /** Edits the title in place. */
  readonly rename: () => void;
}

/** An item in a thread's menu: the ⋯ in its header, and a right-click on its row in the sidebar. Rename, pin, archive, and delete are the thread view's defaults. */
export type ThreadAction = MenuAction<SessionInfo, ThreadRowControl>;

export const ThreadActions = defineSlot<ThreadAction>("thread.actions");

/** What a view is drawn with. */
export interface ThreadViewProps {
  /**
   * The inspection pane's tab it shows in (`Pane`), unique among every thread's tabs and kept across reloads; absent
   * for the first view, which fills the page. A view may have several tabs: what it keeps for one (the browser's page)
   * is keyed by it, and let go once the tab is gone from `Pane.tabs`.
   */
  readonly tab?: string;
}

export interface ThreadView {
  readonly title: string;
  readonly icon: Component;
  readonly component: Component<ThreadViewProps>;
  /** The composer shows over its bottom: it pads its end by `--composer-height` (the composer's height, set on the page) to scroll under it. */
  readonly composer?: boolean;
  /** The letter that picks it in the menus that open a tab of the pane: its +, and its switch while it has none (`b` for the browser). */
  readonly letter?: string;
  /** A tab's name while it has one of its own (a page's title); its `title` otherwise. */
  readonly label?: (tab: string) => string | undefined;
}

/**
 * Views of a thread over the same log: the transcript (order 0), the trajectory (10), a browser (20), a page (30). The first by
 * order fills the page; the others open as tabs in the thread's inspection pane beside it (`Pane`), by its + or the
 * palette, as many of each as are wanted.
 */
export const Views = defineSlot<ThreadView>("views");

/** A tab of a thread's inspection pane: a `Views` item's, by its id. */
export interface PaneTab {
  /** Unique among every thread's tabs, and kept across reloads: a view's `ThreadViewProps.tab`. */
  readonly id: string;
  readonly view: string;
  /** The thread whose pane it is in. */
  readonly thread: string;
}

/** The inspection pane beside each thread's chat: its tabs are views of the thread (`Views`). Each thread has its own. */
export interface PaneService {
  /** Every thread's tabs: a view keeps what it keeps for one (the browser's page) while it is here. */
  readonly tabs: Accessor<readonly PaneTab[]>;
  /**
   * Opens a new tab of `view` in `thread`'s pane (else the shown thread's), showing it unless `background`: its id, or
   * undefined with no thread to open it in.
   */
  readonly open: (view: string, options?: { readonly background?: boolean; readonly thread?: string }) => string | undefined;
}

/**
 * Provided by `threads.view`. What a view draws outside the pane for one of its tabs (the browser's page, drawn over
 * the pane) marks itself `data-pane-tab` with the tab's id, so focus in it is in the pane: ⌘W there closes the tab.
 */
export class Pane extends Context.Service<Pane, PaneService>()("lemma-web/Pane") {}

export const ComposerRegion = defineSlot<Region>("composer", { shows: "first" });

/** What a composer button can do to the prompt being written. */
export interface ComposerActionProps {
  /** Attaches images (other files are refused with a notice). */
  readonly addFiles: (files: Iterable<File>) => Promise<void>;
  /** Inserts text at the cursor. */
  readonly insert: (text: string) => void;
}

/** Buttons beside send: the context meter and attaching images are the default ones. */
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
  /** Picking it also sends the prompt, as Enter would: a command needing nothing more (`/new`). */
  readonly submit?: boolean | undefined;
  /** What follows it once picked, muted after the cursor while it is the active one: a command's arguments (`<server>`). */
  readonly hint?: string | undefined;
}

/**
 * What a completion source answers: its suggestions, and optionally a line to show under them (`Still reading…`) and a
 * hint for the cursor.
 */
export type ComposerCompletionAnswer =
  | readonly ComposerSuggestion[]
  | {
      readonly suggestions: readonly ComposerSuggestion[];
      readonly note?: string | undefined;
      /** What the word at the cursor takes, muted after the cursor while no suggestion is active (`<server> <uri>`). */
      readonly hint?: string | undefined;
    };

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
  /**
   * `word` (the default): the trigger starts any word, and the word is completed. `line`: the trigger starts the
   * prompt, and what follows it on the first line is completed, spaces and all (`findCommandLine`): a command and its
   * arguments (`/thinking high`). A line source answers only a line's trigger, a word source only a word's.
   */
  readonly span?: "word" | "line" | undefined;
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

/** A value a command's argument may take, as the menu offers it. */
export interface PromptCommandValue {
  readonly value: string;
  /** Muted after the value: `current`, a server's state. */
  readonly detail?: string | undefined;
}

/** Where a command's argument is being typed: the command's path, and the arguments before it. */
export interface PromptCommandContext {
  /** The names from the command down to the subcommand the argument is of: `["mcp", "tool"]`. */
  readonly path: readonly string[];
  readonly args: readonly string[];
  /** The word being typed, so far. */
  readonly query: string;
  readonly signal: AbortSignal;
}

/** One of a command's arguments, in order. */
export interface PromptCommandArgument {
  /** Shown in its usage: `<server>`, `[focus]` when optional, `<tags...>` when it repeats. */
  readonly name: string;
  readonly optional?: boolean | undefined;
  /** Takes the rest of the line, spaces and all (`/compact keep the API`): it is last, and offers values for its first word only. */
  readonly rest?: boolean | undefined;
  /** Takes this word and every one after it, each offered its values (`[args...]`): it is last. */
  readonly repeats?: boolean | undefined;
  /**
   * What it may be, best first; the menu narrows them to what is typed, unless `ranked`. A value with spaces is
   * written quoted (`"my server"`). Read reactive values (the selected model, the servers) before any `await`, so the
   * menu asks again when they change.
   */
  readonly values?: ((context: PromptCommandContext) => readonly PromptCommandValue[] | Promise<readonly PromptCommandValue[]>) | undefined;
  /**
   * `values` are already those `query` finds, best first, as the command's `run` would choose among them (a search,
   * as `/model` does): the menu keeps them in their order, and Enter picks the first.
   */
  readonly ranked?: boolean | undefined;
}

/** What a command is run with. */
export interface PromptCommandInput {
  /** Its names from the command to the subcommand run, canonical (an alias typed is its command's name). */
  readonly path: readonly string[];
  /** The words after the path. */
  readonly args: readonly string[];
  /** The text after the path, trimmed: what a `rest` argument takes, newlines and all. */
  readonly text: string;
}

/** What a command and each of its subcommands are. */
export interface PromptCommandShape {
  readonly description: string;
  readonly icon?: Component | undefined;
  /** Other names it is typed by: `clear` for `new`. */
  readonly aliases?: readonly string[] | undefined;
  /** Commands under it, typed after its name (`/mcp tool …`), each with its own arguments and subcommands. */
  readonly subcommands?: readonly PromptSubcommand[] | undefined;
  /** Its arguments, after its subcommand's name when it has subcommands and none is typed. */
  readonly args?: readonly PromptCommandArgument[] | undefined;
  /**
   * Runs it in the web app when the prompt is sent, once its required arguments are there; the prompt clears. A
   * rejection's message is shown, and the prompt stays.
   */
  readonly run?: ((input: PromptCommandInput) => void | Promise<void>) | undefined;
}

export interface PromptSubcommand extends PromptCommandShape {
  readonly name: string;
}

/**
 * A command typed at the start of the prompt: `/`, its id, and maybe subcommands and arguments (`/new`,
 * `/thinking high`, `/mcp tool github create_issue hidden`). The `/` menu offers each word in turn and hints at what
 * the rest of the line takes. A command whose tree has a `run` runs in the web app; one with none is sent as typed,
 * for a host plugin to answer (`AgentInputHook`, as `/compact` is).
 */
export interface PromptCommand extends PromptCommandShape {}

/** The commands the `/` menu offers and the composer runs, by id: the word typed after `/`. */
export const PromptCommands = defineSlot<PromptCommand>("composer.commands");

/** An item in the session's header bar, at its start (after the sidebar toggle) or its end. */
export interface ThreadHeaderItem extends Region {
  readonly side: "start" | "end";
}

/** The session's header: the sidebar toggle, title, running chip, and the thread's ⋯ menu are its default items. */
export const ThreadHeader = defineSlot<ThreadHeaderItem>("thread.header");

/** Above the composer box: the connection notice, the provider callout. */
export const ComposerNotices = defineSlot<Region>("composer.notices");

/**
 * The composer, taken for a while by a plugin that needs the person's words for one thread (the agent's questions do):
 * its banner draws just above the box, in a panel in the completion menu's look, and the text box, Enter, and the send
 * button are its own.
 * The thread's draft stays as it was and comes back when it lets go. The composer shows the first item, by order,
 * holding the open thread.
 *
 * The person keeps the box while they have a prompt of their own unsent (text or images in it, or one going out), so
 * it never changes under their keys, and when they let it go (Escape in it, or the banner's `release`) until what it
 * is held for (`key`) changes. Meanwhile the composer draws the item's `waiting` above the box, whose `take` takes it
 * now, their prompt kept for after; a prompt they send instead lets it go. While taken, the composer offers no
 * `ComposerActions` and takes no images (what is written is text only), Up and Down bring back no sent prompt, and
 * Escape lets go rather than stopping the turn (the stop button still stops it).
 */
export interface ComposerTakeover {
  /** The thread it holds the composer for now, or none. */
  readonly sessionId: Accessor<string | undefined>;
  /** What it holds the composer for (one call's questions): one the person let go takes the box again when this changes. */
  readonly key: Accessor<string>;
  /** Drawn in a panel just above the box, in the completion menu's look; `release` gives the box back to the person. */
  readonly banner: Component<{ readonly release: () => void }>;
  /** Drawn above the composer while the person keeps the box; `take` takes it now. */
  readonly waiting: Component<{ readonly take: () => void }>;
  /** What the text box holds while taken: the plugin's own, apart from the thread's draft. */
  readonly text: Accessor<string>;
  readonly setText: (text: string) => void;
  readonly placeholder: Accessor<string>;
  /** The text box takes nothing (there is nothing to write now); the send button still works. */
  readonly readOnly?: Accessor<boolean>;
  /**
   * A key in the text box, offered first (after the completion menu, which takes its own keys while open): whether the
   * taker took it, which the composer then does nothing more with. The agent's questions take the menu's keys here.
   */
  readonly keyDown?: (event: KeyboardEvent) => boolean;
  /** Enter in the text box, or the send button, while `canSubmit`. */
  readonly submit: () => void;
  /** What the send button does, as its label and tip: `Next question`, `Submit answers`. */
  readonly submitLabel: Accessor<string>;
  /** Whether submitting does anything now; the send button is disabled, and Enter does nothing, while it does not. Default: it does. */
  readonly canSubmit?: Accessor<boolean>;
}

export const ComposerTakeovers = defineSlot<ComposerTakeover>("composer.takeovers");

/** The composer's toolbar, left of its buttons: the model and reasoning pickers. */
export const ComposerControls = defineSlot<Region>("composer.controls");

/**
 * A plugin's choice for the turns a prompt starts, sent with it (the agent's `TurnOptions.plugins`, keyed by `id`,
 * the plugin's id): the thread's mode, for `agent.modes`. Asked as each prompt is sent, for the thread it goes
 * to (`undefined` for a new one); `undefined` sends nothing for the plugin.
 */
export interface TurnOptionSource {
  /** The plugin whose choice it is: its key in `TurnOptions.plugins`. */
  readonly id: string;
  readonly value: (sessionId: string | undefined) => unknown;
}

export const TurnOptionSources = defineSlot<TurnOptionSource>("composer.turn-options");

/** Under the composer: the workspace bar. */
export const ComposerFooter = defineSlot<Region>("composer.footer");

/**
 * Under a new thread's prompt, while nothing is sent: what the thread starts with and keeps (its mode, its project), in
 * one centered line, in order; a menu an item opens goes below it, centered on it (`placement: "bottom"`). Gone once
 * the first prompt is sent: a thread's own are shown elsewhere.
 */
export const ThreadStart = defineSlot<Region>("thread.start");

/**
 * The thread card: an open thread's facts, in rows, floating over its chat's top right while the person has it open
 * (its header's switch; closed at first, and as a menu of views opens there): its mode, where it works, how full its
 * context is, what it has cost. Each row is
 * a plugin's, in order, drawn as a menu's rows are (`menu-item`, its icon in `menu-check`, `menu-label`, `menu-hint`);
 * a row that does something is a button, or a menu's trigger, of that class. Rows of a `group` sit together, groups in
 * the order their first rows come, set apart by a rule; a group whose rows draw nothing is left out. Changing a thread
 * is mostly the agent's to do, so a row mostly shows.
 */
export const ThreadCard = defineSlot<ThreadCardRow>("thread.card");

/** A row of the thread card. */
export interface ThreadCardRow extends Region {
  /** The rows it sits with: `thread` (what it is), `workspace` (where it works), `usage` (what it takes). Default: its own. */
  readonly group?: string;
}

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
  /**
   * What a call shows the reader beside the model's text (a page it drew), where they see it without opening anything:
   * after the turn's folded work and above its answer, while the call's line stays in the fold; under the line in a turn
   * shown unfolded. Drawn for a call with a result only, from it: a call a script made comes with its result and, of
   * its arguments, only `title` (`Tool.display`). A call it draws nothing for takes no room in the turn.
   */
  readonly display?: Component<ToolBodyProps>;
  /**
   * `true`: its `display` is drawn while a call runs too, from its arguments (`result` absent), as an agent's row shows
   * it working. Absent: only once a call has a result.
   */
  readonly live?: true;
  /**
   * Several calls of it in a row in one fold, drawn as one where their displays go: a response that started three
   * agents shows "3 agents", which opens to each. Absent, or for a call alone, each call's `display` is drawn.
   */
  readonly displays?: Component<ToolDisplaysProps>;
}

/** The calls a tool's `displays` draws as one, in order. */
export interface ToolDisplaysProps {
  readonly calls: readonly ToolBodyProps[];
}

export const ToolViews = defineSlot<ToolView>("chat.tools");

/** A `context` event (what a plugin told the model), as the chat shows it. */
export interface ContextViewProps {
  readonly id: string;
  /** The plugin that told the model. */
  readonly source: string;
  /** What the model read: the event's content, its text. */
  readonly content: string;
  /** What the event says a transcript shows of it (`display`), if it says. */
  readonly display?: string | undefined;
  /** Its submission's id, when the agent placed it for the plugin (`ModelNotice`): `<source>:<id>`. */
  readonly requestId?: string | undefined;
  /** When it was logged, epoch ms. */
  readonly at: number;
}

/**
 * How the chat shows what a plugin told the model (its `context` events); the item's id is the plugin's. Without one, a
 * line names the plugin and the first line of what it said. A finished agent's notice shows as the agent.
 */
export interface ContextView {
  readonly component: Component<ContextViewProps>;
}

export const ContextViews = defineSlot<ContextView>("chat.context");

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
