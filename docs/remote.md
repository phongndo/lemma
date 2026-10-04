# Remote access

Run the host on one machine (the server) and use it from another (the client)
with the web app, the desktop app, or the CLI. The UI runs on the client and
talks to the host over its RPC socket, so nothing is drawn over SSH. The host
stays on loopback and Tailscale carries it across machines over HTTPS.

## On the server

Build the web app once (and after updating the checkout), then run the host
under a supervisor so it comes back after a crash or a reboot. Turns a crash or
a restart cut off resume when it does, and queued prompts run on (see the
[agent plugin](../plugins/agent/README.md#durability)):

```sh
nix develop -c pnpm --filter @lemma/web build
nix develop -c pnpm lemma serve --no-open   # what the services below run
```

A systemd user service, `~/.config/systemd/user/lemma.service`:

```ini
[Unit]
Description=Lemma host

[Service]
WorkingDirectory=%h/code/lemma
# The absolute path `command -v nix` prints.
ExecStart=/run/current-system/sw/bin/nix develop -c pnpm lemma serve --no-open
Restart=on-failure

[Install]
WantedBy=default.target
```

`systemctl --user enable --now lemma` starts it, and `loginctl enable-linger $USER`
keeps it running without a login session, from boot.

A launchd agent on macOS, `~/Library/LaunchAgents/dev.lemma.host.plist`, started
with `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.lemma.host.plist`.
An agent starts when the user logs in.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.lemma.host</string>
  <key>WorkingDirectory</key><string>/Users/you/code/lemma</string>
  <key>ProgramArguments</key>
  <array>
    <string>/nix/var/nix/profiles/default/bin/nix</string>
    <string>develop</string><string>-c</string>
    <string>pnpm</string><string>lemma</string><string>serve</string><string>--no-open</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>/Users/you/Library/Logs/lemma.log</string>
  <key>StandardErrorPath</key><string>/Users/you/Library/Logs/lemma.log</string>
</dict>
</plist>
```

On NixOS and nix-darwin, the same service can be declared in the system
configuration (`systemd.user.services`, `launchd.user.agents`) instead of written
by hand.

Keep the transport on loopback (its default `host`) and let Tailscale serve it to
your tailnet over HTTPS (the tailnet needs HTTPS certificates turned on):

```sh
tailscale serve --bg 7433   # https://<machine>.<tailnet>.ts.net → http://127.0.0.1:7433
lemma token                 # the token clients need
```

The token is in `~/.lemma/token` (`<home>/token`) and survives restarts; see the
[transport plugin](../plugins/transport/README.md).

## On the client

```sh
lemma remote set https://<machine>.<tailnet>.ts.net --token <token>
lemma remote          # which host commands go to
lemma status
lemma open            # the web app, from the server, with the token
lemma remote clear    # back to a local host
```

`remote set` calls the host with the token before it writes `~/.lemma/remote.json`
(`{ "url", "token" }`, mode 0600), and refuses a host it cannot reach or that
rejects the token. Without `--token` it takes `LEMMA_TOKEN` or asks. For one
shell or script, `LEMMA_URL` and `LEMMA_TOKEN` override `remote.json`; with
neither, commands go to the local host. `lemma serve` always runs locally.

- **Web app.** Open `https://<machine>.<tailnet>.ts.net/?token=<token>`, which
  `lemma open` prints and opens. The page keeps the token for that tab and drops
  it from the address bar; it derives its socket from the page's address, so
  over HTTPS it connects with `wss:`.
- **Desktop app.** It reads the same `LEMMA_URL`/`LEMMA_TOKEN` and `remote.json`
  at start and shows the server's page, `lemma://` links included, without
  starting a local host. If the server does not answer, it says so with the URL
  and offers Retry or Quit.
- **Paths are the server's.** Tools run there, and session and workspace
  directories are server paths, while the CLI's directory defaults are the
  client's current directory: give a server path
  ([directory scope](../apps/cli/README.md#behavior)).

## Security

The token is a bearer secret for the whole host: whoever holds it can run tools,
including shell commands, as the user the host runs as. Keep it in
`remote.json` or the environment; a `--token` argument lands in shell history
(leave it out to be asked).

- Do not set the transport's `host` to `0.0.0.0` on a network you do not
  trust: it serves plain HTTP to everyone who can reach the port. `tailscale serve`
  keeps it on your tailnet, encrypted; Tailscale's access rules can narrow it to
  your own devices. `tailscale funnel` would publish it to the internet.
- Rotate the token by deleting `<home>/token` on the server and restarting the
  host, then run `lemma remote set` again on each client. A `token` set in the
  transport's config takes the file's place.
