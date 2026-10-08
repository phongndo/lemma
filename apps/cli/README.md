# @lemma/cli

The `lemma` command: everything the web app can do, from a shell, for people
and for agents. `lemma serve` runs the host in the terminal; every other
command is a client of a running host. `lemma --help` lists the commands,
flags, and exit codes.

```sh
nix develop -c pnpm lemma status
nix develop -c pnpm lemma run new "fix the failing test" --follow
nix develop -c pnpm lemma inspect <session> --filter "is:error" --json
nix develop -c pnpm lemma kernel hooks                  # each hook's chain, in run order
nix develop -c pnpm lemma inspectors tools.registered   # what a host plugin lets you look into
nix develop -c pnpm lemma channels open ticker.prices   # a host plugin's stream, one JSON line per element
```

The CLI and the web app share their logic through `@lemma/contracts` (the
trajectory, the filter language, prompt diffs, the kernel and inspector views),
so the two show the same records and accept the same queries.

## Behavior

- **Attach only.** Commands go to the host `LEMMA_URL` or `remote.json` names
  ([remote access](../../docs/remote.md)), else the local one. With none, a
  command fails with `NoHost` rather than starting one: a second host would
  break the sessions store's single writer.
- **Channels.** Sessions, turns, models, the workspace, and commands are
  reached through the channels their plugins serve (`sessions.*`, `agent.*`,
  `llm.*`, `workspace.*`, `files.search`, `commands.*`), typed by their
  declarations in `@lemma/contracts`; the host's own calls (plugins, config,
  the web app's rows, questions) and its event stream are the runtime's. A
  channel whose plugin is off fails `NotFound`, naming the channel. While the
  host is still starting, a command fails `Unavailable` naming what it called
  (exit 3, as for a host it cannot reach); a subsystem's own `Unavailable`
  (no plugin searches files, say) names what it concerns and exits 1. A
  prompt, a login, or a command that its plugin's reload withdrew is made
  again once the channel is served (for at most 30 seconds): a prompt with
  its request id, so it is never placed twice; a login or a command from the
  start, its questions asked anew.
- **Questions.** While `run`, `do`, `events`, or `login` watches the host,
  it is offered the host's questions, such as a login's API key or a tool
  asking to confirm. `--answer <value>` answers them in order; otherwise
  `--questions ask` prompts at the terminal (the default when stdin is one),
  `ignore` leaves them to another client and prints how to answer from the CLI
  (the default otherwise, so an agent never answers for the person), and
  `dismiss` fails them.
- **Logins.** `lemma login` prints a sign-in's link and one-time code on lines
  of their own, so they copy whole into a browser on any machine. With a
  browser here (a display, not over SSH) it opens the link, and, when it
  answers questions at the terminal, Enter opens a code's page. A browser on another machine cannot reach the host's callback
  and ends on a page that fails to load; the prompt asks for that page's
  address. Ctrl+C cancels the login on the host, which otherwise outlives the
  command (exit 130).
- **Busy sessions.** `run` waits for the next turn by default; `--steer` joins
  the running turn, and `--when-busy reject` fails `Busy`, as the
  [agent](../../plugins/agent/README.md#busy-sessions) defines. Each `run`
  sends a request id (`--request-id` to choose it), so retrying with the same
  id reports the turn that placed the prompt rather than placing it twice. A
  `run` whose connection fails once the prompt may be sent prints the id it
  chose (without `--json`), and exits 3: a dropped connection is not reopened.
- **Following a turn.** `run --follow` opens `agent.activity` and the
  session's `sessions.log` before it sends the prompt, and shows the turn
  that places it from the prompt on: the log says what the turn did, in
  order, and the activity fills in the step in flight. Output the log has
  not reached yet waits for it, so one step's answer never prints after the
  next one's; what the activity lost, the log's answer has. Retried with the
  same `--request-id` while its turn runs, it shows what the turn has said so
  far (from the log and `agent.view`), then the rest. With `--json` it prints
  the turn's `agent.activity` elements and its `sessions.log` events (as
  `appended` elements) as the channels send them, and the host's notices;
  a step's deltas that its answer in the log overtook are left out, since the
  answer has them.
- **Events.** `lemma events` follows the host's own events (notices,
  questions, plugin, channel, and UI changes) and the bundled subsystems'
  streams: `agent.activity`, `sessions.changes`, `llm.changes`, and
  `commands.changes`. `--session <id>` keeps that session's turns and changes
  and adds its `sessions.log` from now on. A stream that its plugin's reload
  withdrew is opened again at once, and one that is not served once the host
  lists it, as every client follows a stream (`follow` in
  [`@lemma/client`](../../packages/client/src/follow.ts)); any other ending
  stops it. With `--json`, each line is `{"from", "element"}`: `from` is `host`
  for the host's own events, else the channel, and `element` is what it
  sent.
- **Machine-readable output.** With `--json`, results are the contract shapes
  (`HostInfo`, `SessionInfo`, `SessionEvent`, …) on stdout, and failures are
  `{"error": {"code", "message", "subject"?}}` on stderr. Streams
  (`run --follow --json`, `events --json`, `channels open`) are NDJSON, and
  `run --follow` ends with a `{"type": "result", …}` line. `channels open`
  waits while its reader is behind (an unread pipe, a paused `less`), so the
  host stops producing for it rather than output piling up in memory; a reader
  that stays behind for more than a few seconds drops the connection, which
  the RPC client reads in order, and the command ends unavailable (exit 3).
- **Directory scope.** `session list`, `session new`, `run new`, and
  `workspace` default to the directory the command runs in (`--all` lists
  every session). With a remote host that directory is this machine's: give
  the host's path with `--cwd` (`--path` for `workspace`).
