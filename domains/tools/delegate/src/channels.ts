import { Schema } from "effect";
import { defineChannel } from "@lemma/contracts";

/** What a client asks of this plugin's agents: its web half's Stop. */
export const DelegateChannels = {
  /**
   * Stops an agent: one still waiting for a slot is dropped (its thread, holding nothing yet, deleted, and the thread it
   * reports to told it was stopped); one whose prompt waits behind another turn has it withdrawn; one at work has its
   * turn cancelled. Answers which it did.
   */
  stop: defineChannel({
    kind: "call",
    id: "delegate.stop",
    access: "operate",
    title: "Stop an agent",
    description: "Stops an agent: dropped while it waits for a slot, its prompt withdrawn while it waits behind another turn, or its turn cancelled",
    payload: Schema.Struct({ sessionId: Schema.String }),
    success: Schema.Literals(["dropped", "withdrawn", "cancelled"]),
  }),
} as const;
