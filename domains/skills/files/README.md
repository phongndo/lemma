# skills.files

Skills from `SKILL.md` files ([`@lemma/skills`](../contract/src/index.ts)).
Its host half adds the section `skills` to the agent's `PromptSections` (phase
`body`, order 600, after the project's instructions), handles
`AgentInputHook`, and serves `skills.list` (`SkillChannels`). Its web half adds
the source `skills` (`Skills`) to `ComposerCompletions`. Requires `Paths` and
`Sessions`; the web half, `Client`, `Workspace`, and `Slots`.

| Config    | Default | What it does                                                                                      |
| --------- | ------- | ------------------------------------------------------------------------------------------------- |
| `dirs`    | `[]`    | Directories of skills besides the defaults below, a skill a folder in each (`"~/.claude/skills"`) |
| `trigger` | `"$"`   | What starts a word naming a skill, in the menu and in a sent prompt                               |

## Behavior

- **A skill** is a folder holding `SKILL.md`: frontmatter with `name` and
  `description`, then the instructions. The name is the folder's when the
  frontmatter gives none, and is letters, digits, `_`, `-`, and `.`; a folder
  whose name is none of that is skipped. The frontmatter is read as the flat
  YAML skills use (a value plain, quoted, continued, or a `>` or `|` block).
- **Where.** The user's directories: `~/.lemma/skills` (`Paths.home`),
  `~/.agents/skills`, and `dirs`, in order. Then a project's: `.agents/skills`
  and `.lemma/skills` in the session's directory and every one above it, from
  the root down. Where two share a name the later wins, so the nearest
  project's does. Like `AGENTS.md`, a project's skills need no trust: they are
  text the model reads, not code. Files are cached by size and mtime, so an
  edit is read on the next request.
- **The model is told** every skill's name, description, and file in the
  system prompt, and to read the file when a task matches. A skill changed
  or added changes the logged system prompt from the next request.
- **Naming one.** A prompt with `$name` at the start of a word, for a skill
  the session has, gets that skill's instructions appended as a text part
  (`<skill name="…" path="…">…</skill>`), once each, through `AgentInputHook`:
  the log keeps the prompt as placed, so the request can be rebuilt from it.
  A skill already carried in the prompt (one sent again) is not added twice.
- **The `$` menu** lists the thread directory's skills (`skills.list`) by
  name, fuzzily, with each description; picking one writes `$name`. With no
  skills it says where to add one.
