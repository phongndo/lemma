# Using Lemma

With a release [installed](installation.md):

```sh
lemma serve                        # start the host for this machine and open the web app
lemma status                       # query the running host; `lemma --help` lists commands
```

From a checkout, where the desktop app runs too, on the checkout's own home,
`~/.lemma-dev` ([development](development.md)):

```sh
nix develop -c pnpm start          # build the web app, start the host, print its URL
nix develop -c pnpm desktop        # the same app in a desktop window, with a host of its own
nix develop -c pnpm lemma status   # query the running host; `pnpm lemma --help` lists commands
```

The host runs the plugins and serves the web app, the
[desktop app](../apps/desktop/README.md), and the [CLI](../apps/cli/README.md),
which all attach to it. There is one host per home (`~/.lemma`, or
`$LEMMA_HOME`) and profile: it is the authority over that home's sessions,
config, and credentials, and each host is separate from any other. A profile
is another Lemma beside the default, with plugins, threads, and logins of its
own: `lemma profile create <name>` makes one, and `--profile <name>` (or
`LEMMA_PROFILE`) picks it ([profiles](configuration.md#profiles)).

- **On your machine** the desktop app starts a host when none runs, and stops
  it when it quits, saying first what that cuts off. `lemma serve` runs one
  in a terminal, and `lemma serve --detach` in the background; `lemma stop`
  stops it, and `lemma logs` shows what it printed, however it was started.
- **On a server** `lemma service install` keeps one running as a user service,
  started at login and restarted after a crash, for the clients on other
  machines that reach it: see [remote access](remote.md).

Log in to a provider from the key icon in the web app or with `lemma login`, or
set the provider's API key environment variable. The
[llm plugin](../domains/llm/pi-ai/README.md) lists the providers and how to add
your own. `lemma doctor` says what is missing.
