# @lemma/cli-app

The `lemma` command: start and keep hosts, set them up, look inside them, and
use what their plugins add, for people and for agents. `lemma --help` lists the
commands, flags, and exit codes; `lemma help --json` lists every command with a
JSON Schema of what it takes.

```sh
nix develop -c pnpm lemma serve --detach                       # a host for this machine, in the background
nix develop -c pnpm lemma status                               # who runs it, what it runs, what it is doing
nix develop -c pnpm lemma run new "fix the failing test" -f    # a plugin's command: agent.cli's run
nix develop -c pnpm lemma sessions inspect <id> --filter "is:error" --json
nix develop -c pnpm lemma kernel hooks                         # each hook's chain, in run order
nix develop -c pnpm lemma doctor                               # what is wrong here, and what to do about it
```

## What it is

A client of a host that holds no domain. Its own commands are the ones no
plugin could serve:

- **This machine's host and setup:** `serve`, `stop`, `restart`, `logs`,
  `service`, `env`, `token`, `config`, `trust`, `profile`, `doctor`,
  `plugins check`. They need no host running.
- **This lemma:** `version`, and `update`, which installs another release with
  the installer the release carries ([updating](../../docs/installation.md#updating)).
- **The runtime's:** `status`, `plugins`, `reload`, `kernel`, `inspectors`,
  `channels`, `events`, `questions`, `answer`, `dismiss`, `open`: what the host
  serves itself (`RuntimeRpcs`), whatever plugins run.

Every other command is a host plugin's (`CliCommands` in the [cli
domain](../../domains/cli/README.md)): `sessions …`, `run`, `agent …`,
`models`, `login`, `workspace …`, `commands …`, and a user's own. The command
lists them from the host it talks to (`cli.commands`), parses their words with
their spec, and runs them there (`cli.run`). The command's own come first: no
plugin shadows one.

## Behavior

- **Which host.** A command goes to the host `--env` names, else `LEMMA_URL`
  (with `LEMMA_TOKEN`), else the environment `LEMMA_ENV` names, else the
  default in `<home>/environments.json` (`lemma env use`), else this machine's
  ([remote access](../../docs/remote.md)). With none running here, a command
  that needs one fails `NoHost` (exit 3) rather than starting one; `serve` and
  the desktop app start hosts. A target that is set but cannot be used fails
  rather than falling back to another host.
- **Which profile.** A command goes to the [profile](../../docs/configuration.md#profiles)
  `--profile` names, else `LEMMA_PROFILE`'s, else the default, the home's own:
  `serve`, `stop`, `logs`, `token`, `config`, and `trust` act on that profile's
  home, and `service` installs a service of its own for it (`lemma-<name>`).
  On another machine (`--env`, `LEMMA_URL`), the host there opens the profile
  (`profiles.open`, which starts it), and the command goes to it at that
  machine's name and the profile's port. The environments a client knows are
  the home's, whichever the profile. `profile` lists the profiles, `profile
  create` makes one, and `profile remove` deletes one, asking first.
- **One host per home.** The host takes `<home>/host.lock` as it starts, so a
  second fails at once naming the first; `serve` says so before starting.
  `serve --detach` starts one in the background, marked as the CLI's
  (`LEMMA_STARTED_BY`), and returns once it listens. `stop` asks the host what
  stopping cuts off (`cli.in-progress`, from its plugins' `InProgress`) and asks, or refuses without a terminal
  unless `--force`; a host the desktop app started is the app's to stop, one a
  service runs is stopped through the service manager. `restart` stops it as
  `stop` does and starts it again on this lemma: through the service manager,
  whose definition names the `lemma` the installer links, or else in the
  background, for the project and on the port it had. The host writes what it
  prints to `<home>/logs/host.log`, which `logs` reads.
- **A plugin's command runs on the host.** It outlives a dropped connection
  there for a while (`cli.registry`'s `resumeGraceMs`): the command reconnects
  and rejoins it where it left off, so its output shows once and it never runs
  twice. It says on stderr when the connection dropped and when it is back, and
  gives up after 16 attempts in a row fail, about a minute (exit 3), saying how
  to run it again safely when the command said (`run`'s `--request-id`).
  Ctrl+C cancels it on the host. A command whose plugin stopped or reloaded
  while it ran fails `Withdrawn`.
- **Calls and streams.** A command of the runtime's that makes a call or two
  does so over HTTP, as help and completion do to list the plugins' commands;
  one that watches the host (`events`, `channels open`, and
  every plugin's command) holds `@lemma/client`'s reconnecting WebSocket, as the
  web app does, saying it is the `cli` (`Host.Clients`). While the host is still
  starting, a command fails `Unavailable` naming what it called (exit 3).
- **Questions.** A plugin's command answers the questions its work asks
  (those carrying its origin, and the origins it names: a run's session, a
  login's provider), as `--questions` says: `ask` at the terminal (the default
  when there is one), `dismiss`, or `ignore` (the default otherwise, so an agent
  never answers for the person), which leaves them to another client and says
  how to answer from the CLI. `--answer <value>` answers them in order; a form
  (several values at once) is answered with its fields as JSON, as in
  `lemma answer <id> '{"title": "Add forms"}'`, which `lemma questions` lists
  with their types. The host
  holds a question only for clients that answer questions; once none is
  connected it waits 15 seconds for one to come back
  ([`interactionGraceMs`](../../domains/transport/server/README.md)).
- **Machine-readable output.** With `--json`, results are the contract shapes
  on stdout, and failures `{"error": {"code", "message", "subject"?, "rerun"?}}`
  on stderr. Streams (`run --follow --json`, `events --json`, `channels open`)
  are NDJSON, a command's result last. JSON is the default when an agent runs
  the command (`LEMMA_AGENT`, which the host sets for its tools, or Claude
  Code's, Gemini CLI's, Codex's, or Cursor's variable), or `LEMMA_OUTPUT=json`;
  `--text` (or `LEMMA_OUTPUT=text`) prints text. A pipe alone keeps text.
  `--quiet` prints the ids a command reports, one per line, and `--fields a,b`
  keeps those fields of each object.
- **Exit codes.** 0 ok; 1 the host refused or failed the request, or the work
  it ran failed (a turn that errored); 2 a usage error, an unknown command
  among them; 3 no host, it could not be reached, the connection was lost, or
  it is still starting; 130 interrupted.
- **Directory scope.** A plugin's command receives the client's directory,
  which is the host's only when they are one machine: with a host elsewhere,
  give its path (`--cwd`, `--path`).
- **Pages.** `open` (and a command that opens one, as `sessions open` does)
  shows the web app in the desktop app when it runs here and shows the same
  host (`<home>/desktop.json`, the default profile's home, for every profile),
  in the window of the command's profile, else in the browser, else prints the address.
  A page elsewhere (a sign-in) opens in the browser where there is one.
- **Completion.** `lemma completion bash|zsh|fish` prints a script that asks
  `lemma __complete` for the next word: the commands, the host's plugins'
  among them when one answers within 1.5 seconds, their flags, and flag
  values.
- **Speed.** A command loads only the client, the runtime's contracts, and
  two domains' contracts (`@lemma/cli`, `@lemma/profiles`), never a plugin,
  and the host only for `serve`. What `pnpm lemma`, the `bin`, and the agent's shell run is
  `bin/lemma.js`: it turns on Node's compile cache, then runs the bundle in
  `dist/lemma.mjs` while every file it was built from is unchanged
  (`dist/lemma.json` lists them, with their sizes and modification times), else
  the sources, so a stale bundle never shadows them. `pnpm build` makes the
  bundle, as `pnpm check`, `pnpm test`, and `pnpm start` do, or `pnpm
  lemma:build` alone; `serve` runs the sources, whose modules the host shares,
  started as the host is (with its Node.js flags and Effect's bundle, [its
  start](../../packages/host/README.md#its-start)), and a host it starts
  elsewhere (`--detach`, a service) is given the flags. A command to a host on
  this machine takes about 80 ms from the bundle and 150 ms from the sources
  (measured on Linux, Node 24), of which Node and one call to the host take
  37 ms in any client. Most of the sources' time is loading Effect: 286 of
  their 370 modules.
