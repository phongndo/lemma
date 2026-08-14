# Foundational mux operations

## Scope

This runbook describes the frozen F0–F4 local foundation and its in-progress F5 validation: one
per-user daemon, named sessions, tabs, panes, one attached client per session, private attach
protocol 1.0, and daemon-owned terminal state.
It does not promise mouse operation, public automation, multiple viewers, reboot persistence, or
custom remote transport. See [`current-capabilities.md`](current-capabilities.md) for
the complete shipped/deferred inventory.

## Start, inspect, attach, and stop

```sh
lemma                    # create or enter `default`
lemma new work           # create or reuse `work`, then attach
lemma start work         # create detached
lemma attach work
lemma list
lemma list work
lemma tabs work
lemma kill work          # stop one session and its panes
lemma kill-all           # stop every session, keep daemon lifecycle explicit
lemma shutdown           # warning only
lemma shutdown --confirm # stop daemon and every owned session
```

Session names contain 1–32 ASCII letters, digits, underscores, or hyphens. The daemon endpoint is
`/tmp/lemma-private-1.0-<uid>.sock` with a sibling lock; the listener is owner-only. A second attach
to an already attached session fails as busy. Detach preserves pane processes, but daemon shutdown,
`kill`, and `kill-all` deliberately stop them. Daemon death and reboot are not persistence guarantees.

## Built-in controls

The fixed prefix is `C-b`.

| Action | Binding |
|---|---|
| Detach | `C-b d` |
| Split left/right or top/bottom | `C-b %`, `C-b "` |
| Focus direction | `C-b` then arrow |
| Focus next / previous | `C-b o`, `C-b ;` |
| Close focused pane | `C-b x` |
| Toggle zoom | `C-b z` |
| Enter copy mode | `C-b [` |
| Create tab | `C-b c` |
| Next / previous tab | `C-b n`, `C-b p` |
| Select tab 0–9 | `C-b 0` … `C-b 9` |
| Close active tab | `C-b &` |

Copy mode uses arrows, `h`/`j`/`k`/`l`, `b`/`w`, `0`/`$`, `g`/`G`, and `C-u`/`C-d`
for navigation. The status row distinguishes navigation, selection, search, and failure states;
the nonblinking copy cursor and selected range remain visibly highlighted. `Space` or `v` begins
extending the tracked selection, `/` and `?` enter a bounded literal search, `n`/`N` repeat it,
and `q` or `Escape` leaves. `Enter` or `y` formats the selection and emits one bounded,
user-initiated OSC 52 standard-clipboard write before leaving. The outer terminal may still deny
OSC 52 according to its own clipboard policy.

Closing a tab immediately reindexes the remaining display positions, and numeric selection follows
the displayed positions. Closing a final pane removes its tab; closing the final tab ends its
session. One top status row is reserved, so a single pane in an 80x24 outer terminal receives
80x23 cells. Very small layouts are
suspended until a valid resize arrives rather than being partially applied.

## Bounds and failure behavior

- Up to 64 sessions, 16 tabs per session, 64 panes per session/tab, and 4,096 panes daemon-wide are
  admitted by the current hierarchy.
- Private attach dimensions are 1–500 columns by 1–200 rows; malformed or incompatible peers receive
  a bounded typed disconnect when output progress permits.
- Input messages are at most 8 KiB. One pane's ordered terminal-response/input queue is at most
  1,114,112 bytes, with a 128 MiB daemon aggregate.
- One attached render transaction is viewport-derived, at least 64 KiB, 35,204,096 bytes at the
  declared maximum geometry, and capped at 64 MiB. It is sent as ordered ANSI chunks of at most
  4 MiB. A client gets at most 64 KiB/32 write attempts per reactor turn; all clients share 256 KiB
  per turn.
- An attached transaction that makes no progress for 5 seconds, or remains incomplete for 30 seconds, is
  disconnected. Pane processes and canonical terminal state remain owned by the daemon.
- A reconnect, resize, active-tab change, or lag repair uses a complete redraw generation. There is
  no unbounded render replay log.

Capacity is a normal rejected outcome, not permission to partially mutate topology. If a client
reports a private protocol mismatch, stop old daemon/client binaries and restart one matching Lemma
version; the protocol intentionally does not downgrade.

## Terminal cleanup and recovery

Normal detach, startup rejection, session exit, daemon loss, EOF, and handled `SIGINT`, `SIGTERM`,
`SIGHUP`, or `SIGQUIT` restore termios and the outer cursor/alternate-screen/paste/focus/keyboard/
mouse/synchronized-update modes enabled by the client. If a process is forcibly killed with
`SIGKILL`, the process cannot run cleanup; reset the outer terminal with its emulator's reset action
or `stty sane` from a usable shell.

A stale socket should normally be resolved by the daemon lock/ownership checks. Before manually
removing `/tmp/lemma-private-1.0-<uid>.sock*`, verify that no matching daemon is alive; removing a live
endpoint makes its sessions unreachable and is not a supported recovery mechanism.

## F5 validation and retained evidence

Run the finite smoke in the default Nix development shell so all compatibility applications are the
locked versions:

```sh
nix develop --command scripts/ci/f5 smoke
```

Run the complete finite gate (format, clang-tidy, release component/process tests, allocation audit,
real application matrix, repeated stress, 1,000 lifecycle cycles, P1/P4/P16/PMAX evidence, unchanged
regression budgets, and the combined ASan/UBSan suite) with:

```sh
nix develop --command scripts/ci/f5 extended
```

Every generated raw report/log is named `build/release/f5-*`. `build/` is intentionally untracked;
archive the complete set together because Git provenance includes both the HEAD and dirty-worktree
flag.

For a focused tracing-off performance-remediation distribution without running the other F5 lanes:

```sh
python3 benchmarks/mux_benchmark.py \
  --mode profiles --multiplexer lemma --repetitions 30 \
  --output build/release/perf-profiles-30.json
python3 benchmarks/mux_benchmark.py \
  --mode comparison --multiplexer lemma --repetitions 30 --allow-workload-failures \
  --output build/release/perf-process-30.json
./build/release/lemma_benchmarks \
  --benchmark_min_time=0.2s --benchmark_repetitions=10 \
  --benchmark_out=build/release/perf-microbenchmarks-10.json --benchmark_out_format=json
python3 benchmarks/check_regression.py \
  --micro-report build/release/perf-microbenchmarks-10.json \
  --process-report build/release/perf-process-30.json \
  --profile-report build/release/perf-profiles-30.json \
  --output build/release/perf-regression-budget.json
```

Run each command sequentially on the reviewed host; concurrent benchmark commands invalidate latency
comparison. A failed unchanged-budget evaluation must remain failed even if the targeted metric
improved.

The 24-hour runs are deliberately separate, so a finite gate cannot accidentally imply that a long
soak happened:

```sh
nix develop --command scripts/ci/f5-soak release 86400 300
nix develop --command scripts/ci/f5-soak sanitizers 86400 300
```

As of August 11, 2026, these 24-hour release and ASan/UBSan soaks are **unfinished**. Short harness
qualification is not a substitute. F5 and the foundational completion gate must remain open until
both completed JSON reports, with requested and elapsed duration at least 86,400 seconds, are
retained and reviewed.
