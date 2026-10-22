# agent.modes

What a thread's agent is for, its mode: chosen when the thread starts, as its
project is, and kept. A mode is a Markdown file whose body is a section of the
system prompt, and whose frontmatter says what it keeps of what plugins offer.

```markdown
---
description: Drafts and edits prose
model: anthropic/claude-sonnet-5-5
thinking: low
tools: read, write, edit
sections: "*", "!project-context"
use: thread, agent
---

You help the user write. Keep their voice; say what you changed and why.
```

- **Where.** Bundled ones (`modes/` here), then those a running plugin's
  package brings (`"resources": { "modes": "./modes" }`, read from
  plugin status), then `~/.lemma/modes/`, then `.lemma/modes/` in the
  session's directory; a later one of a name wins.
  Modes carry no code and only narrow what plugins offer, so a project's
  load as its `AGENTS.md` and skills do. A mode is not a
  [profile](../../../docs/configuration.md#profiles), which is a separate Lemma.
- **Choosing.** The web half's Mode picker is on a new thread's start line
  (`ThreadStart`, first, before where it works): it sends the mode with the thread's
  first prompt
  (`TurnOptions.plugins["agent.modes"]`, through `TurnOptionSources`),
  starting from this browser's last pick, which Settings › General › New
  threads also sets. Picking one picks its `model` and `thinking` too, which the
  model picker then shows and can change; those stay the thread's to change.
  With none chosen, the configured `default` applies.
- **Kept.** The thread's first turn logs its mode (`turn-start`), the default
  written in when the prompt named none (an `AgentInputHook` handler), and the
  thread keeps it: a later prompt naming another goes with the thread's own, as
  its turn then logs, and an open thread shows its mode, without a picker, as the first row of its thread card (`ThreadCard`), unless it is the default.
  Another mode is another thread. Switching mid-thread would change the
  system prompt and tools under a conversation the model began with others,
  and start the prompt cache over.
- **What it does.** Its body is the `mode` section of the system prompt. In
  `AgentRequestHook`'s `select` phase, after every plugin has added its tools
  and sections, it keeps those its `tools` and `sections` allow: names, globs
  with `*`, or exclusions with `!`, applied in order, the last match deciding;
  with a list, a name nothing matches is left out; without one, everything
  stays. Its own section always stays.
- **Rebuilding.** Each request takes the mode from its turn's branch (the
  first `turn-start`), so a turn resumed after a restart keeps it, and a request
  rebuilds from the log; a tool the mode left out is refused to a resumed
  call too.
- **Threads and agents.** `use` says where a mode is offered: `thread`, a new
  thread's mode in the Mode picker; `agent`, an agent's a thread hands a task to
  (`tools.delegate`'s `mode`); or both, as a mode naming neither is. An
  agent's thread shows its mode as any thread does, though the picker offers it
  only where `thread` is named.
- **A name not found** (deleted, mistyped) gives the thread no mode, said
  once as a `Notice`. The bundled `coding` and `general`, which `work`
  replaced, go on as `work` in the threads that logged them.

| Config    | Default | What it does                                         |
| --------- | ------- | ---------------------------------------------------- |
| `default` | `work`  | The mode a new thread has when none is chosen for it |

Three ship with Lemma: `work` (how to carry work through in a codebase), the
default, with every tool and offered for both; `creator` (how to change Lemma
itself: plugins, modes, and settings, checked with the `lemma` CLI), with every
tool, for threads; and `explore`, for agents: it reads and searches (`read`,
`grep`, and `find` only), changes nothing, and reports what it found. With this plugin off,
the agent has its base prompt alone: what makes it a coding agent is a mode.
`work`'s first line asks the model to carry a task through: a reminder to
persist, one of three (with using tools and planning) that together raised
OpenAI's internal SWE-bench Verified score for GPT-4.1 by close to 20% ([its
prompting guide](https://developers.openai.com/cookbook/examples/gpt4-1_prompting_guide),
archived, read 2026-10-19).

Serves `modes.list` (`ModeChannels` in `@lemma/agent`): the modes a thread in
a directory can be given, with where each is offered (`use`), and the default.
