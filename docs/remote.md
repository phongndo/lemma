# Remote access

Run the host on one machine (the server) and use it from another (the client)
with the web app, the desktop app, or the CLI. The UI runs on the client and
talks to the host over its RPC socket, so nothing is drawn over SSH. The host
stays on loopback and Tailscale carries it across machines over HTTPS.

Each host is the authority over its own home: the server's sessions, config,
credentials, and tools are the server's, and a client's own host (the desktop
app's, say) is a separate one. A client reaches several hosts by name: its own
machine's (`local`) and the servers it has saved (`lemma env`).

Keep the client's Lemma at the server's release (`lemma version` on each, and
`lemma update <version>` to match one): the RPC protocol changes between
versions ([versioning](versioning.md)), and a CLI that finds the host on
another one says so and asks for it to be restarted from its version. The web
app comes from the host, so it always matches.

## On the server

[Install](installation.md) a release, then keep the host running as a user
service, so it comes back after a crash or a reboot. Turns a crash or a restart
cut off resume when it does, and queued prompts run on (see the [agent
plugin](../domains/agent/loop/README.md#durability)):

```sh
lemma service install          # a systemd user unit, or a launchd agent, running `lemma serve`
lemma service                  # installed, enabled, running
loginctl enable-linger $USER   # Linux: keep it running without a login session, from boot
```

`lemma service install --print` shows the definition without writing it. It
names the `lemma` command the installer links, so after an update `lemma
restart` (or Settings › About's Update) runs the service on the new release
([installation](installation.md#updating)). From a checkout, `nix develop -c
pnpm lemma service install` runs the checkout's home, `~/.lemma-dev`, unless
`LEMMA_HOME` names another, on a `node` that lives in the Nix store and may be
garbage-collected: on NixOS and nix-darwin, declare that service in the system
configuration instead (`systemd.user.services`, `launchd.user.agents`) from
what `--print` shows. `lemma stop` stops a host the service runs through
the service manager; `lemma logs` shows what it printed.

Keep the transport on loopback (its default `host`) and let Tailscale serve it to
your tailnet over HTTPS (the tailnet needs HTTPS certificates turned on):

```sh
tailscale serve --bg 7433   # https://<machine>.<tailnet>.ts.net → http://127.0.0.1:7433
lemma token                 # the token clients need
```

The token is in `~/.lemma/token` (`<home>/token`) and survives restarts; see the
[transport plugin](../domains/transport/server/README.md).

## On the client

```sh
lemma env add box https://<machine>.<tailnet>.ts.net   # asks for the token, checks it, saves it
lemma --env box status                                 # one command on the server
lemma env use box                                      # or every command, from now on
lemma env                                              # the hosts this client knows, and which answer
lemma open                                             # the web app, from the server, with the token
lemma env use local                                    # back to this machine's host
```

`env add` calls the host with the token before it writes `~/.lemma/environments.json`
(`{ "default"?, "environments": { "<name>": { "url", "token" } } }`, mode 0600),
and refuses a host it cannot reach or that rejects the token. Without `--token`
it takes `LEMMA_TOKEN` or asks. Saving one never makes it the default: `env use`
does (or `env add --use`). A command goes to the host `--env` names, else the one
`LEMMA_URL` (with `LEMMA_TOKEN`) names, else the environment `LEMMA_ENV` names,
else the default, else this machine's. A host that does not answer fails the
command rather than falling back to another, which would act on the wrong
machine. `serve`, `stop`, `logs`, and `service` always act on this machine.
A `remote.json` that an older `lemma remote set` wrote is read as the default
environment `remote` until environments.json exists; the first `lemma env`
change writes it there.

- **Web app.** Open `https://<machine>.<tailnet>.ts.net/?token=<token>`, which
  `lemma open` prints and opens. The page keeps the token for that tab and drops
  it from the address bar; it derives its socket from the page's address, so
  over HTTPS it connects with `wss:`.
- **Desktop app.** It finds its host as the CLI does by default: `LEMMA_URL`, or
  the default environment, shows the server's page, `lemma://` links included,
  without starting a local host. If the server does not answer, it says so with
  the URL and offers Retry or Quit.
- **Paths are the server's.** Tools run there, and session and workspace
  directories are server paths, while the CLI's directory defaults are the
  client's current directory: give a server path
  ([directory scope](../apps/cli/README.md#behavior)).

## Profiles

Each [profile](configuration.md#profiles) on the server is a host of its own,
at its own port, with its own token. A client reaches one at the server's name
and that port, so serve each profile's port as you serve the default's, at the
same number (`lemma profile` lists them):

```sh
tailscale serve --bg --https=7433 7433   # the default's, at its own port too, so another profile can switch back to it
tailscale serve --bg --https=7434 7434   # https://<machine>.<tailnet>.ts.net:7434 → the profile on 7434
```

- **Web app.** Its profile menu opens another profile at the page's machine
  name and that profile's port, starting its host on the server when none
  runs there ([profiles.switcher](../domains/profiles/switcher/README.md)).
  A host started so runs until it is stopped; `lemma --profile <name>
  service install` keeps one running on its own, as a service of its own.
- **Desktop app.** Showing the server, it opens another profile in a window of
  its own, through the server's host.
- **CLI.** `lemma --env box --profile research status` asks the server's host
  to open the profile, and goes to it at its port.

## Security

The token is a bearer secret for the whole host: whoever holds it can run tools,
including shell commands, as the user the host runs as. Keep it in
`environments.json` or the environment; a `--token` argument lands in shell
history (leave it out to be asked).

- Do not set the transport's `host` to `0.0.0.0` on a network you do not
  trust: it serves plain HTTP to everyone who can reach the port. `tailscale serve`
  keeps it on your tailnet, encrypted; Tailscale's access rules can narrow it to
  your own devices. `tailscale funnel` would publish it to the internet.
- Rotate the token by deleting `<home>/token` on the server and restarting the
  host, then run `lemma env add` again on each client. A `token` set in the
  transport's config takes the file's place.
