# context.project

Adds project instructions to every model request: a section in the agent's
`PromptSections`. Requires `Paths`. No config.

For each directory, the first existing file of `AGENTS.override.md`, `AGENTS.md`,
`AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD` is used (pi's order; `CLAUDE.md` is the
fallback). Files come from `Paths.home` (user-wide) first, then every directory
from the filesystem root down to the session cwd, so more specific instructions
come last. They are rendered as one section (id `project-context`, source = this
plugin's id) of `<project_instructions path="…">` blocks, in the phase `body` at
order 500: after the agent's base prompt and before its `environment` section.

Contents are cached by path, size, and mtime: a request costs a few `stat` calls,
and an edited file is picked up on the next request. The agent tells the model
of a change in a `prompt-update` event before that request, rather than rewrite the
system prompt the provider has cached ([append-only
requests](../../agent/loop/README.md#append-only-requests)); the next request
that declares the prompt afresh carries the new instructions in it.
