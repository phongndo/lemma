import type { CodemodeCallRecord, CodemodeDetails } from "./details.ts";

// What the web half reads of a call: its script's first line, and its calls, from its details or its live output. Pure.

/** A script's first line worth reading on the call's line: not its options line, nor blank. */
export const firstLine = (code: unknown): string | undefined => {
  if (typeof code !== "string") return undefined;
  const line = code
    .split("\n")
    .map((text) => text.trim())
    .find((text) => text !== "" && !text.startsWith("// @options:"));
  return line === undefined ? undefined : line.length <= 120 ? line : `${line.slice(0, 119)}…`;
};

/** The calls a result's details hold, or none. */
export const detailsOf = (details: unknown): Partial<CodemodeDetails> =>
  typeof details === "object" && details !== null ? (details as Partial<CodemodeDetails>) : {};

/** A call line as the host printed it while the script ran: `✓ bash 12ms {…}`. */
const LIVE_LINE = /^([✓✗–]) (\S+) (\d+)ms(?: (.*))?$/;

/** The calls a running script has printed so far, read back from its output. */
export const liveCalls = (output: string | undefined): CodemodeCallRecord[] =>
  (output ?? "").split("\n").flatMap((line): CodemodeCallRecord[] => {
    const match = LIVE_LINE.exec(line);
    if (match === null) return [];
    const [, mark, name, ms, rest] = match;
    const replayed = rest?.endsWith(" (from before the restart)") === true;
    const args = replayed ? rest!.slice(0, -" (from before the restart)".length) : rest;
    return [
      {
        name: name!,
        ...(args === undefined || args === "" ? {} : { args }),
        status: mark === "✓" ? "ok" : mark === "✗" ? "error" : "cancelled",
        durationMs: Number(ms),
        ...(replayed ? { replayed: true as const } : {}),
      },
    ];
  });

/** What a script printed, as its result's text parts hold it, without the result's header (how it ended, its wall time). */
export const scriptOutput = (content: readonly { readonly type: string; readonly text?: string }[]): string =>
  content
    .flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : []))
    .join("\n")
    .replace(/^Script (completed|failed)[^\n]*\nWall time [^\n]*\nOutput:\n+/, "");
