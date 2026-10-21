import { Schema } from "effect";
import { defineChannel } from "@lemma/contracts";

/*
 * Modes: what a thread's agent is for (`agent.modes`), chosen with its first prompt and kept. The choice travels as the
 * mode's name in `TurnOptions.plugins`, under the plugin's id, and the thread's first turn logs it.
 */

/** The modes plugin's id: its key in `TurnOptions.plugins`, whose value is the chosen mode's name. */
export const MODES_PLUGIN = "agent.modes";

/**
 * The plugin's id before modes were named so (`agent.profiles`): the key older threads' `turn-start` events logged their
 * mode under, which `MODES_PLUGIN`'s reader takes too.
 */
export const MODES_PLUGIN_FORMERLY = "agent.profiles";

/** A mode as clients list it: what picking one needs, not its prompt. */
export const ModeInfo = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  thinking: Schema.optional(Schema.String),
  source: Schema.Literals(["bundled", "user", "project"]),
});
export type ModeInfo = typeof ModeInfo.Type;

/** What the host half serves its web half and the CLI. */
export const ModeChannels = {
  list: defineChannel({
    kind: "call",
    id: "modes.list",
    access: "read",
    title: "List modes",
    description: "The modes a thread in a directory (cwd) can be given, and which is the default",
    payload: Schema.Struct({ cwd: Schema.optional(Schema.String) }),
    success: Schema.Struct({ modes: Schema.Array(ModeInfo), default: Schema.String }),
    repeatable: true,
  }),
} as const;
