# skills.files

Skills from `SKILL.md` files ([`@lemma/skills`](../contract/src/index.ts)).
Its host half adds the section `skills` to the agent's `PromptSections` (phase
`body`, order 600, after the project's instructions), handles
`AgentInputHook`, and serves `skills.list` (`SkillChannels`). Its web half adds
the source `skills` (`Skills`) to `ComposerCompletions`.

| Config    | Default | What it does                                                                                      |
| --------- | ------- | ------------------------------------------------------------------------------------------------- |
| `dirs`    | `[]`    | Directories of skills besides the defaults below, a skill a folder in each (`"~/.claude/skills"`) |
| `trigger` | `"$"`   | What starts a word naming a skill, in the menu and in a sent prompt                               |

## Behavior

- **A skill** is a folder holding `SKILL.md`: frontmatter with `name` and
  `description`, then the instructions. The name defaults to the folder's. A
  name of anything but letters, digits, `_`, `-`, and `.` is skipped. The
  frontmatter is flat YAML: a value plain, quoted, continued, or a `>` or `|`
  block (`@lemma/contracts/frontmatter`).
- **Where.** Skills are read in this order, and a later one wins a name:
  1. a running plugin's package's (`"resources": { "skills": "./skills" }`);
  2. `~/.lemma/skills` (`Paths.home`), `~/.agents/skills`, then `dirs`;
  3. `.agents/skills` and `.lemma/skills` in the session's directory and each
     one above it, from the root down, so the nearest project's wins.
- **No trust needed.** A project's skills, like `AGENTS.md`, are text the model
  reads, not code. An edit is read on the next request.
- **The model is told** every skill's name, description, and file in the system
  prompt, and to read the file when a task matches.
- **Naming one.** `$name` at the start of a word appends that skill's
  instructions to the prompt as a text part (`<skill name="…" path="…">`), once,
  through `AgentInputHook`. The log keeps the prompt as placed, so the request
  rebuilds from it. A skill the prompt already carries is not added twice.
- **The `$` menu** lists the thread directory's skills (`skills.list`).
