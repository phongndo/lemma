import type { Usage } from "@lemma/llm";
import type { ToolResult } from "@lemma/tools";

// What a codemode call keeps in its result's details: the host half writes them, the web half draws them. Browser-safe.

/** A call a script made: a tool's, or a global's (`models.classify`). */
export interface CodemodeCallRecord {
  readonly name: string;
  /** Its arguments as JSON, cut to a line. */
  readonly args?: string;
  readonly status: "ok" | "error" | "cancelled";
  readonly durationMs: number;
  /** Answered from before a host restart, not run again. */
  readonly replayed?: true;
}

/**
 * A call of a `display` tool that showed something, kept for the chat to show as that tool's calls show: its result,
 * which the tool's view draws from, and its input's `title`, without the rest of its input (a page twice over).
 */
export interface CodemodeDisplay {
  readonly name: string;
  readonly title?: string;
  readonly content: ToolResult["content"];
  readonly details?: unknown;
}

export interface CodemodeDetails {
  /** The script's calls, in the order it made them; the first 500, with how many more there were. */
  readonly calls: readonly CodemodeCallRecord[];
  readonly callsOmitted?: number;
  readonly truncated?: true;
  /** The complete text output, when it was truncated. */
  readonly fullOutputPath?: string;
  /** What the script's `models` calls used, when their services reported it. */
  readonly usage?: Usage;
  /** What the script's `store()` calls changed: later scripts on the branch `load()` it. */
  readonly storeWrites?: { readonly set: Readonly<Record<string, unknown>>; readonly delete: readonly string[] };
  /** Its calls of `display` tools that showed something (a page drawn), in the order it made them, for the chat to show. */
  readonly displays?: readonly CodemodeDisplay[];
  /** It resumed after a host restart cut it off. */
  readonly resumed?: true;
}
