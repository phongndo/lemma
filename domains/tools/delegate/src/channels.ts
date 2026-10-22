import { Schema } from "effect";
import { defineChannel } from "@lemma/contracts";

/** What a client asks of this plugin's agents: its web half's Stop, for one no turn of its own runs yet. */
export const DelegateChannels = {
  /**
   * Drops a background agent still waiting for a slot: its thread, holding nothing yet, is deleted, and the thread it
   * reports to is told it was stopped. Answers whether one was: an agent at work is stopped by cancelling its turn
   * (`agent.cancel`).
   */
  drop: defineChannel({
    kind: "call",
    id: "delegate.drop",
    access: "operate",
    title: "Drop a queued agent",
    description: "Drops a background agent still waiting for a slot, deleting its empty thread; answers whether one was",
    payload: Schema.Struct({ sessionId: Schema.String }),
    success: Schema.Boolean,
  }),
} as const;
