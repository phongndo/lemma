import { Schema } from "effect";
import { defineChannel } from "@lemma/contracts";

/*
 * The skills domain's contract. A skill is a folder holding a `SKILL.md`: a name and a description in its
 * frontmatter, then the instructions. The model is told each skill's name and description, and reads one when a task
 * calls for it; a prompt naming one (`$review`) carries its instructions.
 */

export const SkillInfo = Schema.Struct({
  /** Its frontmatter's `name`, else its folder's: what follows `$`. */
  name: Schema.String,
  description: Schema.String,
  /** Its `SKILL.md`, absolute. */
  path: Schema.String,
  /** `user`: from a directory of the user's; `project`: from the session's directory or one above it. */
  scope: Schema.Literals(["user", "project"]),
});
export type SkillInfo = typeof SkillInfo.Type;

export const SkillChannels = {
  list: defineChannel({
    kind: "call",
    id: "skills.list",
    access: "read",
    title: "List skills",
    description: "The skills a session in `cwd` has, by name; where two share a name, the project's, then the nearest",
    payload: Schema.Struct({ cwd: Schema.String }),
    success: Schema.Struct({ skills: Schema.Array(SkillInfo) }),
    repeatable: true,
  }),
};
export { SKILLS_CONTRACT } from "./version.ts";
