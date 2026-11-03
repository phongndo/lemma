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
- **This lemma:** `version`, which says what installed it, and `update`, which
  installs another release that way: with the installer the release carries,
  or the package manager that installed it (`src/installers.ts`;
  [updating](../../docs/installation.md#updating)).
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
  ([remote access](../../docs/remote.md)). A target that is set but unusable
  fails; it never falls back to another host. A command that needs a host and
  finds none fails `NoHost` (exit 3); only `serve` and the desktop app start
  hosts.
- **Which profile.** A command goes to the
  [profile](../../docs/configuration.md#profiles) `--profile` names, else
  `LEMMA_PROFILE`'s, else the default. `serve`, `stop`, `logs`, `token`,
  `config`, and `trust` act on that profile's home. `service` installs a
  service per profile (`lemma-<name>`). On another machine, the host there
  opens the profile (`profiles.open`). Environments belong to the home, whatever
  the profile. `profile` lists the profiles, `profile create` makes one, and
  `profile remove` deletes one, asking first.
- **One host per home.** The host holds `<home>/host.lock`, so a second one
  fails at once, naming the first. `serve --detach` returns once the host
  listens. `stop` asks the host what stopping cuts off (`cli.in-progress`) and
  asks you first; without a terminal it refuses unless `--force`. A host the
  desktop app started is the app's to stop. A service's host stops through its
  service manager. `restart` stops the host as `stop` does, then starts it on
  this lemma, for the same project and port. `logs` reads
  `<home>/logs/host.log`.
- **A plugin's command runs on the host.** It survives a dropped connection
  for `cli.registry`'s `resumeGraceMs`, and the CLI rejoins it, so its output
  shows once and it never runs twice. The CLI gives up after 16 failed
  reconnects in a row, about a minute (exit 3). It then says how to rerun
  safely when the command offers a way (`run`'s `--request-id`). Ctrl+C
  cancels the command on the host. A command whose plugin stops or reloads
  meanwhile fails `Withdrawn`.
- **Connections.** One-off calls go over HTTP. A command that watches the host
  (`events`, `channels open`, every plugin's command) holds `@lemma/client`'s
  reconnecting WebSocket, as the `cli` client (`Host.Clients`). While the host
  is starting, a command fails `Unavailable` (exit 3).
- **Questions.** `--questions` says what a plugin's command does with the
  questions its work asks: `ask` at the terminal (the default with one),
  `dismiss`, or `ignore` (the default otherwise, so an agent never answers for
  the person). `--answer <value>` answers them in order. Answer a form with its
  fields as JSON: `lemma answer <id> '{"title": "Add forms"}'`.
  `lemma questions` lists them with their types. With no answering client
  connected, the host holds a question for 15 seconds
  ([`interactionGraceMs`](../../domains/transport/server/README.md)).
- **Machine-readable output.** `--json` prints contract shapes on stdout, and
  failures as `{"error": {"code", "message", "subject"?, "rerun"?}}` on
  stderr. Streams (`run --follow --json`, `events --json`, `channels open`)
  are NDJSON, the result last. JSON is the default under an agent
  (`LEMMA_AGENT`, or Claude Code's, Gemini CLI's, Codex's, or Cursor's
  variable) and with `LEMMA_OUTPUT=json`. `--text` or `LEMMA_OUTPUT=text`
  prints text. A pipe alone keeps text. `--quiet` prints only the ids, one per
  line. `--fields a,b` keeps those fields of each object.
- **Exit codes.** 0 ok; 1 the host refused the request or the work failed; 2 a
  usage error, an unknown command included; 3 no host, unreachable, connection
  lost, or still starting; 130 interrupted.
- **Directory scope.** A plugin's command receives the client's directory.
  With a host on another machine, give a server path (`--cwd`, `--path`).
- **Pages.** `open` shows a page in the desktop app when it runs here on the
  same host (`<home>/desktop.json`), else in the browser, else prints the
  address.
- **Completion.** `lemma completion bash|zsh|fish` prints a script that asks
  `lemma __complete` for the next word. It offers the host's plugins' commands
  when the host answers within 1.5 seconds.
- **Speed.** A command loads the client and the runtime's and two domains'
  contracts (`@lemma/cli`, `@lemma/profiles`), never a plugin. Only `serve`
  loads the host, and it runs the sources, started as the host is
  ([its start](../../packages/host/README.md#its-start)). `bin/lemma.js` runs
  the bundle `dist/lemma.mjs` while every file it was built from is unchanged
  (`dist/lemma.json`), else the sources, so a stale bundle never shadows them.
  `pnpm build` or `pnpm lemma:build` makes the bundle. A command to a local
  host takes about 80 ms from the bundle and 150 ms from the sources.
