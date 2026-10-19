# agent.profiles

What a thread's agent is for, chosen per thread: a profile is a Markdown file
whose body is a section of the system prompt, and whose frontmatter says what
it keeps of what plugins offer.

```markdown
---
description: Drafts and edits prose
model: anthropic/claude-sonnet-5-5
thinking: low
tools: read, write, edit
sections: "*", "!project-context"
---

You help the user write. Keep their voice; say what you changed and why.
```

- **Where.** Bundled ones (`profiles/` here), then those a running plugin's
  package brings (`"resources": { "profiles": "./profiles" }`, read from
  plugin status), then `~/.lemma/profiles/`, then `.lemma/profiles/` in the
  session's directory; a later one of a name wins.
  Profiles carry no code and only narrow what plugins offer, so a project's
  load as its `AGENTS.md` and skills do.
- **Choosing.** The web half's picker, before the model picker, sends the
  thread's profile with each prompt (`TurnOptions.plugins["agent.profiles"]`,
  through `TurnOptionSources`). A thread keeps the one its latest turn was
  taken with; a new thread starts with this browser's last pick, which
  Settings › General › New threads also sets. Picking one picks its `model` and
  `thinking` too, which the model picker then shows and can change. With none
  chosen, the configured `default` applies.
- **What it does.** Its body is the `profile` section of the system prompt. In
  `AgentRequestHook`'s `select` phase, after every plugin has added its tools
  and sections, it keeps those its `tools` and `sections` allow: names, globs
  with `*`, or exclusions with `!`, applied in order, the last match deciding;
  with a list, a name nothing matches is left out; without one, everything
  stays. Its own section always stays.
- **Rebuilding.** The turn logs the choice (`turn-start`), so a turn resumed
  after a restart keeps it, and a request rebuilds from the log; a tool the
  profile left out is refused to a resumed call too.
- **A name not found** (deleted, mistyped) gives the thread no profile, said
  once as a `Notice`.

| Config    | Default  | What it does                                        |
| --------- | -------- | --------------------------------------------------- |
| `default` | `coding` | The profile a thread has until one is chosen for it |

Two ship with Lemma: `coding` (how to work in a codebase), the default, and
`general` (no guidance of a kind of work, every tool). With this plugin off,
the agent has its base prompt alone: what makes it a coding agent is a profile.

Serves `profiles.list` (`ProfileChannels` in `@lemma/agent`): the profiles a
thread in a directory can be given, and the default.
