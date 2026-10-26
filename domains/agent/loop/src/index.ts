import { definePlugin } from "@lemma/core";
import { HostControl, Paths } from "@lemma/contracts";
import type { IdSource } from "@lemma/contracts";
import type { FileSystem } from "@lemma/contracts/fs";
import { Agent, AGENT_CONTRACT } from "@lemma/agent";
import { AgentConfig, makeAgent } from "@lemma/agent/kit";
import { Llm } from "@lemma/llm";
import { Sessions } from "@lemma/sessions";
import { ToolRunner } from "@lemma/tools";

export { MAX_QUEUED, WITHDRAWN_KEPT } from "@lemma/agent/kit";

export interface AgentPluginOptions {
  /** Where its journal and live files are: the real file system by default; a simulation passes a simulated disk. */
  readonly fs?: FileSystem;
  /** Where turn, step, and prompt ids' random bytes come from: the system's secure source by default. */
  readonly ids?: IdSource;
  /** The platform the environment section names: this process's (`linux (x64)`) by default. */
  readonly platform?: string;
}

/**
 * The agent: the kit's (`@lemma/agent/kit`), as a plugin providing `Agent`, on what `options` gives it and on this
 * process and its file system for what they leave out.
 */
export const makeAgentPlugin = (options: AgentPluginOptions = {}) =>
  definePlugin({
    id: "agent.loop",
    implements: [AGENT_CONTRACT],
    version: "0.1.0",
    config: AgentConfig,
    provides: { agent: Agent },
    requires: { sessions: Sessions, llm: Llm, tools: ToolRunner, host: HostControl, paths: Paths },
    // Turns resume in the next instance: a reload stops this one (suspending its turns) before starting that one.
    exclusive: true,
    // Room for `stopGrace` (at most 20 seconds) and for cutting off what is still running after it.
    deadlines: { dispose: "30 seconds" },
    setup: function* (deps, owner) {
      return { agent: yield* makeAgent(deps, owner, options) };
    },
  });

export default makeAgentPlugin();
