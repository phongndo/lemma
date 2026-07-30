# fiber

**A terminal multiplexer built like infrastructure.**

Fiber is an open-source, self-hosted terminal multiplexer for fast, reliable, long-lived sessions.
It is being designed so people, scripts, remote clients, and coding agents can operate the same
sessions through one typed command model—without requiring a hosted service.

## Why Fiber

- **Reliable by construction:** one authoritative daemon owns session state; queues, payloads, and
  event-loop work are bounded; client and extension failures do not end pane processes.
- **Fast by measurement:** C++23 owns the PTY, terminal, layout, composition, and output hot paths,
  with damage-based rendering backed by the pinned `libghostty-vt` library.
- **Keyboard-complete and mouse-native:** keyboard and mouse are first-class input methods that
  converge on the same commands, layout, and terminal state instead of separate feature paths.
- **Programmable:** Lua 5.5 configuration and an isolated extension host build on the same typed
  command model used by built-in keys and CLI operations. Remote and agent access are planned on
  that semantic foundation.
- **Yours to operate:** Fiber runs as a per-user daemon, keeps working when clients detach, and is
  distributed under the permissive MIT license.

The current vertical slice provides up to 64 named persistent workspaces in one per-user daemon,
each with up to 16 generationally identified windows and 64 panes distributed across them. It
supports start, attach, detach, list, window-list, and kill commands, plus release-enabled invariant
assertions, generational IDs, bounded byte queues, and an isolated Ghostty terminal adapter. The
adapter owns the canonical terminal and dirty render state, captures terminal effects into bounded
queues, and enforces a quota-tracked allocator. Lua command callbacks, remote access, agent APIs,
and durability across daemon restarts remain roadmap work. See
[`docs/architecture.md`](docs/architecture.md) for the ownership model and system invariants,
[`docs/product-contract.md`](docs/product-contract.md) for committed direction versus open product
questions, [`docs/current-capabilities.md`](docs/current-capabilities.md) for the audited present
state, [`docs/roadmap.md`](docs/roadmap.md) for milestone and release gates,
[`docs/daily-driver-contract.md`](docs/daily-driver-contract.md) for the local mux quality bar, and
[`docs/performance.md`](docs/performance.md) for measured renderer and multiplexer results. The
ordered implementation checklist is tracked in [`TODO.md`](TODO.md).

## Toolchain

On macOS, the locked Nix shell uses the LLVM 22 installation from
`brew --prefix llvm`; it does not install or select Nix's Clang. On Linux, the
shell supplies the matching Nix LLVM 22 toolchain. It also supplies CMake,
Ninja, ccache, Conan 2, Zig (required to build `libghostty-vt`), hk, Python,
actionlint, ShellCheck, and the formatters. Conan supplies GoogleTest,
GoogleMock, and Google Benchmark. CMake rejects non-LLVM C++ compilers,
requires C++23 without compiler extensions,
exports the compilation database for clangd, and promotes the strict warning
set to errors.

```sh
git submodule update --init --recursive
nix develop
just versions
just build
just test
```

The first build lets Conan 2 download/build its pinned packages and lets Zig
build the pinned Ghostty source under [`third_party/ghostty`](third_party/ghostty).
Subsequent C++ compilations use ccache.

## Commands

```sh
just configure              # Conan install + CMake/Ninja generation
just build                  # Debug build (`just profile=release build` for release)
just run                    # Show fiber usage
just demo                   # Run the scripted libghostty-vt demo
just build && ./build/debug/fiber new  # Start and attach to pane 0
just test                   # GoogleTest and GoogleMock
just bench                  # Google Benchmark
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

Pull requests and pushes to `main` run change-aware C++ correctness and
workflow-lint lanes behind one stable `CI gate` check. A scheduled extended
workflow covers all four supported host platforms and sanitizers. Benchmark
validation is temporarily local-only. See [`docs/ci.md`](docs/ci.md) for the
lane mapping, branch-protection setting, and local reproduction commands.

## Architecture

Fiber is being built as a bounded, data-oriented modular monolith: one strong core, a private
Ghostty terminal adapter, narrow platform/protocol/render boundaries, and a deferred command/event
extension API. See [`docs/product-contract.md`](docs/product-contract.md) for agreed foundation
decisions and unresolved product questions, [`docs/architecture.md`](docs/architecture.md) for the
target design, and [`docs/single-pane-runtime.md`](docs/single-pane-runtime.md) for current ownership
and limitations.

## Workspace/window mux

```sh
./build/debug/fiber new work       # start workspace "work" and attach
# Press C-b d to detach.
./build/debug/fiber new logs       # create another workspace in the same daemon
./build/debug/fiber list           # list all workspaces
./build/debug/fiber windows work   # list work's windows
./build/debug/fiber attach work    # reattach to work
./build/debug/fiber kill work      # stop one workspace
./build/debug/fiber kill-all       # stop every workspace
```

Each workspace permits one attached client, owns an ordered set of windows, and gives each pane its
own login shell, PTY, and terminal. Fiber inherits the daemon's launch environment, advertises
`xterm-256color`, and resizes pane PTYs from the active window's split layout. Workspace names
contain 1-32 ASCII letters, digits, underscores, or hyphens.
The built-in key table follows tmux defaults:

- `C-b %` splits left/right and `C-b "` splits top/bottom;
- `C-b Arrow` or `C-b o` changes focus, and `C-b ;` returns to the previous pane;
- `C-b x` closes the focused pane and `C-b z` toggles zoom;
- `C-b c` creates a window, `C-b n`/`C-b p` cycles windows, `C-b 1` through `C-b 9`
  selects windows 1-9, and `C-b 0` selects window 10;
- `C-b &` kills the active window, `C-b d` detaches, and `C-b C-b` sends a literal `C-b`.

A minimal reverse-video status row is centered at the bottom. It shows windows as
`number:foreground-process`, brackets the active window (`[1:zsh]`), automatically follows the
focused pane's foreground process, and uses `…` when the complete window list does not fit.

Launch `fiber` directly from the normal shell rather than through `nix develop` when testing
personal shell configuration.

## Editor and commit hooks

Point the editor at `clangd` from `nix develop`. [`.clangd`](.clangd) uses
`build/debug/compile_commands.json`, strict missing/unused include diagnostics,
clang-tidy diagnostics, background indexing, and inlay hints. Run
`just configure` before opening the project in an editor.

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

Fiber is released under the [MIT License](LICENSE). Third-party dependencies remain subject to
their own licenses.

## Third-party dependency

Ghostty is a Git submodule pinned to commit
`55a3e33ab26a23d75b274b23c7f76d837db00578`. Its CMake wrapper invokes Zig to
produce `libghostty-vt`; fiber links the static target. Update it deliberately
by checking out a reviewed Ghostty commit in `third_party/ghostty` and committing the
new submodule pointer.
