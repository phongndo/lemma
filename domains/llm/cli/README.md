# llm.cli

The model providers' commands for the `lemma` command (`CliCommands` in [`@lemma/cli`](../../cli/README.md)): `models`, `providers`, `login`, and `logout`; and the check `llm.models` (`CliChecks`), which `lemma doctor` fails when no model is there to use. Requires `Interaction`, to ask at the terminal what a sign-in asks; it reaches the providers through their channels. No config.

## `login`

It follows the login's sign-in (`llm.sign-ins`) and prints each step as lines
of its own: the sign-in link and a device's one-time code alone on theirs, so
they copy whole into a browser on any machine. The client opens a sign-in link
where it has a browser, and a device code's page after Enter at a terminal.
What a step asks (an API key, masked, after why the provider refused the last;
a choice; the address a browser elsewhere ended on) the command asks under its
own origin, which the client answers as `--questions` says, and hands to the
sign-in (`llm.answer-sign-in`); a step that goes (the browser came back first)
withdraws its question. `--elsewhere` says the browser is on another machine,
so a sign-in that offers a device code uses it. Ctrl+C, or dismissing a
question, cancels the login (`llm.cancel-login`), which would otherwise
outlive the run. It prints who it signed in as, when the sign-in says.

`logout` says that Lemma forgot what it stored: the provider honors the key
or sign-in until it is revoked there.
