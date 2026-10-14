# llm.cli

The model providers' commands for the `lemma` command (`CliCommands` in [`@lemma/cli`](../../cli/README.md)): `models`, `providers`, `login`, and `logout`; and the check `llm.models` (`CliChecks`), which `lemma doctor` fails when no model is there to use. Requires nothing: it reaches the providers through their channels. No config.

## `login`

A login's questions and notices carry `login:<provider>`, which the client
answers (`out.answer`). Its notices print as lines of their own: the sign-in
link and a device's one-time code alone on theirs, so they copy whole into a
browser on any machine. The client opens a sign-in link where it has a
browser, and a device code's page after Enter at a terminal. Ctrl+C cancels
the run, and with it the login (`llm.cancel-login`), which would otherwise
outlive it.
