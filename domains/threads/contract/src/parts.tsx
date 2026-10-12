import type { QueuedPrompt } from "@lemma/agent";
import type { ImageContent, TextContent } from "@lemma/llm";
import type { SessionInfo } from "@lemma/sessions";
import { definePart, partView } from "@lemma/web";
import type { JSX } from "solid-js";
import type { ComposerSuggestion, ThreadAction, ToolBodyProps } from "./threads.ts";
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
 * icon, the label with matched letters marked, then the detail. The composer
 * owns the row itself (its selection, clicks, and keys).
 */
export const ComposerSuggestionPart = definePart<ComposerSuggestionProps>("composer.suggestion");

export interface ChatUserProps {
  readonly content: readonly (TextContent | ImageContent)[];
}

/** A prompt in the transcript. */
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
  /** Steps folded: a finished turn's work, or a running turn's work so far (`live`). */
  readonly steps: number;
  readonly tools: number;
  readonly failed: number;
  /** How long the turn took, or while it runs, has run so far. */
  readonly duration?: number | undefined;
  /** The turn is still running; its fold is open unless the reader closed it. */
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

/** Under a finished turn: model, tokens, cost, time, copy. */
export const ChatTurnFooterPart = definePart<ChatTurnFooterProps>("chat.turn-footer");

export interface SidebarRowProps {
  readonly session: SessionInfo;
  /** The open session. */
  readonly active: boolean;
  /** A turn is running in it. */
  readonly running: boolean;
  /** The time, ticking once a minute, for relative times. */
  readonly now: number;
  /** Its address: the row is a link, so it opens in a new tab or window too. */
  readonly href: string;
  /** Opens it here; a row calls it for a plain click instead of following `href`. */
  readonly select: () => void;
  readonly rename: (title: string) => void;
  /** Its menu: the `ThreadActions` that apply to it, in order. */
  readonly actions: readonly ThreadAction[];
}

/** A session in the sidebar's list. Arrow keys move between elements marked `data-session-row`. */
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
