# Glossary (the plugin docs/building.md builds)

A glossary the agent keeps as it explains things, and a tutor that uses it.
[Building on Lemma](../../docs/building.md) builds it in three steps, and
these are its files:

- [`glossary.ts`](glossary.ts), the host half: a `glossary` tool that
  records a term and its meaning, the whole glossary in each result's
  `details`, so the session's log is its only store;
- [`glossary.web.js`](glossary.web.js), the web half: how its calls show in
  the chat, and a **Glossary** view of the open thread's terms;
- [`profiles/tutor.md`](profiles/tutor.md), a profile its package brings
  (`"resources"` in [`package.json`](package.json)): an agent that teaches a
  topic step by step, offered the glossary, `read`, and `ask_user`.

| Shape | What it uses                                                    |
| ----- | --------------------------------------------------------------- |
| Add   | `Tools` (the host half), `ToolViews` and `Views` (the web half) |
| Call  | `Sessions` (the host half), `Threads` (the web half)            |

To use it:

```sh
ln -s "$PWD/examples/glossary" ~/.lemma/plugins/glossary   # or copy the folder
```

`nix develop -c pnpm --filter @lemma/example-glossary test` runs it in real
turns, and checks that the guide shows these files as they are; the web
app's `ui:check` loads the web half as the plugin directory would.
