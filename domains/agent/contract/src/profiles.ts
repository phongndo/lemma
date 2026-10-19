import { Schema } from "effect";
import { defineChannel } from "@lemma/contracts";

/*
 * Profiles: what a thread's agent is for, chosen per thread (`agent.profiles`). A thread's choice travels as the
 * profile's name in `TurnOptions.plugins`, under the plugin's id.
 */

/** The profiles plugin's id: its key in `TurnOptions.plugins`, whose value is the chosen profile's name. */
export const PROFILES_PLUGIN = "agent.profiles";

/** A profile as clients list it: what picking one needs, not its prompt. */
export const ProfileInfo = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  thinking: Schema.optional(Schema.String),
  source: Schema.Literals(["bundled", "user", "project"]),
});
export type ProfileInfo = typeof ProfileInfo.Type;

/** What the host half serves its web half and the CLI. */
export const ProfileChannels = {
  list: defineChannel({
    kind: "call",
    id: "profiles.list",
    title: "List profiles",
    description: "The profiles a thread in a directory (cwd) can be given, and which is the default",
    payload: Schema.Struct({ cwd: Schema.optional(Schema.String) }),
    success: Schema.Struct({ profiles: Schema.Array(ProfileInfo), default: Schema.String }),
    repeatable: true,
  }),
} as const;
