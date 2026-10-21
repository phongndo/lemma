import type { QueuedPrompt } from "@lemma/agent";
import type { ImageContent, TextContent } from "@lemma/llm";
import type { SessionInfo } from "@lemma/sessions";
import { definePart, partView } from "@lemma/web";
import type { JSX } from "solid-js";
import type { ComposerSuggestion, PromptInfo, ThreadAction, ToolBodyProps } from "./threads.ts";
import type { TurnView } from "./transcript.ts";

export interface ComposerQueuedProps {
  /**
   * A prompt waiting for the next turn: a follow-up, or with no turn running, any prompt the last one left queued (a
   * steer too). A steer for a running turn has no row: the transcript shows it.
   */
  readonly prompt: QueuedPrompt;
  /** Takes it out of the queue. */
  readonly withdraw: () => void;
  /**
   * Makes it a steer, which joins the running turn after its current step. Absent while no turn runs (the queue held
   * after a failed or cancelled turn waits for the next prompt, and has no turn to steer).
   */
  readonly promote?: (() => void) | undefined;
}

/** A queued prompt above the composer: its default shows the prompt's text, and buttons to steer with it and to withdraw it. */
export const ComposerQueuedPart = definePart<ComposerQueuedProps>("composer.queued");

export interface ComposerSuggestionProps {
  readonly suggestion: ComposerSuggestion;
  /** The one Enter would pick. */
  readonly active: boolean;
}

/**
 * The inside of a row in the composer's completion menu: its default shows the
 * icon, the label with matched letters marked, its hint (what it takes), then the detail. The composer
 * owns the row itself (its selection, clicks, and keys).
 */
export const ComposerSuggestionPart = definePart<ComposerSuggestionProps>("composer.suggestion");

export interface ChatUserProps {
  readonly content: readonly (TextContent | ImageContent)[];
  /** A steer: sent into the running turn, which places it (or will) after its current step. */
  readonly steer?: boolean | undefined;
  /** The prompt as placed, which its time and its buttons (`PromptActions`) are drawn from; absent for a steer not yet placed. */
  readonly prompt?: PromptInfo | undefined;
}

/** A prompt in the transcript; its default shows, under it, when it was sent and its `PromptActions` while the pointer is on it. */
export const ChatUserPart = definePart<ChatUserProps>("chat.user");

export interface ChatThinkingProps {
  readonly text: string;
  readonly redacted?: boolean | undefined;
  /** Still streaming. */
  readonly live?: boolean | undefined;
  readonly open: boolean;
  readonly onToggle: () => void;
}

/** A thought, collapsed to one line until opened. */
export const ChatThinkingPart = definePart<ChatThinkingProps>("chat.thinking");

export interface ChatToolProps extends ToolBodyProps {
  /** Arguments as streamed so far, before they parse. */
  readonly partial?: string | undefined;
  /** How long it has been running, in ms. */
  readonly elapsed?: number | undefined;
  readonly open: boolean;
  readonly onToggle: () => void;
}

/** A tool call and its result. Its body defaults to the tool's `ToolViews` item, then the chat's own. */
export const ChatToolPart = definePart<ChatToolProps>("chat.tool");

export interface ChatWorkProps {
  /** Steps folded: one run of a turn's work, between its prompt or a steer and the next, or the answer. */
  readonly steps: number;
  readonly tools: number;
  readonly failed: number;
  /** How long the run took, or while it is the running turn's last, has run so far. */
  readonly duration?: number | undefined;
  /** The running turn's last run, which its streaming step joins; open unless the reader closed it. */
  readonly live?: boolean | undefined;
  readonly open: boolean;
  readonly onToggle: () => void;
  /** The folded steps, rendered by the chat. */
  readonly children: JSX.Element;
}

export const ChatWorkPart = definePart<ChatWorkProps>("chat.work");

export interface ChatWorkGroupProps {
  /** What its calls did, in a sentence: "Read 3 files, ran 2 commands". */
  readonly summary: string;
  /** The tool names its calls used, in order. */
  readonly tools: readonly string[];
  readonly failed: number;
  /** When its first step was logged. */
  readonly at: number;
  readonly open: boolean;
  readonly onToggle: () => void;
  /** Its thoughts and calls, rendered by the chat. */
  readonly children: JSX.Element;
}

/** Tool calls made one after another inside folded work, as one line that opens to them. */
export const ChatWorkGroupPart = definePart<ChatWorkGroupProps>("chat.work-group");

export interface ChatWorkingProps {
  /** When the running turn started, if known. */
  readonly startedAt?: number | undefined;
  /** The time, ticking each second. */
  readonly now: number;
}

/** Shown at the end of the transcript while a turn runs. */
export const ChatWorkingPart = definePart<ChatWorkingProps>("chat.working");

export interface ChatTurnFooterProps {
  readonly turn: TurnView;
  /** The answer's markdown source; empty when the turn ended in a tool call. */
  readonly answer: string;
}

/** Under a finished turn: model, tokens, speed, cost, time, copy. */
export const ChatTurnFooterPart = definePart<ChatTurnFooterProps>("chat.turn-footer");

export interface SidebarRowProps {
  readonly session: SessionInfo;
  /** The open session. */
  readonly active: boolean;
  /** A turn is running in it. */
  readonly running: boolean;
  /** When its running turn began, as far as this page saw it start. */
  readonly runningSince?: number | undefined;
  /** A turn ended in it while another thread was open, and it has not been opened since. */
  readonly unread: boolean;
  /** A prompt is written in it and not sent (`Threads.drafts`); never so for the open thread, whose composer shows it. */
  readonly drafted: boolean;
  /** What it waits on the person for (`ThreadWaits`): `Needs input`. */
  readonly waiting?: string | undefined;
  /** The time, ticking once a second while a turn runs and once a minute otherwise, for times. */
  readonly now: number;
  /** Its address: the row is a link, so it opens in a new tab or window too. */
  readonly href: string;
  /** Opens it here; a row calls it for a plain click instead of following `href`. */
  readonly select: () => void;
  readonly rename: (title: string) => void;
  /** Its menu: the `ThreadActions` that apply to it, in order. */
  readonly actions: readonly ThreadAction[];
  /** The project it is in, by name. */
  readonly project: string;
  /** The branch its folder has checked out, once known; `worktree` when the folder is a worktree of the project. */
  readonly branch?: string | undefined;
  readonly worktree?: boolean | undefined;
  /** Archives it (one at work too: its turn goes on), or unarchives an archived one; absent where it cannot be. */
  readonly archive?: (() => void) | undefined;
  /** Pins it, or unpins a pinned one; absent while it cannot be (archived). */
  readonly pin?: (() => void) | undefined;
  /** When it was archived here, which an archived one's age counts from; absent when not known (its last use then). */
  readonly archivedAt?: number | undefined;
  /** The keys that go to it (`⌘1`), while all but their last are held down (`Action.onHold`): shown then, in place of its state. */
  readonly shortcut?: string | undefined;
}

/**
 * A thread in the sidebar's list: a card, or a slim row once archived (`session.archived`). Arrow keys move between
 * elements marked `data-session-row`.
 */
export const SidebarRowPart = definePart<SidebarRowProps>("sidebar.row");

export const ChatUser = partView(ChatUserPart);

export const ComposerQueued = partView(ComposerQueuedPart);

export const ComposerSuggestionView = partView(ComposerSuggestionPart);

export const ChatThinking = partView(ChatThinkingPart);

export const ChatTool = partView(ChatToolPart);

export const ChatWork = partView(ChatWorkPart);

export const ChatWorkGroup = partView(ChatWorkGroupPart);

export const ChatWorking = partView(ChatWorkingPart);

export const ChatTurnFooter = partView(ChatTurnFooterPart);

export const SidebarRow = partView(SidebarRowPart);
