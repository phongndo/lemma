# Todo (an example plugin with two halves, its state the log)

A todo list the agent keeps for a session. The [host half](todo.ts) adds a
`todo` tool (add an item, mark one done, list them) and a section of the
system prompt that reminds the agent what is still open. The
[web half](web.js) shows how the tool's calls read in the chat and adds a
**Todos** view beside the transcript. Both define the id `todo`, so one row
turns both on or off; [`package.json`](package.json)'s `lemma` manifest says
where each half is.

The list is kept nowhere but the session's log. Each call's result carries
the whole list in its `details`, and the list is the last one on the branch:
the host half reads it from `Sessions` at each call, and the web half from
the thread's branch. So a session checked out at an earlier event has the
list it had there, and a restart loses nothing.

| Shape | What it uses                                                                                |
| ----- | ------------------------------------------------------------------------------------------- |
| Add   | `Tools` (the tool), `PromptSections` (the reminder), `ToolViews` and `Views` (the web half) |
| Call  | `Sessions` (the host half), `Threads` (the web half)                                        |

To use it:

```sh
ln -s "$PWD/examples/todo" ~/.lemma/plugins/todo   # or copy the folder: the host loads it, and open web apps follow
```

`nix develop -c pnpm --filter @lemma/example-todo test` checks the list and
runs the host half in a core; the web app's `ui:check` loads the web half as
the plugin directory would.
