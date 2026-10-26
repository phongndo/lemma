import { Effect } from "effect";
import { definePlugin } from "@lemma/core";
import { HostControl, Paths } from "@lemma/contracts";
import { Agent, AgentRequestHook } from "@lemma/agent";
import { AgentConfig, makeAgent } from "@lemma/agent/kit";
import type { AgentOptions } from "@lemma/agent/kit";
import { Llm } from "@lemma/llm";
import { deriveMessages, Sessions } from "@lemma/sessions";
import type { SessionEvent } from "@lemma/sessions";
import { ToolRunner } from "@lemma/tools";

/**
 * An agent of another kind, built on the agent kit (`@lemma/agent/kit`) rather than written from nothing: each turn
 * starts fresh, from a short handoff of the turn before (what it was asked, and what it answered) in place of the
 * whole history, as a "Ralph" loop does. The handoff is a `compaction` the first request of each turn appends, so the
 * request still rebuilds from the log and the transcript marks the place. Everything else (the queue, the journal,
 * resuming after a restart, the live view, the channels) is the kit's, as `agent.loop` has it.
 *
 * A folder plugin, written the way a user writes one: it provides `Agent`, so it takes `agent.loop`'s place.
 */

const textOf = (event: SessionEvent | undefined): string => {
  if (event?.data.type !== "message") return "";
  return event.data.message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
};

/**
 * The handoff a turn starts from, from the log: the turn before's first prompt and last answer, in place of
 * everything before this turn's first prompt (`firstKeptId`). None for a session's first turn, or once the turn has
 * one (a later step, or the turn resumed after a restart). Pure, so it is tested without a host.
 */
export const handoff = (branch: readonly SessionEvent[], turnId: string): { readonly summary: string; readonly firstKeptId: string } | undefined => {
  const start = branch.findIndex((event) => event.data.type === "turn-start" && event.data.turnId === turnId);
  if (start === -1) return undefined;
  const first = branch.slice(start).find((event) => event.data.type === "message" && event.data.message.role === "user");
  if (first === undefined) return undefined;
  if (branch.some((event) => event.data.type === "compaction" && event.data.firstKeptId === first.id)) return undefined;
  const before = branch.slice(0, start);
  const lastTurn = [...before].reverse().find((event) => event.data.type === "turn-start");
  if (lastTurn === undefined || lastTurn.data.type !== "turn-start") return undefined;
  const turn = lastTurn.data.turnId;
  const ofTurn = before.filter((event) => event.data.type === "message" && event.data.turnId === turn);
  const asked = ofTurn.find((event) => event.data.type === "message" && event.data.message.role === "user");
  const answered = [...ofTurn].reverse().find((event) => event.data.type === "message" && event.data.message.role === "assistant");
  return {
    summary: `The turn before, you were asked:\n${textOf(asked)}\n\nAnd you answered:\n${textOf(answered)}`,
    firstKeptId: first.id,
  };
};

/** The plugin on what `options` gives it (a simulation passes its disk and ids), else this process's. */
export const makeFreshLoop = (options: AgentOptions = {}) =>
  definePlugin({
    id: "fresh-loop",
    version: "0.1.0",
    // It is an Agent: it implements the agent domain's contract, and is written against the session log's.
    implements: ["lemma/agent@2"],
    uses: ["lemma/agent@2", "lemma/sessions@1"],
    config: AgentConfig,
    provides: { agent: Agent },
    requires: { sessions: Sessions, llm: Llm, tools: ToolRunner, host: HostControl, paths: Paths },
    // As the kit's agent: a reload stops it, suspending its turns, before the new instance resumes them.
    exclusive: true,
    deadlines: { dispose: "30 seconds" },
    setup: function* (deps, owner) {
      // Before compaction sizes the request (`fit`), so it sizes the fresh one.
      yield* owner.on(
        AgentRequestHook,
        (draft, next) =>
          Effect.gen(function* () {
            const handed = handoff(draft.branch, draft.turnId);
            if (handed === undefined) return yield* next(draft);
            const event = yield* draft.append({ type: "compaction", ...handed, tokensBefore: 0, source: "fresh-loop", turnId: draft.turnId });
            const branch = [...draft.branch, event];
            return yield* next({ ...draft, branch, history: deriveMessages(branch) });
          }),
        { phase: "fit", order: -20 },
      );
      return { agent: yield* makeAgent(deps, owner, options) };
    },
  });

export default makeFreshLoop();
