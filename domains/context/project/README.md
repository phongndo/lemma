# context.project

Adds project instructions to every model request: a section in the agent's
`PromptSections`. Requires `Paths`. No config.

For each directory, the first existing file of `AGENTS.override.md`, `AGENTS.md`,
`AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD` is used (pi's order; `CLAUDE.md` is the
fallback). Files come from `Paths.home` (user-wide) first, then every directory
from the filesystem root down to the session cwd, so more specific instructions
come last. They are rendered as one section (id `project-context`, source = this
plugin's id) of `<project_instructions path="…">` blocks, at order 500: after
the agent's base prompt and before its `environment` section, so the
date-bearing section stays last and the cacheable prefix stays long.

Contents are cached by path, size, and mtime: a request costs a few `stat` calls,
and an edited file is picked up on the next request. Because the section is part
of the logged system prompt, a change appears in the session log as a new
`system` on the next `request` event.
