# Automation API

Lemma exposes one execution model and one observation model:

```text
Proc    one to 64 validated, ordered Commands
Event   immutable asynchronous observation
```

A Proc is the only execution request. It contains bounded Commands such as `pane.split`, and every
Command produces a nested `lemma.command-result/v1` result. Shell automation should use `lemma proc`
and `lemma events`. Dedicated clients use the same JSON contracts over the per-user Unix endpoint.
Within this control API, `action` is reserved and defines no request, result, Proc member, or CLI
namespace in v1.

## Discover the installed contract

```sh
lemma api schema
lemma api schema --json
lemma proc DOMAIN COMMAND --help
```

The JSON form is the authoritative JSON Schema 2020-12 document for Commands, Procs, results,
subscriptions, and Events. It is embedded in the binary and requires no running daemon.

The current Command catalog is:

```text
daemon   inspect
session  start list inspect rename kill
tab      new list inspect select move rename kill
pane     split list inspect focus swap resize zoom input capture wait kill
```

## One-Command Procs

The direct CLI form builds a one-Command `lemma.proc/v1` request:

```sh
lemma proc session start work --cwd "$PWD"
lemma proc tab new --session work --title tests --focus preserve -- just test
lemma proc pane split --session work --pane 0:1 --right --focus preserve
lemma proc pane input --session work --pane 0:1 --paste 'just test' --key enter
lemma proc pane capture --session work --pane 0:1 --source recent --lines 100
lemma proc pane wait --session work --pane 0:1 --timeout 30s
```

Inside a Lemma pane, the CLI may infer omitted targets from `LEMMA_SESSION_ID`, `LEMMA_TAB_ID`, and
`LEMMA_PANE_ID`. This is a CLI convenience: the Command sent to the daemon always contains concrete
targets. Outside Lemma, provide the required Session and resource selectors.

Session names and one-based Tab positions are discovery conveniences. Persistent automation should
retain returned generational IDs. Tab and Pane IDs are Session-scoped. Pane listings expose PID
inside process metadata for lifetime observation only; PID is not a Pane selector or identity.

`lemma proc DOMAIN COMMAND` prints one `lemma.proc-result/v1` value whose single `results` entry
wraps a `lemma.command-result/v1` result. Successful Command statuses are `applied` and `no_effect`.
Other statuses include `stale`, `wrong_owner`, `conflict`, `capacity`, `unavailable`, and `failed`.
Results include the relevant stable IDs and, where applicable, the current Session revision or
terminal generation.

`pane.input` admits one ordered batch of text, opaque paste, and logical key events. Logical keys use
an optional `phase` of `press`, `repeat`, or `release`; it defaults to `press`. `pane.capture` reads a
bounded visible, recent, or last-command projection. `pane.wait` is a finite Command;
without a condition it waits for child-process completion.

## Multi-Command Procs

A Proc document contains at most 64 Commands:

```json
{
  "schema": "lemma.proc/v1",
  "on_error": "stop",
  "commands": [
    {"id":"work", "command":"session.start", "name":"work"},
    {"id":"tests", "command":"tab.new", "session":{"result":"work"},
     "focus":"preserve", "argv":["just","test"]},
    {"command":"pane.wait", "pane":{"result":"tests"}, "timeout_ms":120000},
    {"command":"session.kill", "session":{"result":"work"}}
  ]
}
```

```sh
lemma proc --file proc.json
lemma proc --stdin < proc.json
```

Before executing anything, the daemon validates and compiles the complete envelope, every Command,
all selectors, bounds, IDs, and backward-only result references. References may select the
`session`, `tab`, or `pane` field of an earlier creation result.

Commands then execute in document order through the reactor-owned Command executor. A Proc is not
atomic: completed process and PTY effects are not rolled back. `on_error` is `stop` by default or
`continue`. The `lemma.proc-result/v1` response contains one `lemma.command-result/v1` value per
executed Command and reports partial completion explicitly.

## Events

`lemma events` opens an observation stream:

```sh
lemma events --session work --pane 0:1
lemma events --session work --pane 0:1 --screen
```

A `lemma.events/v1` subscription selects one Session and optionally up to eight Panes. The stream
starts with an authoritative snapshot, then emits ordered state, process, terminal-invalidation,
optional screen, and closure Events. Screen data is opt-in, bounded current state rather than raw
PTY replay.

Observers cannot mutate state and are not terminal Attachments. A slow observer cannot block PTY
progress. Reconnecting creates a fresh snapshot; the daemon retains no Event replay log.

## Direct connections

The public integration endpoint is `/tmp/lemma-UID.sock`, owned by the current user with owner-only
permissions. Public JSON records are compact UTF-8 values terminated by LF. Each record is bounded
to 1 MiB, 4,096 JSON values, and 32 levels.

A CONTROL connection accepts only `lemma.proc/v1` requests and is lock-step: send one Proc, read its
complete result, then send the next. There is no pipelining or request-ID layer. Closing the
connection cancels its admitted Proc before another Command executes. An OBSERVE connection begins
with an Events subscription and only receives Events. Terminal attachment uses a separate private
framed protocol on the same endpoint.
