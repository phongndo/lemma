import { createEffect, on } from "solid-js";
import { rank } from "@lemma/web/match";
import { Client, Slots, defineWebPlugin } from "@lemma/web";
import { ComposerCompletions } from "@lemma/threads";
import type { ComposerSuggestion } from "@lemma/threads";
import { SkillChannels } from "@lemma/skills";
import type { SkillInfo } from "@lemma/skills";
import { Workspace } from "@lemma/workspace/web";
import { LogIcon } from "@lemma/look";
import { Config } from "./config.ts";

/** Said by an empty menu, so a person learns where skills come from. */
export const NO_SKILLS = "No skills yet: add a folder with a SKILL.md to ~/.lemma/skills, or to the project's .agents/skills";

/** How long a directory's list is kept while a word is typed: a skill added meanwhile shows within it. */
const LIST_MS = 5_000;

/**
 * The `$` menu: the skills of the thread's directory (`skills.list`, asked once per directory, connection, and few
 * seconds rather than per key), narrowed by name; picking one writes `$name`, which the host half expands when the
 * prompt is sent.
 */
export default defineWebPlugin({
  id: "skills.files",
  config: Config,
  requires: { client: Client, workspace: Workspace, slots: Slots },
  setup: ({ client, workspace, slots }, plugin) => {
    const { trigger } = plugin.config;
    let listed: { readonly cwd: string; readonly at: number; readonly skills: Promise<readonly SkillInfo[]> } | undefined;
    const skillsIn = (cwd: string) => {
      if (listed === undefined || listed.cwd !== cwd || Date.now() - listed.at > LIST_MS) {
        const skills = client.channel.call(SkillChannels.list, { cwd }).then((answer) => answer.skills);
        // A failed list is not kept: the next key asks again.
        skills.catch(() => {
          if (listed?.skills === skills) listed = undefined;
        });
        listed = { cwd, at: Date.now(), skills };
      }
      return listed.skills;
    };
    // Another connection may be another host: what it lists is asked anew.
    createEffect(on(client.connected, () => (listed = undefined), { defer: true }));
    slots.add(ComposerCompletions, {
      id: "skills",
      order: 100,
      trigger,
      label: "Skills",
      suggest: async (query, { signal }) => {
        // Read before any await, so the menu asks again for another project or once the host is back.
        const cwd = workspace.workingDir();
        const connected = client.connected();
        if (cwd === undefined || !connected) throw new Error("Waiting for the host…");
        const skills = await skillsIn(cwd);
        signal.throwIfAborted();
        if (skills.length === 0) return { suggestions: [], note: NO_SKILLS };
        return rank(
          skills.map((skill) => ({ key: skill.path, title: skill.name, keywords: [skill.description], skill })),
          query,
        ).map(({ item: { skill }, matches }): ComposerSuggestion => ({
          key: skill.path,
          label: skill.name,
          matches,
          detail: skill.description,
          icon: LogIcon,
          insert: `${trigger}${skill.name}`,
        }));
      },
    });
  },
});
