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
```

The CLI and the web app share their logic through `@lemma/contracts` (the
trajectory, the filter language, prompt diffs, the kernel and inspector views),
so the two show the same records and accept the same queries.

## Behavior

- **Attach only.** Commands go to the host `LEMMA_URL` or `remote.json` names
  ([remote access](../../docs/remote.md)), else the local one. With none, a
  command fails with `NoHost` rather than starting one: a second host would
  break the sessions store's single writer.
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
  id reports the turn that placed the prompt rather than placing it twice.
- **Machine-readable output.** With `--json`, results are the contract shapes
  (`HostInfo`, `SessionInfo`, `SessionEvent`, …) on stdout, and failures are
  `{"error": {"code", "message", "subject"?}}` on stderr. Streams
  (`run --follow --json`, `events --json`) are NDJSON, and `run --follow` ends
  with a `{"type": "result", …}` line.
- **Directory scope.** `session list`, `session new`, `run new`, and
  `workspace` default to the directory the command runs in (`--all` lists
  every session). With a remote host that directory is this machine's: give
  the host's path with `--cwd` (`--path` for `workspace`).
