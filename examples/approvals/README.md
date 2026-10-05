# Approvals (an example plugin file)

Asks before the agent runs a command or writes outside the session's
directory: **Allow once**, **Allow bash for this session**, or **Deny** (the
model is told you declined). With nobody to ask (no web app open, no CLI
attached to answer), the call is denied.

It is a plugin file, not a bundled plugin: [`approvals.ts`](approvals.ts)
imports only packages the host supplies (`effect`, `@lemma/core`,
`@lemma/contracts`, and the file tools' own path resolution, so `~/x` and
`@x` mean what they mean to `write`), so it needs no install step. A path
counts as outside when it leads there through a link, too. To use it:

```sh
ln -s "$PWD/examples/approvals/approvals.ts" ~/.lemma/plugins/approvals.ts   # or copy it
lemma reload                                                                 # plugin files load on reload
```

As a plugin file it is required: if it cannot load or start, the host does
not start rather than run tools without asking (see
[configuration](../../docs/configuration.md#when-something-cannot-run)). It
then shows on the Plugins page as a user plugin, with its settings:

| Setting          | Default             | What it does                                                                  |
| ---------------- | ------------------- | ----------------------------------------------------------------------------- |
| `ask`            | `["bash"]`          | Tools that need approval for every call                                       |
| `outsideProject` | `["write", "edit"]` | Tools that need approval when their `path` is outside the session's directory |

Questions reach whichever client is attached: the web app shows a dialog (or
the palette, while it is open), `lemma run` asks at the terminal or takes
`--answer once|session|deny`, and `lemma questions` lists them with what they
are about. A `lemma run` with no terminal and no `--answer` does not attach, so
its questions go to an open web app, or are denied with none; `lemma run
--follow` in a script leaves them to the web app and waits.
"Allow for this session" lasts until the host restarts or the plugin reloads.

`nix develop -c pnpm --filter @lemma/example-approvals test` checks the
decisions and runs it as a file in a real host.
