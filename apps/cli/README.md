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
- **Connections.** A command that makes a call or two does so over HTTP, and
  fails at once (exit 3) when no host answers. One that watches the host
  (`run`, `events`, `do`, `login`, `channels open`) holds `@lemma/client`'s
  reconnecting WebSocket, as the web app does; its first connection failing
  fails it the same way. When that connection drops, a client makes again
  what the host makes again when a plugin reloads: the calls declared
  repeatable, and streams. So `run` and `events` go on once it is back,
  saying on stderr that it dropped and came back: their streams open again
  where they were, and `run` sends its prompt again with its request id. The
  session log's events show once each and none is skipped; live output
  while the connection was down (the agent's deltas, which `--json` prints
  too) is lost, as when a slow client falls behind, and `events` may print
  the questions still open again. `do` and `login` fail (exit 3), since a
  command or a login made again could run twice or ask anew: run the command
  again. `channels open`, which prints a stream as it is sent, ends, as it
  does when its plugin reloads. A command gives up after 16 attempts in a
  row to reconnect fail, about a minute with the default backoff (counted
  rather than timed, so a laptop that wakes from sleep tries as long), and
  exits 3. Reconnects go to the address the command started with: a
  restarted host is there again on its default port (7433) with its saved
  token; finding one that moved is later work.
- **Channels.** Sessions, turns, models, the workspace, and commands are
  reached through the channels their plugins serve (`sessions.*`, `agent.*`,
  `llm.*`, `workspace.*`, `files.search`, `commands.*`), typed by their
  declarations in `@lemma/contracts`; the host's own calls (plugins, config,
  the web app's rows, questions) and its event stream are the runtime's. A
  channel whose plugin is off fails `NotFound`, naming the channel. While the
  host is still starting, a command fails `Unavailable` naming what it called
  (exit 3, as for a host it cannot reach); a subsystem's own `Unavailable`
  (no plugin searches files, say) names what it concerns and exits 1. A
  prompt that the agent's reload cut off the host makes again on the
  replacement, with its request id, so it is never placed twice, as it does
  any call that only reads. A login or a command its plugin's reload cut off
  fails `Withdrawn` (exit 1), since making it again would ask its questions
  anew or run it twice: run the command again.
- **Questions.** While `run`, `do`, `events --questions`, or `login` watches
  the host, it is offered the host's questions, such as a login's API key or
  a tool asking to confirm. `--answer <value>` answers them in order;
  otherwise `--questions ask` prompts at the terminal (the default when
  stdin is one), `dismiss` fails them, and `ignore` (the default otherwise,
  so an agent never answers for the person) leaves them to another client
  and prints how to answer from the CLI. The host holds a question only for
  clients that answer questions: a command that asks, dismisses, or was
  given answers, and always `do` and `login`. One that ignores them, or only
  watches (`events` without `--questions`, `channels open`), holds none: a
  question with no answering client connected goes on to fail as
  unanswerable, which a tool asking for approval takes as a no, and one an
  answering client holds is shown. Once no answering client is connected,
  the host waits 15 seconds for one to come back
  ([`interactionGraceMs`](../../plugins/transport/README.md)) before the
  question fails, so one asked during a longer drop is lost. Within that,
  questions still open reach a command again once it is back (the host sends
  them to each client that subscribes), an answer given while it was down is
  sent then, and a prompt for one that closed meanwhile closes.
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
  `run` that fails once its prompt may be placed (it gave up on the
  connection, say, or a read of the session failed) prints the id it chose
  (without `--json`; with it, the error has it as `requestId`): running it
  again with that id, not a new one, rejoins the turn. When the agent stops
  with the prompt and nothing answers for `agent.prompt` once its reload is
  over, it may still resume the prompt, so `run` exits 3, as when it gives up
  on the connection.
- **Following a turn.** `run --follow` opens `agent.activity` and the
  session's `sessions.log` before it sends the prompt, and shows the turn
  that places it from the prompt on: the log says what the turn did, in
  order, and the activity fills in the step in flight. Output the log has
  not reached yet waits for it, so one step's answer never prints after the
  next one's; what the activity lost, the log's answer has. Retried with the
  same `--request-id` while its turn runs, it shows what the turn has said so
  far (from the log and `agent.view`), then the rest; so too after a dropped
  connection, with the log from the last event shown. With `--json` it prints
  the turn's `agent.activity` elements and its `sessions.log` events (as
  `appended` elements) as the channels send them, and the host's notices;
  a step's deltas that its answer in the log overtook are left out, since the
  answer has them.
- **Events.** `lemma events` follows the host's own events (notices,
  questions, plugin, channel, and UI changes) and the bundled subsystems'
  streams: `agent.activity`, `sessions.changes`, `llm.changes`, and
  `commands.changes`. `--session <id>` keeps that session's turns and changes
  and adds its `sessions.log` from now on. A stream that its plugin's reload
  withdrew is opened again at once, one that is not served once the host
  lists it, and each once a dropped connection is back, as every client
  follows a stream (`follow` in
  [`@lemma/client`](../../packages/client/src/follow.ts)); any other ending
  stops it. Opened again, a stream says `subscribed` anew, and the log goes
  on from the last event printed; the host's own events while the
  connection was down are lost. With `--json`, each line is
  `{"from", "element"}`: `from` is `host` for the host's own events, else the
  channel, and `element` is what it sent.
- **Machine-readable output.** With `--json`, results are the contract shapes
  (`HostInfo`, `SessionInfo`, `SessionEvent`, …) on stdout, and failures are
  `{"error": {"code", "message", "subject"?}}` on stderr. Streams
  (`run --follow --json`, `events --json`, `channels open`) are NDJSON, and
  `run --follow` ends with a `{"type": "result", …}` line. `channels open`
  prints at its reader's pace (an unread pipe, a paused `less`), holding what
  the host sent meanwhile in memory: the host's stream never waits for it,
  since a command reads the host's streams only through `@lemma/client`, which
  never holds the connection back
  ([`makeHostRpc`](../../packages/client/src/rpc.ts) says why).
- **Directory scope.** `session list`, `session new`, `run new`, and
  `workspace` default to the directory the command runs in (`--all` lists
  every session). With a remote host that directory is this machine's: give
  the host's path with `--cwd` (`--path` for `workspace`).
