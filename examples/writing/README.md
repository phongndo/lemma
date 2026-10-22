# Writing (an example of an agent for prose)

Drafts held to the project's style guide. The [host half](writing.ts) puts
the guide (`STYLE.md` in the session's directory) in the system prompt, early,
so it changes only when the guide does, and adds `draft_stats`, which
measures a draft: words, sentences and their average length, the three
longest, paragraphs, and minutes to read. The agent checks a draft against
the guide's limits rather than guessing at them.

Its package brings the `writing` mode ([`modes/writing.md`](modes/writing.md))
by naming its folder in its manifest (`"resources": { "modes": "./modes" }`):
pick **writing** in the composer, and the agent drafts to a file, measures,
and revises, offered only the file tools, `draft_stats`, and `ask_user`.

| Shape | What it uses                                                |
| ----- | ----------------------------------------------------------- |
| Add   | `Tools` (`draft_stats`), `PromptSections` (the style guide) |

The guide is `STYLE.md`; its row's `config.guide` names another file.

To use it:

```sh
ln -s "$PWD/examples/writing" ~/.lemma-dev/plugins/writing   # or copy the folder, into ~/.lemma/plugins for an installed Lemma
```

`nix develop -c pnpm --filter @lemma/example-writing test` runs it in real
turns, with the mode found as the host finds it.
