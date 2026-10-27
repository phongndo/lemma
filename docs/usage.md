# Using Lemma

Run these with a release [installed](installation.md):

```sh
lemma serve                        # start the host for this machine and open the web app
lemma status                       # query the running host; `lemma --help` lists commands
```

Run these from a checkout. A checkout can also run the desktop app. It uses
the checkout's own home, `~/.lemma-dev` ([development](development.md)).

```sh
nix develop -c pnpm start          # build the web app, start the host, print its URL
nix develop -c pnpm desktop        # the same app in a desktop window, with a host of its own
nix develop -c pnpm lemma status   # query the running host; `pnpm lemma --help` lists commands
```

The host runs the plugins. It serves the web app, the
[desktop app](../apps/desktop/README.md), and the [CLI](../apps/cli/README.md),
which all attach to it.

There is one host per home and profile. The home is `~/.lemma`, or
`$LEMMA_HOME`. The host is the authority over its home's sessions, config, and
credentials. Each host is separate from every other.

A profile is another Lemma beside the default. It has its own plugins,
threads, and logins ([profiles](configuration.md#profiles)).

- `lemma profile create <name>` makes a profile.
- `--profile <name>`, or `LEMMA_PROFILE`, picks one.

Where the host runs:

- **On your machine**, the desktop app starts a host when none runs. When the
  app quits, it stops that host, and first says what stopping cuts off.
  - `lemma serve` runs a host in a terminal.
  - `lemma serve --detach` runs one in the background.
  - `lemma stop` stops it.
  - `lemma logs` shows what it printed, however it was started.
- **On a server**, `lemma service install` keeps a host running as a user
  service. The service starts at login and restarts after a crash. Clients on
  other machines reach it there: see [remote access](remote.md).

Log in to a provider in one of three ways:

- the key icon in the web app;
- `lemma login`;
- the provider's API key environment variable.

The [llm plugin](../domains/llm/pi-ai/README.md) lists the providers. It also
says how to add your own. `lemma doctor` says what is missing.
