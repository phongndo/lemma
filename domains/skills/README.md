# skills

Instructions the agent takes up for particular tasks: a skill is a folder with
a `SKILL.md` whose frontmatter names it and says when it applies. The model is
told each skill's name and description and reads one when a task calls for
it, and a prompt naming one (`$review`) carries its instructions. Its contract
is [`@lemma/skills`](contract/src/index.ts).

| Plugin                            | Halves    | What it does                                                                                                              |
| --------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------- |
| [`skills.files`](files/README.md) | host, web | Finds skills on disk, lists them to the model, adds a named one's instructions to the prompt; the `$` menu in the web app |

## Extending it

What the contract offers in each of the [five shapes](../../docs/plugins.md#the-five-shapes):

| Shape     | What the contract offers                                                                                          |
| --------- | ----------------------------------------------------------------------------------------------------------------- |
| Add       | Nothing of its own: a skill is a file, and a plugin adds instructions with the agent's `PromptSections`           |
| Intercept | Nothing of its own: a prompt naming a skill goes through the agent's `AgentInputHook`, before or after this one's |
| Observe   | Nothing                                                                                                           |
| Call      | `SkillChannels`: the skills a session in a directory has, as `SkillInfo`                                          |
| Serve     | `SkillChannels`: a plugin serving `skills.list` finds skills its own way, in place of `skills.files`              |
