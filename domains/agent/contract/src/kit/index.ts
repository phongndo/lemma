/*
 * `@lemma/agent/kit`: the agent as `agent.loop` runs it, as pieces a loop of another kind builds on rather than
 * rewrites. `makeAgent` is the whole of it (turns, the queue and journal, resuming after a restart, the live view, the
 * channels), whose turns the agent's hooks shape (`AgentContinueHook` decides whether a turn takes another step). The
 * rest are its parts, for a loop that differs more: `runTurn` (one turn over the session log: requests built and logged, the
 * model's stream, tool calls run and answered, retries), `planResume` (where a turn a restart cut off goes on), the
 * journal files (`readJournals`, `writeJournal`), the queue's admission rules (`admission`, `makeQueues`), and the
 * live view (`LiveTurn`). A loop built on them meets the Agent contract by `agentConformance` (`@lemma/agent/testing`).
 */
export { AgentConfig, makeAgent, MAX_QUEUED, WITHDRAWN_KEPT } from "./agent.ts";
export type { AgentDeps, AgentOptions } from "./agent.ts";
export { BRANCHED_CALL, failedAs, runTurn, stopped, unansweredCalls } from "./turn.ts";
export type { Ended, TurnOutcome, TurnResume } from "./turn.ts";
export { INTERRUPTED_CALL, planResume, RESUMED, TOOLS_STARTED } from "./resume.ts";
export type { ResumePlan, ResumePoint } from "./resume.ts";
export { admission, itemOf, journalOf, makeQueues } from "./queue.ts";
export type { Admission, Item, QueuedTurn, SessionState, Suspended } from "./queue.ts";
export { Journal, LiveFile, nextInstance, readJournals, readLive, removeLive, removeState, writeJournal, writeLive } from "./state.ts";
export type { StateFiles } from "./state.ts";
export { LiveTurn, partialMessage, PartialMessage } from "./live.ts";
export { longestWait, nextRetry, noRetries, retried } from "./retry.ts";
export type { RetrySettings, RetryStreak } from "./retry.ts";
export { baseSection, environmentSection, titleFrom } from "./prompt.ts";
