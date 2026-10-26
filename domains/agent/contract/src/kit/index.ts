/*
 * `@lemma/agent/kit`: the agent as `agent.loop` runs it, for a loop of another kind to build on rather than rewrite.
 * `makeAgent` is the whole of it: turns, the queue and journal, resuming after a restart, the live view, and the
 * channels, configured by `AgentConfig`. A loop built on it shapes its turns with the agent's hooks: `AgentRequestHook`
 * for what each request holds, and `AgentContinueHook` for whether a turn takes another step. `titleFrom` is the
 * provisional title a turn gives a session that has none. A loop built on the kit meets the Agent contract by
 * `agentConformance` (`@lemma/agent/testing`).
 */
export { AgentConfig, makeAgent } from "./agent.ts";
export type { AgentDeps, AgentOptions } from "./agent.ts";
export { titleFrom } from "./prompt.ts";
