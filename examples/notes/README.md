# Notes (an example of an agent for research)

Research notes the agent keeps in the project (`notes/`, a Markdown note a
topic), so what one session finds outlasts it and the next picks up where it
left off. The [host half](notes.ts) adds three tools, `note_write` (add to a
note, or start it), `note_search` (each line that holds some text, with its
note and line), and `note_read`, and a section of the system prompt listing
the notes there are. The section sits after the project's instructions and
the skills, near the end of the prompt, so a new note changes only what
comes after it.

Its package brings, by naming their folders in its manifest
(`"resources": { "modes": "./modes", "skills": "./skills" }`):

- the `research` mode ([`modes/research.md`](modes/research.md)):
  pick **research** in the composer, and the agent works from its notes,
  keeps each finding with its source, and is offered the note tools and
  those that read the project (`read`, `grep`, `find`) and ask you
  (`ask_user`), but none that write or run anything;
- the `cite` skill ([`skills/cite/SKILL.md`](skills/cite/SKILL.md)): `$cite`
  in a prompt, or the model reading it when a task matches, records a source
  the same way each time.

| Shape | What it uses                                                                    |
| ----- | ------------------------------------------------------------------------------- |
| Add   | `Tools` (`note_write`, `note_search`, `note_read`), `PromptSections` (the list) |

The folder is `notes` in the session's directory; its row's `config.dir`
names another.

To use it:

```sh
ln -s "$PWD/examples/notes" ~/.lemma-dev/plugins/notes   # or copy the folder, into ~/.lemma/plugins for an installed Lemma
```

`nix develop -c pnpm --filter @lemma/example-notes test` runs it in real
turns, with the mode and the skill found as the host finds them.
