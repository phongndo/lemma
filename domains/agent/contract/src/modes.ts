import { Schema } from "effect";
import { defineChannel } from "@lemma/contracts";

/*
 * Modes: what a thread's agent is for (`agent.modes`), chosen with its first prompt and kept. The choice travels as the
 * mode's name in `TurnOptions.plugins`, under the plugin's id, and the thread's first turn logs it.
 */

/** The modes plugin's id: its key in `TurnOptions.plugins`, whose value is the chosen mode's name. */
export const MODES_PLUGIN = "agent.modes";

/**
 * Where a mode is offered: as a new thread's (`thread`, the Mode picker), as an agent's a thread hands a task to
 * (`agent`, `tools.delegate`'s `mode`), or both, which a mode naming neither is.
 */
export const ModeUse = Schema.Literals(["thread", "agent"]);
export type ModeUse = typeof ModeUse.Type;

/** A mode as clients list it: what picking one needs, not its prompt. */
export const ModeInfo = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  thinking: Schema.optional(Schema.String),
  /** Where it is offered (`ModeUse`); absent, everywhere. */
  use: Schema.optional(Schema.Array(ModeUse)),
  source: Schema.Literals(["bundled", "user", "project"]),
});
export type ModeInfo = typeof ModeInfo.Type;

/** Whether a mode is offered for `use`: one that names none is offered for both. */
export const offeredFor = (mode: { readonly use?: readonly ModeUse[] | undefined }, use: ModeUse): boolean => mode.use === undefined || mode.use.includes(use);

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
