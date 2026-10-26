# Remote access

Run the host on one machine, the server. Use it from another, the client, with
the web app, the desktop app, or the CLI.

- The UI runs on the client. It talks to the host over the host's RPC socket,
  so nothing is drawn over SSH.
- The host stays on loopback. Tailscale carries it across machines over HTTPS.

Each host is the authority over its own home.

- The server's sessions, config, credentials, and tools are the server's.
- A client's own host, such as the desktop app's, is a separate host.
- A client reaches several hosts by name: its own machine's (`local`), and the
  servers it has saved (`lemma env`).

Keep the client's Lemma at the server's release. Run `lemma version` on each,
and `lemma update <version>` to match one to the other. The reasons:

- The RPC protocol changes between versions ([versioning](versioning.md)).
- A CLI that finds the host on another version says so. It asks for the host
  to be restarted from the CLI's version.
- The web app comes from the host, so it always matches.

## On the server

[Install](installation.md) a release. Then keep the host running as a user
service, so it comes back after a crash or a reboot. When it comes back, turns
a crash or a restart cut off resume, and queued prompts run on (see the
[agent plugin](../domains/agent/loop/README.md#durability)).

```sh
lemma service install          # a systemd user unit, or a launchd agent, running `lemma serve`
lemma service                  # installed, enabled, running
loginctl enable-linger $USER   # Linux: keep it running without a login session, from boot
```

- `lemma service install --print` shows the service's definition without
  writing it.
- The definition names the `lemma` command the installer links. So after an
  update, `lemma restart` runs the service on the new release. Settings ›
  About's Update does the same ([installation](installation.md#updating)).
- `lemma stop` stops a host the service runs, through the service manager.
- `lemma logs` shows what it printed.

From a checkout, `nix develop -c pnpm lemma service install` installs the
checkout's own service ([development](development.md)).

- It is named `dev-lemma`, or `dev.lemma.dev-host` in launchd. It runs beside
  an installed Lemma's service.
- It runs the checkout's home, `~/.lemma-dev`, unless `LEMMA_HOME` names
  another.
- It runs on a `node` that lives in the Nix store, which garbage collection may
  remove. On NixOS and nix-darwin, declare the service in the system
  configuration instead (`systemd.user.services`, `launchd.user.agents`). Base
  it on what `--print` shows.

Keep the transport on loopback, its default `host`. Let Tailscale serve it to
your tailnet over HTTPS. The tailnet needs HTTPS certificates turned on.

```sh
tailscale serve --bg 7433   # https://<machine>.<tailnet>.ts.net → http://127.0.0.1:7433
lemma token                 # the token clients need
```

The token is in `~/.lemma/token` (`<home>/token`), and it survives restarts.
See the [transport plugin](../domains/transport/server/README.md).

## On the client

```sh
lemma env add box https://<machine>.<tailnet>.ts.net   # asks for the token, checks it, saves it
lemma --env box status                                 # one command on the server
lemma env use box                                      # or every command, from now on
lemma env                                              # the hosts this client knows, and which answer
lemma open                                             # the web app, from the server, with the token
lemma env use local                                    # back to this machine's host
```

`env add` saves a host to `~/.lemma/environments.json`, with mode 0600. The
file's shape is `{ "default"?, "environments": { "<name>": { "url", "token" } } }`.

- `env add` calls the host with the token before it writes the file. It refuses
  a host it cannot reach, or one that rejects the token.
- Without `--token`, it takes `LEMMA_TOKEN`, or asks.
- Saving a host never makes it the default. `env use` does, and so does
  `env add --use`.

A command goes to the first host named here:

1. the host `--env` names;
2. the host `LEMMA_URL` names, with `LEMMA_TOKEN`;
3. the environment `LEMMA_ENV` names;
4. the default environment;
5. this machine's host.

A host that does not answer fails the command. The command does not fall back
to another host, which would act on the wrong machine. `serve`, `stop`, `logs`,
and `service` always act on this machine.

- **Web app.** Open `https://<machine>.<tailnet>.ts.net/?token=<token>`.
  `lemma open` prints that address and opens it.
  - The page keeps the token for that tab, and drops it from the address bar.
  - The page derives its socket from its own address. So over HTTPS it
    connects with `wss:`.
- **Desktop app.** It finds its host as the CLI does by default: `LEMMA_URL`,
  or the default environment.
  - It shows the server's page, `lemma://` links included, without starting a
    local host.
  - If the server does not answer, it says so with the URL, and offers Retry
    or Quit.
- **Paths are the server's.** Tools run on the server. Session and workspace
  directories are server paths. But the CLI's directory defaults are the
  client's current directory, so give a server path
  ([directory scope](../apps/cli/README.md#behavior)).

## Profiles

Each [profile](configuration.md#profiles) on the server is a host of its own.
It has its own port and its own token. A client reaches a profile at the
server's name and that port. So serve each profile's port as you serve the
default's, at the same number. `lemma profile` lists the profiles.

```sh
tailscale serve --bg --https=7433 7433   # the default's, at its own port too, so another profile can switch back to it
tailscale serve --bg --https=7434 7434   # https://<machine>.<tailnet>.ts.net:7434 → the profile on 7434
```

- **Web app.** Its profile menu opens another profile at the page's machine
  name and that profile's port. It starts the profile's host on the server
  when none runs there ([profiles.switcher](../domains/profiles/switcher/README.md)).
  - A host started this way runs until it is stopped.
  - `lemma --profile <name> service install` keeps a profile's host running on
    its own, as a service of its own.
- **Desktop app.** While it shows the server, it opens another profile in a
  window of its own, through the server's host.
- **CLI.** `lemma --env box --profile research status` asks the server's host
  to open the profile. Then it goes to the profile at its port.

## Security

The token is a bearer secret for the whole host. Whoever holds it can run
tools, including shell commands, as the user the host runs as.

- Keep the token in `environments.json` or the environment. A `--token`
  argument lands in shell history. Leave it out to be asked.
- Do not set the transport's `host` to `0.0.0.0` on a network you do not
  trust. It serves plain HTTP to everyone who can reach the port.
  - `tailscale serve` keeps it on your tailnet, encrypted.
  - Tailscale's access rules can narrow it to your own devices.
  - `tailscale funnel` would publish it to the internet.
- To rotate the token, delete `<home>/token` on the server and restart the
  host. Then run `lemma env add` again on each client. A `token` set in the
  transport's config takes the file's place.
