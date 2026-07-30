# Process-level pseudoterminal harness plan

## Goal

Turn the current manual mux smoke into a deterministic, isolated, checked-in integration suite that
runs the real daemon, client, shell, PTY, protocol, core, terminal adapter, and renderer paths as
separate operating-system processes.

The harness must protect today's working behavior before the reactor, protocol, input, and layout are
refactored. It is test infrastructure, not a new user feature.

## Scope

The first delivery covers:

- isolated foreground daemon startup and readiness;
- real attached-client behavior inside a controlled outer PTY;
- ordinary shell input and rendered output;
- pane split/focus/close/zoom commands;
- window create/select/close commands;
- outer resize propagation;
- detach, abrupt client death, and reattach;
- child exit and workspace cleanup;
- termios and emitted outer-terminal restoration; and
- bounded timeouts, diagnostics, and cleanup for every test.

The first delivery does not redesign the client protocol, fix blocking accepted connections, add PTY
write queues, implement mouse input, or benchmark competitors. It creates the safety net needed for
those follow-up changes.

## Design decisions

### Use C++/GoogleTest and `forkpty`

The repository already uses GoogleTest and has portable `openpty`/`forkpty` branches for macOS and
Linux. Keeping the harness in C++ means it runs through the existing CMake, CTest, Clang, lint,
sanitzer, and four-platform lanes without introducing another test runner.

Child processes will `exec` small test drivers rather than calling complex C++ code directly after
`fork`. This avoids inherited GoogleTest, allocator, and sanitizer state.

### Do not use the user's daemon endpoint

Tests must never connect to `/tmp/fiber-v8-<uid>.sock`. Each test creates a unique `0700` temporary
runtime directory and socket path, checks ownership/path length, and passes that endpoint explicitly
to every spawned process.

Do not serialize tests around the production endpoint and do not call `kill-all` against a possibly
running user daemon.

### Inject runtime context instead of adding global mutable test state

Refactor internal app/client/daemon entry points to accept an immutable runtime endpoint value. The
normal `fiber` executable constructs the existing per-user default, so production CLI behavior does
not change. Test-only drivers pass a unique endpoint.

This avoids a production `FIBER_TEST_*` environment switch and makes endpoint ownership visible at
component boundaries.

### Run an owned foreground server

The production launcher double-forks and does not expose the daemon PID or a shutdown command. The
suite therefore uses a test-only server driver that calls the same internal daemon serve path in the
foreground with an injected endpoint. The fixture owns its PID/process group and can always terminate
and reap it.

The foreground server uses the same endpoint creation, listener, core reactor, PTYs, renderer, and
protocol implementation as production. Daemonization mechanics remain covered separately; they are
not the behavior this harness is intended to protect.

### Parse rendered output as terminal output

Do not assert on raw ANSI byte substrings except in diagnostics. Feed attached-client output into a
Fiber terminal adapter representing the outer 80x24 terminal, then inspect bounded plain snapshots.
This makes assertions resilient to cursor movement, damage encoding, synchronized-update wrappers,
and full versus incremental frames.

Control-command output remains plain text and can be captured through ordinary pipes.

## Proposed test architecture

```text
fiber_e2e_tests (GoogleTest parent)
  |
  +-- TemporaryRuntime (unique directory/socket/config/home)
  |
  +-- fiber_test_server <socket>       [fork + exec, owned process group]
  |      `-- daemon foreground serve -> core reactor -> shell PTYs
  |
  +-- fiber_test_cli <socket> ...      [fork + exec, pipe capture]
  |      `-- same app command parser and daemon/client libraries
  |
  `-- fiber_test_cli <socket> new ...  [forkpty + exec]
         `-- attached client in controlled 80x24 outer PTY
```

The one-line production `main` and default endpoint selection are outside the injected test drivers;
the application parser and all substantive production components remain exercised.

## Work package A — injectable endpoint and foreground serve

### Internal runtime value

- Add an internal immutable endpoint/runtime value with a validated socket path.
- Preserve the current `/tmp/fiber-v8-<uid>.sock` default for the production executable.
- Pass the endpoint through application dispatch, daemon control commands, and client attach.
- Keep socket naming/path policy in the daemon component, not core.
- Avoid globals and avoid storing borrowed path views beyond their owner lifetime.

### Foreground server entry point

- Extract the current owned-server body into an internal `daemon::serve` entry point accepting:
  - endpoint path;
  - extension config path or explicit extension enablement; and
  - foreground ownership/lifecycle options required by the test driver.
- Keep production double-fork launch as a thin caller of the same serve entry point.
- Ensure endpoint release remains exactly-once on normal return.
- Disable or isolate the extension host in mux tests so no user configuration is loaded. Extension
  process integration remains covered by existing component tests and can gain its own process test.

### Test drivers

- Add a test-only foreground server executable linked to `fiber_daemon`.
- Add a test-only CLI executable linked to `fiber_app` that injects the supplied endpoint and then
  delegates to the same application argument parser.
- Make both reject invalid arguments with nonzero status and no daemon side effects.

Likely files:

- `src/daemon/server.hpp` / `src/daemon/server.cpp`;
- `src/client/attached_client.hpp` / `src/client/attached_client.cpp`;
- `src/app/application.hpp` / `src/app/application.cpp`;
- `tests/support/server_main.cpp`;
- `tests/support/cli_main.cpp`.

This package must be a behavior-preserving refactor and should be reviewed separately from test
scenario additions if the diff becomes large.

## Work package B — reusable process and PTY support

Add test-only helpers under `tests/support/`.

### `TemporaryRuntime`

Responsibilities:

- create a unique absolute directory with `mkdtemp`;
- verify current-user ownership and `0700` permissions;
- provide bounded socket, lock, config, home, and diagnostic paths;
- provide a clean child environment (`HOME`, `XDG_CONFIG_HOME`, `ZDOTDIR`, and other shell startup
  variables as needed) so local dotfiles cannot alter test behavior;
- remove only fixture-owned files; and
- fail early if the Unix socket path cannot fit `sockaddr_un`.

### `ChildProcess`

Responsibilities:

- spawn with `fork` + `execve` and explicit argv/environment;
- create a dedicated process group;
- optionally capture stdout/stderr with nonblocking pipes;
- expose deadline-based wait and exit-status inspection;
- retain bounded trailing output for diagnostics; and
- terminate the process group, escalate from `SIGTERM` to `SIGKILL`, and reap every direct child in
  the destructor.

No destructor may wait indefinitely.

### `PtyClient`

Responsibilities:

- create an outer PTY with `forkpty` or `openpty` plus controlled session setup;
- set a deterministic 80x24 initial size before exec;
- send bounded bytes with deadline-aware partial-write handling;
- resize with `TIOCSWINSZ` and signal the client as required;
- read nonblocking output under an absolute deadline;
- feed output incrementally into an outer `vt::Terminal`;
- expose bounded plain-screen snapshots and `wait_for_screen(text, deadline)`;
- retain a bounded raw-output tail for failure diagnostics;
- inspect/compare slave termios where applicable; and
- support intentional client termination for disconnect tests.

### `ControlClient`

A thin helper around the injected CLI driver:

- run `start`, `list`, `windows`, `kill`, and `kill-all` with deadlines;
- capture exit status/stdout/stderr separately; and
- poll a bounded predicate such as “workspace reports 2 windows and 4 panes” without fixed sleeps.

## Work package C — first scenario set

Prefer a few complete scenarios over many timing-sensitive micro-scenarios. Every wait uses a
monotonic absolute deadline; fixed sleeps may only be used as small retry backoff inside a bounded
poll.

### 1. `CreatesAttachesAndRendersShellOutput`

- Start the foreground server and wait for endpoint readiness.
- Launch `new <unique-workspace>` in an 80x24 PTY.
- Send a shell-portable `printf` command with a unique marker.
- Parse rendered output through the outer terminal and wait for the marker.
- Assert control listing reports one attached workspace, one window, one pane, and 80x24.
- Detach with `C-b d` and require a successful client exit.
- Assert the workspace remains and is listed detached.

### 2. `PreservesTopologyAcrossDetachAndReattach`

- Attach and create left/right plus top/bottom splits.
- Create a second window, switch windows, exercise directional/next/previous focus, and toggle zoom.
- Poll control listings rather than sleeping until the workspace reports two windows and four total
  panes and the window listing reports three plus one.
- Detach and reattach in a new PTY.
- Require a reconstructed frame and the same topology listing.
- Close panes/windows through key commands and verify bounded topology transitions.

Do not depend on a particular account-shell prompt or foreground process name.

### 3. `AbruptClientExitDoesNotEndWorkspace`

- Attach, write a unique visible marker, then terminate only the attached client process group without
  sending detach.
- Poll until the workspace is listed detached.
- Reattach and require reconstructed visible state.
- Send another command to prove the shell remains interactive.

### 4. `OuterResizeReflowsAndResizesPanePtys`

- Attach at 80x24 and create a split.
- Resize the outer PTY to a larger valid size and wait for the workspace listing to report it.
- Run a shell-portable `stty size` marker command in the focused pane and verify expected pane-local
  dimensions without hard-coding prompt output.
- Resize temporarily below the split-tree minimum, verify the client remains attached, then restore a
  valid size and require a reconstructed frame.

### 5. `LastShellExitRemovesWorkspace`

- Start a single-pane workspace.
- Send `exit` to the login shell.
- Poll until the control listing reports no such workspace.
- Require the attached client to exit and leave terminal state restored.

### 6. `RestoresTerminalStateOnNormalExit`

- Capture relevant slave termios before the attached client enters raw mode.
- Attach and detach normally.
- Compare the post-exit termios flags/control characters with the original state.
- Feed the complete raw output to the outer terminal model and verify Fiber leaves the outer terminal
  on the primary screen with a visible cursor and disabled tracked modes where the adapter exposes
  those observations.
- Keep signal-termination restoration as a later test because production signal-safe cleanup is not
  implemented yet; document that expected gap rather than making this first PR flaky.

## Shell determinism

The daemon currently launches the account login shell rather than a test-selected shell. To keep the
suite reliable:

- give child processes an empty temporary `HOME`, `XDG_CONFIG_HOME`, and `ZDOTDIR`;
- use shell-portable commands such as `printf`, `stty size`, and `exit`;
- assert unique output markers, not prompts;
- do not assert the shell process title (`zsh`, `bash`, or `fish`);
- use generous but bounded startup deadlines on cold CI; and
- print the bounded raw and parsed screen tails when a marker is not observed.

If supported shells still cannot be isolated reliably, add an explicit internal pane-launch command
in a separate product decision; do not silently change production shell behavior only for this test.

## CMake and CI integration

- Add a separate `fiber_e2e_tests` target rather than growing `fiber_tests`.
- Add the two test-only driver targets only when `FIBER_BUILD_TESTS=ON`.
- Link `fiber_e2e_tests` to test support, `fiber_terminal`, warnings, GoogleTest, and any narrow
  platform target it directly uses.
- Make test targets depend on their driver executables.
- Supply driver paths with generated compile definitions or a generated test configuration header;
  never search `$PATH`.
- Register tests with `gtest_discover_tests` and a per-test CTest timeout.
- Label them `integration`/`pty` while keeping them in ordinary `ctest --preset debug`.
- Include the e2e target in platform and sanitizer builds.
- Run tests sequentially initially only if sanitizer/process behavior requires it; endpoint isolation
  should permit parallel execution.
- Do not weaken leak detection or blanket-disable sanitizer failures. Suppress only a demonstrated
  platform/tooling issue with a narrow documented rule.

Likely CMake shape:

```cmake
add_executable(fiber_test_server tests/support/server_main.cpp)
add_executable(fiber_test_cli tests/support/cli_main.cpp)
add_executable(
  fiber_e2e_tests
  tests/support/process.cpp
  tests/support/pty_client.cpp
  tests/e2e_mux_test.cpp
)
add_dependencies(fiber_e2e_tests fiber_test_server fiber_test_cli)
gtest_discover_tests(
  fiber_e2e_tests
  PROPERTIES TIMEOUT 30 LABELS "integration;pty"
)
```

Exact target links and path generation should follow the narrowest dependency needed by each helper.

## Failure diagnostics

Every failed scenario should report:

- scenario phase and expired deadline;
- child executable, argv, PID/process group, and exit status;
- endpoint path and whether its socket/lock existed;
- latest control-command stdout/stderr;
- bounded attached-client raw-output tail;
- bounded plain outer-screen snapshot;
- server stderr/log tail; and
- cleanup/escalation actions taken by the fixture.

Do not emit unbounded shell output into CI logs.

## Cleanup guarantees

- The fixture owns every endpoint path and child it creates.
- Test server and attached clients run in dedicated process groups.
- Normal teardown asks clients/workspaces to stop, then terminates the foreground server.
- Deadline expiry escalates boundedly to `SIGKILL`.
- Every direct child is reaped with `waitpid`.
- Removing the temporary directory happens only after server termination closes descriptors.
- Cleanup errors are attached to test diagnostics but never cause an unbounded teardown hang.

## Acceptance criteria

The harness work is complete when:

1. all six initial scenarios pass repeatedly on macOS and Linux debug builds;
2. the suite passes scheduled ASan/UBSan without orphan processes;
3. tests can run while a real user Fiber daemon and workspace are active without observing or
   changing them;
4. two e2e tests can run concurrently with different endpoints;
5. every wait and teardown path has a hard deadline;
6. a forced assertion failure produces sufficient bounded diagnostics to reproduce the phase;
7. the manual smoke item in [`../../TODO.md`](../../TODO.md) is replaced by checked automated items;
8. [`../current-capabilities.md`](../current-capabilities.md) records process-level coverage; and
9. no production CLI behavior, default socket path, or mux semantics changed as a side effect.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Local shell configuration makes output nondeterministic | Isolated environment, portable marker commands, no prompt/title assertions. |
| Fixed sleeps cause CI flakes | Predicate-based polling with monotonic deadlines and bounded backoff. |
| Double-fork daemon becomes orphaned | Test-owned foreground server driver and process-group cleanup. |
| Tests affect a user's daemon | Explicit unique endpoint injection; never use the default endpoint. |
| ANSI encoding changes break raw assertions | Parse output through the terminal adapter and assert screen state. |
| Forking a sanitizer/GoogleTest process is unsafe | Immediate `exec` of small drivers after fork. |
| Cleanup hangs after a failure | Deadline, `SIGTERM`/`SIGKILL` escalation, and guaranteed `waitpid`. |
| Endpoint injection leaks test policy into core | Immutable app/client/daemon runtime context; core remains unaware of socket paths. |
| One giant integration test obscures failures | Small scenario set sharing reusable helpers and rich phase diagnostics. |

## Commit sequence

Keep refactors and behavior tests reviewable:

1. **Inject daemon endpoint and expose foreground serve**
   - no production behavior change;
   - component tests remain green.
2. **Add process/PTY test support and isolated test drivers**
   - helper self-tests for timeout, capture, and cleanup where practical.
3. **Add basic attach/render/detach and topology/reattach scenarios**
   - establishes the primary regression gate.
4. **Add abrupt-exit, resize, child-exit, and restoration scenarios**
   - completes initial process-level coverage.
5. **Update capability audit and TODO state**
   - mark only automated, passing behavior complete.

The next production-hardening plan after this harness is the bounded nonblocking accepted-connection
state machine. One of its first tests will deliberately connect an idle peer and prove the existing
harness still observes PTY progress.
