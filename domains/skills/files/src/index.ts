import { homedir } from "node:os";
import * as path from "node:path";
import { Effect } from "effect";
import { definePlugin } from "@lemma/core";
import { Channels, HostControl, Paths, resourcesOf, serveChannel } from "@lemma/contracts";
import { AgentInputHook, PromptSections } from "@lemma/agent";
import { Sessions } from "@lemma/sessions";
import { SkillChannels, SKILLS_CONTRACT } from "@lemma/skills";
import { Config } from "./config.ts";
import { expandHome, makeSkillFinder, mentionedSkills, skillBlock, skillsSection } from "./skills.ts";

export { makeSkillFinder, mentionedSkills, skillBlock, skillsSection } from "./skills.ts";

/** The names of a project's skill directories, looked for in a session's directory and each above it. */
const PROJECT_DIRS = [path.join(".agents", "skills"), path.join(".lemma", "skills")];

/**
 * Skills from `SKILL.md` files: the model is told each one's name and description (a `PromptSections` section) and
 * reads one when a task calls for it; a prompt naming one (`$review`) carries its instructions (`AgentInputHook`);
 * clients list them (`skills.list`), as the web half's `$` menu does. A plugin's package brings skills by naming
 * their folder (`"resources": { "skills": "./skills" }`), while the plugin is on.
 */
export default definePlugin({
  id: "skills.files",
  implements: [SKILLS_CONTRACT],
  version: "0.1.0",
  config: Config,
  requires: { paths: Paths, sessions: Sessions, host: HostControl },
  setup: function* ({ paths, sessions, host }, owner) {
    const { dirs, trigger } = owner.config;
    const home = homedir();
    const find = makeSkillFinder({
      user: [path.join(paths.home, "skills"), path.join(home, ".agents", "skills"), ...dirs.map((dir) => path.resolve(expandHome(dir, home)))],
      project: PROJECT_DIRS,
      plugins: () =>
        Effect.runPromise(
          Effect.map(host.plugins, (plugins) =>
            resourcesOf(plugins, "skills").map(({ dir, source }) => ({ dir, scope: source === "project" ? "project" : "user" })),
          ),
        ),
    });
    const found = (cwd: string) => Effect.tryPromise(() => find(cwd));

    yield* owner.add(
      PromptSections,
      { id: "skills", text: ({ cwd }) => found(cwd).pipe(Effect.map((skills) => skillsSection(skills, trigger))) },
      // In `body`, after the project's instructions (500).
      { order: 600 },
    );

    // A prompt naming a skill carries its instructions after what was typed, so the log holds what the model read.
    yield* owner.on(AgentInputHook, (input, next) =>
      Effect.gen(function* () {
        const text = input.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
        if (!text.includes(trigger)) return yield* next(input);
        const skills = yield* sessions.get(input.sessionId).pipe(
          Effect.flatMap((session) => found(session.cwd)),
          Effect.orElseSucceed(() => []),
        );
        const named = mentionedSkills(text, skills, trigger);
        if (named.length === 0) return yield* next(input);
        return yield* next({ ...input, content: [...input.content, ...named.map((skill) => ({ type: "text" as const, text: skillBlock(skill) }))] });
      }),
    );

    yield* owner.add(
      Channels,
      serveChannel(SkillChannels.list, ({ cwd }) =>
        found(cwd).pipe(
          Effect.map((skills) => ({
            skills: skills.map((skill) => ({ name: skill.name, description: skill.description, path: skill.path, scope: skill.scope })),
          })),
          Effect.orElseSucceed(() => ({ skills: [] })),
        ),
      ),
    );
  },
});
