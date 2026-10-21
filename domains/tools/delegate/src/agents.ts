import type { SessionEvent, SessionInfo } from "@lemma/sessions";

/**
 * The agents a thread started, as its web half shows them, pure so it is tested alone: what each is doing (from the
 * threads running and waiting), how each finished (from the thread's own log), and how its time reads.
 */

/** The tool, and the plugin whose notices tell a thread an agent finished. */
export const DELEGATE = "delegate";
export const SOURCE = "tools.delegate";

/** What an agent is doing, or how it finished. */
export type AgentState = "queued" | "working" | "waiting" | "done" | "failed" | "stopped";

export const stateLabel: Readonly<Record<AgentState, string>> = {
  queued: "Queued",
  working: "Working",
  waiting: "Needs input",
  done: "Finished",
  failed: "Failed",
  stopped: "Stopped",
};

/** Still at it: started or about to, or waiting on the person. */
export const isActive = (state: AgentState): boolean => state === "queued" || state === "working" || state === "waiting";

/** How a turn's end reads as an agent's state. */
export const endedState = (ended: string | undefined): AgentState =>
  ended === "cancelled" || ended === "timeout" ? "stopped" : ended === "error" || ended === "max-steps" || ended === "refused" ? "failed" : "done";

/**
 * How an agent finished, as the thread that started it logged it, and the start of its answer: `running` for one in
 * the background its thread has not heard from yet, with its last seq while its prompt waited for a slot (`emptyAt`).
 */
export interface AgentOutcome {
  readonly ended: string;
  readonly preview?: string | undefined;
  readonly emptyAt?: number | undefined;
}

/** A delegating call's `details` (`DelegateDetails`), as far as a view reads them. */
export interface CallDetails {
  readonly sessionId?: string;
  readonly title?: string;
  readonly mode?: string;
  readonly ended?: string;
  readonly preview?: string;
  readonly background?: boolean;
  readonly fork?: boolean;
  readonly emptyAt?: number;
}

export const callDetails = (details: unknown): CallDetails => {
  if (typeof details !== "object" || details === null) return {};
  const record = details as Record<string, unknown>;
  const text = (key: string) => (typeof record[key] === "string" ? (record[key] as string) : undefined);
  const out: Record<string, unknown> = {};
  for (const key of ["sessionId", "title", "mode", "ended", "preview"]) if (text(key) !== undefined) out[key] = text(key);
  if (record["background"] === true) out["background"] = true;
  if (record["fork"] === true) out["fork"] = true;
  if (typeof record["emptyAt"] === "number") out["emptyAt"] = record["emptyAt"];
  return out as CallDetails;
};

/** A finished agent's notice (its `context` event's content), read back: which agent, how it ended, and its answer. */
export const parseNotice = (
  content: string,
): { readonly session: string; readonly title: string; readonly ended: string; readonly body: string } | undefined => {
  const match = /^<agent_result title="([^"]*)" session="([^"]+)" ended="([^"]+)">\n?([\s\S]*?)\n?<\/agent_result>\s*$/.exec(content.trim());
  return match === null ? undefined : { title: match[1]!, session: match[2]!, ended: match[3]!, body: match[4]! };
};

/** Delegating calls' details a script kept for its displays (`codemode`'s `details.displays`). */
const scriptDisplays = (details: unknown): readonly unknown[] => {
  if (typeof details !== "object" || details === null) return [];
  const displays = (details as { readonly displays?: unknown }).displays;
  if (!Array.isArray(displays)) return [];
  return displays
    .filter((display) => (display as { readonly name?: unknown } | null)?.name === DELEGATE)
    .map((display) => (display as { details?: unknown }).details);
};

/**
 * How a thread's agents finished, by each agent's session, as its branch logged it: each delegating call's result (a
 * script's too; a background one's says it runs), and each background agent's notice. The latest of an agent's says.
 */
export const outcomesOf = (branch: readonly SessionEvent[]): ReadonlyMap<string, AgentOutcome> => {
  const out = new Map<string, AgentOutcome>();
  const take = (details: CallDetails) => {
    if (details.sessionId === undefined || details.ended === undefined) return;
    out.set(details.sessionId, {
      ended: details.ended,
      ...(details.preview === undefined ? {} : { preview: details.preview }),
      ...(details.emptyAt === undefined ? {} : { emptyAt: details.emptyAt }),
    });
  };
  for (const { data } of branch) {
    if (data.type === "message" && data.message.role === "toolResult") {
      if (data.message.toolName === DELEGATE) take(callDetails(data.details));
      else for (const details of scriptDisplays(data.details)) take(callDetails(details));
    } else if (data.type === "context" && data.source === SOURCE) {
      const content = data.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
      const notice = parseNotice(content);
      if (notice !== undefined) out.set(notice.session, { ended: notice.ended, preview: notice.body.trim().slice(0, 400) });
    }
  }
  return out;
};

/**
 * What an agent is doing now: waiting on the person, working (its thread runs), queued (nothing in it yet, or in the
 * background with no more in its log than its call made: its prompt waits for a slot), else how it finished as its
 * thread's log says (finished when it says nothing, or the thread has yet to hear).
 */
export const stateOf = (
  session: SessionInfo,
  live: { readonly running: boolean; readonly waiting?: string | undefined },
  outcome?: AgentOutcome,
): AgentState => {
  if (live.waiting !== undefined) return "waiting";
  if (live.running) return "working";
  if (session.lastSeq === 0) return "queued";
  if (outcome?.ended === "running") return outcome.emptyAt !== undefined && session.lastSeq <= outcome.emptyAt ? "queued" : "done";
  return endedState(outcome?.ended);
};

/** The agents a thread started (`SessionInfo.parent`), oldest first. */
export const childrenOf = (sessions: readonly SessionInfo[], parentId: string | undefined): readonly SessionInfo[] =>
  parentId === undefined ? [] : sessions.filter((session) => session.parent?.sessionId === parentId).sort((a, b) => a.createdAt - b.createdAt);

/** The agent a call started, found by its parent link: what a call shows before its result names it. */
export const agentOfCall = (sessions: readonly SessionInfo[], parentId: string | undefined, toolCallId: string): SessionInfo | undefined =>
  parentId === undefined ? undefined : sessions.find((session) => session.parent?.sessionId === parentId && session.parent.toolCallId === toolCallId);

/** How long since `since`, shortly: `12s`, `3m`, `1h 18m`. */
export const elapsed = (since: number, now: number): string => {
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

/** A count of agents, as a group's label says it: `1 agent`, `3 agents`. */
export const agentsLabel = (count: number): string => `${count} ${count === 1 ? "agent" : "agents"}`;

/** What a group of agents is doing, in a few words: the active first (`2 working`), else how they finished. */
export const groupStatus = (states: readonly AgentState[]): { readonly label: string; readonly active: boolean } => {
  const count = (state: AgentState) => states.filter((candidate) => candidate === state).length;
  const working = count("working") + count("queued");
  const waiting = count("waiting");
  if (working + waiting > 0) {
    const parts = [working > 0 ? `${working} working` : "", waiting > 0 ? `${waiting} need${waiting === 1 ? "s" : ""} input` : ""].filter(
      (part) => part !== "",
    );
    return { label: parts.join(", "), active: true };
  }
  const failed = count("failed");
  const stopped = count("stopped");
  const parts = [failed > 0 ? `${failed} failed` : "", stopped > 0 ? `${stopped} stopped` : ""].filter((part) => part !== "");
  return { label: parts.length === 0 ? "All finished" : parts.join(", "), active: false };
};
