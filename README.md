# lemma

**A terminal multiplexer built like infrastructure.**

Lemma is an open-source, self-hosted terminal multiplexer for fast, reliable, long-lived sessions.
It is being designed so people, scripts, remote clients, and coding agents can operate the same
sessions through one typed command model—without requiring a hosted service.

In mathematics, a lemma is a small proven result used to establish something larger. This project
follows the same philosophy: provide one dependable terminal primitive that people and agents can
compose into their own workflows. The core hierarchy is **session → tab → pane**. Spaces,
project/worktree workspaces, tasks, and agent runs remain extension-level concepts built from stable
core IDs rather than mandatory kernel containers.

## Why Lemma

- **Reliable by construction:** one authoritative daemon owns session state; queues, payloads, and
  event-loop work are bounded; client and extension failures do not end pane processes.
- **Fast by measurement:** C++23 owns PTYs, canonical terminal state, layout, and bounded ANSI damage
  composition; slow clients never block PTY progress and optimizations require end-to-end evidence.
- **Keyboard-complete and mouse-native:** keyboard and mouse are first-class input methods that
  converge on the same commands, layout, and terminal state instead of separate feature paths.
- **Programmable and agent-friendly:** one typed semantic model serves built-in keys, mouse, Lua 5.5,
  JSON, a same-user automation socket, and AI agents. Lemma aims for a Pi-like product shape: a small
  high-performance kernel, a complete tmux-like standard layer, and replaceable workflow packages.
- **Yours to operate:** Lemma runs as a per-user daemon, keeps working when clients detach, and is
  distributed under the permissive MIT license.

The current vertical slice provides up to 64 named persistent sessions in one per-user daemon,
each with up to 16 generationally identified tabs and 64 panes distributed across them. It
supports default entry, start, attach, detach, list, tab-list, kill, and explicit daemon shutdown,
plus dedicated help/version/errors, release-enabled invariant assertions, hierarchical generational
IDs, bounded byte queues, and an isolated Ghostty terminal adapter. The
adapter owns the canonical terminal and dirty render state, captures terminal effects into bounded
queues, and enforces a quota-tracked allocator. Lua command callbacks, first-class mouse/copy UX,
remote release validation, agent APIs, and durability across daemon restarts remain roadmap work. The
daemon-rendered ANSI path is the selected production architecture through 1.0. A checkpoint
feasibility gate proved that client terminal replication was not viable with the pinned Ghostty API;
the completed architecture review retained one authoritative daemon and thin clients. See
[`docs/architecture.md`](docs/architecture.md) for the ownership model and system invariants,
[`docs/product-contract.md`](docs/product-contract.md) for committed direction versus open product
questions, [`docs/current-capabilities.md`](docs/current-capabilities.md) for the audited present
state, [`docs/roadmap.md`](docs/roadmap.md) for milestone and release gates,
[`docs/daily-driver-contract.md`](docs/daily-driver-contract.md) for the local mux quality bar,
[`docs/core-mux-quality.md`](docs/core-mux-quality.md) for the batteries-included workflow and
measurement standard, [`docs/core-mux-phase1.md`](docs/core-mux-phase1.md) for the authoritative
kernel closeout, [`docs/performance.md`](docs/performance.md) for measured renderer and
multiplexer results, and [`docs/memory.md`](docs/memory.md) for the byte-level ownership census and
memory evidence. The
mutable execution backlog and current focus are tracked in [`TODO.md`](TODO.md).

## Toolchain

On macOS, the locked Nix shell selects Apple Clang and the Xcode SDK. It uses
Nix-provided clangd, clang-format, and clang-tidy wrappers that analyze against
Apple's SDK and libc++. On Linux, the shell supplies the
Nix LLVM 22 toolchain. It also supplies CMake, Ninja, ccache, Conan 2, Zig
(required to build `libghostty-vt`), hk, Python, actionlint, ShellCheck, and the
formatters. Conan supplies GoogleTest, GoogleMock, and Google Benchmark. CMake
accepts Clang and Apple Clang, requires C++23 without compiler extensions,
exports the compilation database for clangd, and promotes the strict warning
set to errors. The development shell adds `build/debug` to `PATH`, so the local
debug build is available as `lemma` after `just build`.

```sh
git submodule update --init --recursive
nix develop
just versions
just build
just test
```

The first build lets Conan 2 download/build its pinned packages and lets Zig
build the pinned Ghostty source under [`third_party/ghostty`](third_party/ghostty). The shell also
pins tmux and Zellij for common-workload comparison. Subsequent C++ compilations use ccache.

## Commands

```sh
just configure              # Conan install + CMake/Ninja generation
just build                  # Debug build (`just profile=release build` for release)
just run                    # Show lemma usage
just demo                   # Run the scripted libghostty-vt demo
just build && lemma new        # Start and attach to pane 0
just test                   # GoogleTest and GoogleMock
just bench                  # Google Benchmark microbenchmarks
just mux-bench              # Release Lemma/tmux/Zellij core-mux baselines
just fmt                    # Apply clang-format and nixpkgs-fmt
just fmt-check              # Verify formatting only
just lint                   # clang-tidy; every diagnostic is an error
just lsp-check              # clangd parse/diagnostic check
just lsp                    # Start clangd for an editor
just check                  # All format, lint, LSP, build, and test checks
just ci-check               # Reproduce every merge-blocking CI lane
just hooks                  # Configure and install fast commit/push hooks
just hooks-check            # Run fast and pre-push hk checks over all files
just hooks-fix              # Apply safe hk format/hygiene fixes
```

For example, use `just profile=release build` or `just profile=release bench`
for an optimized build.

## Continuous integration

Pull requests and pushes to `main` fan formatting, build/tests, clang-tidy, clangd, Linux
ASan/UBSan, Actionlint, ShellCheck, and CI contracts into isolated parallel jobs behind one stable
`CI gate` check. A
scheduled extended workflow covers all four supported host platforms and benchmark smoke. See
[`docs/ci.md`](docs/ci.md) for lane isolation, cache policy, branch protection, and local reproduction
commands.

## Architecture

Lemma is a bounded, data-oriented authoritative daemon plus thin terminal clients. The daemon owns
processes, PTYs, topology, canonical terminal truth, per-attachment view state, and ANSI composition;
clients decode physical input, write bounded render frames, and restore the outer terminal. Attach
and recovery rebuild visible state from daemon authority without terminal checkpoints. See
[`docs/product-contract.md`](docs/product-contract.md) for
agreed decisions, [`docs/architecture.md`](docs/architecture.md) for the target design,
[`docs/protocol.md`](docs/protocol.md) for current and target wire contracts, and
[`docs/single-pane-runtime.md`](docs/single-pane-runtime.md) for current ownership and limitations.

## Sessions, tabs, and panes

```sh
lemma                # create or enter session "default"
lemma new work       # start session "work" and attach
# Press C-b d to detach.
lemma new logs       # create another session in the same daemon
lemma list           # list all sessions
lemma tabs work      # list work's tabs
lemma attach work    # reattach to work
lemma kill work      # stop one session
lemma kill-all       # stop every session, keep the daemon
lemma shutdown              # show the destructive-operation warning
lemma shutdown --confirm    # confirm stopping the daemon and owned processes
lemma --help
lemma --version
```

Each session permits one attached client, owns an ordered set of tabs, and gives each pane its
own login shell, PTY, and terminal. Session, tab, pane, and attached-client references use
hierarchical generational IDs; `list` and `tabs` expose the current IDs. Session creation transports
the invoking absolute cwd and a bounded environment snapshot; all session panes inherit that launch
context. Panes advertise
`xterm-256color`, and resizes pane PTYs from the active tab's split layout. Session names
contain 1-32 ASCII letters, digits, underscores, or hyphens.
The built-in key table follows tmux defaults:

- `C-b %` splits left/right and `C-b "` splits top/bottom;
- `C-b Arrow` or `C-b o` changes focus, and `C-b ;` returns to the previous pane;
- `C-b x` closes the focused pane and `C-b z` toggles zoom;
- `C-b c` creates a tab, `C-b n`/`C-b p` cycles tabs, `C-b 1` through `C-b 9`
  selects tabs 1-9, and `C-b 0` selects tab 10;
- `C-b &` kills the active tab, `C-b d` detaches, and `C-b C-b` sends a literal `C-b`.

A minimal reverse-video status row is centered at the bottom. It shows tabs as
`number:foreground-process`, brackets the active tab (`[1:zsh]`), automatically follows the
focused pane's foreground process, and uses `…` when the complete tab list does not fit.

When testing personal shell configuration, leave `nix develop` and invoke
`./build/debug/lemma` directly so the development shell does not affect the result.

## Editor and commit hooks

Point the editor at `clangd` from `nix develop`. On macOS, its wrapper uses the
Xcode resource headers alongside the generated Apple Clang compilation database.
[`.clangd`](.clangd) uses `build/debug/compile_commands.json`, strict missing/unused
include diagnostics, clang-tidy diagnostics, background indexing, and inlay hints.
Run `just configure` before opening the project in an editor.

[`hk.pkl`](hk.pkl) keeps pre-commit fast: it fixes staged C++/Nix/just
formatting and runs staged-file hygiene, actionlint, ShellCheck, and CI contract
checks only when their inputs change. Pre-push adds the slower incremental
debug build, tests, clang-tidy, and clangd validation tier. Install both hooks
after the debug tree is configured:

```sh
just hooks
```

Run commits and pushes from `nix develop` so every hook tool is on `PATH`. Safe
fixes are re-staged automatically while unstaged work is preserved. Bypass hk
for one command only when necessary with `HK=0 git commit` or `HK=0 git push`.

## License

Lemma is released under the [MIT License](LICENSE). Third-party dependencies remain subject to
their own licenses.

## Third-party dependency

Ghostty is a Git submodule pinned to commit
`55a3e33ab26a23d75b274b23c7f76d837db00578`. Its CMake wrapper invokes Zig to
produce `libghostty-vt`; Lemma links the static target. Update it deliberately
by checking out a reviewed Ghostty commit in `third_party/ghostty` and committing the
new submodule pointer.
