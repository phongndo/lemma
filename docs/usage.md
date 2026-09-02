# Using Lemma

Lemma is currently a development project. Run it from a checkout rather than treating it as a
stable installed tool.

## Build and run

The supported development environment is Nix:

```sh
nix develop
just run
just run pane split --right

# Equivalent convenience command inside the development shell:
lemma
lemma pane split --right
```

`just run [args...]` is the canonical development entry point. The development shell's `lemma`
command delegates to the same runner: both configure only when required and incrementally build
only the `lemma` target. For bare `lemma`, `lemma new`, and `lemma start`, the runner supplies its
invocation directory when `--cwd` is omitted; other arguments reach `build/dev/lemma` unchanged.
The `dev` profile uses optimization, debug symbols, enabled invariants, and frame pointers.

Each checkout or git worktree receives a stable private development runtime namespace. Rebuilding
the binary automatically replaces an older daemon in that namespace, so development commands do
not connect to an installed Lemma daemon or to another worktree. Release builds remain explicit for
packaging and production behavior:

```sh
nix build .#lemma
nix run .#lemma
```

The Nix shell supplies the pinned Ghostty source. A non-Nix build must initialize it first:

```sh
git submodule update --init --depth 1 third_party/ghostty
```

## Configuration

Lemma loads `$XDG_CONFIG_HOME/lemma/init.lua` (or `~/.config/lemma/init.lua`) in an isolated Lua
host. A valid file compiles into immutable native settings before the daemon accepts Sessions. An
invalid file is rejected as one transaction and the daemon continues with built-in defaults.

```lua
local lemma = require("lemma")

lemma.setup({
  input = { preset = "none", prefix = false },
  terminal = { scrollback_lines = 100000 },
  ui = { status_line = false },
  launch = {
    default_cwd = "/work/project",
    default_program = { "/bin/sh", "-l" },
  },
})
lemma.keymap.set("normal", "Cmd-d", "split_left_right")
lemma.keymap.del("normal", "Cmd-c")
```

Validate configuration without changing a daemon:

```sh
lemma config check
lemma config check ./init.lua
```

See [Configuration runtime](extensions.md) for key syntax, commands, bounds, trust, and failure
behavior.

## Sessions, tabs, and panes

Lemma's hierarchy is:

```text
Session -> Tab -> Pane
```

A per-user daemon owns sessions, child processes, PTYs, and terminal state. Creating the first
Session starts the daemon. The daemon exits when its final Session ends. Detaching a client leaves
pane processes running; killing the daemon does not.

```sh
lemma                              # create a numbered Session and attach
lemma new [NAME]                   # create a Session and attach
lemma start [NAME]                 # create a detached Session
lemma attach [NAME]
lemma list                         # alias: lemma ls
lemma inspect NAME
lemma rename OLD NEW
lemma kill NAME
```

An omitted `attach` target selects the most recently active detached Session. Creation accepts an
initial directory, an exit policy, and an exact command:

```sh
lemma new work --cwd "$PWD"
lemma start tests -- just test
lemma new report --hold -- ./produce-report
```

Arguments after `--` execute directly without shell interpretation. When `--cwd` or an exact
command is omitted, the configured launch default applies; without configuration Lemma uses the
account home and login shell. Pane processes normally keep running without `--hold`; `--hold`
retains the Pane and its terminal after the process exits.

The complete structured Session, Tab, and Pane interface is under `lemma proc`:

```sh
lemma proc tab new --session work --title tests -- just test
lemma proc pane split --session work --pane 0:1 --right
lemma proc pane capture --session work --pane 0:1
lemma proc pane split --help
```

Inside a Lemma pane, omitted command targets resolve from the current Session, Tab, and Pane IDs.
Explicit selectors can address another resource. Use `lemma proc DOMAIN COMMAND --help` for the exact
installed grammar. Every invocation returns a Proc envelope containing one nested Command result.

## Interactive controls

The default prefix is `C-b`.

| Binding | Effect |
| --- | --- |
| `C-b C-b` | Send a literal `C-b` |
| `C-b d` | Detach |
| `C-b %` / `C-b "` | Split left-right / top-bottom |
| `C-b h/j/k/l` | Focus a neighboring Pane |
| `C-b H/J/K/L` | Swap with a neighboring Pane |
| `C-b C-h/j/k/l` or `C-b M-h/j/k/l` | Move a divider by one cell |
| `C-b m` | Enter persistent resize mode; use arrows or `h/j/k/l`, then Escape or Enter |
| `C-b x` | Close the focused Pane |
| `C-b z` | Toggle Pane zoom |
| `C-b c` | Create a Tab |
| `C-b n/p` | Select the next / previous Tab |
| `C-b 0-9` | Select a numbered Tab |
| `C-b &` | Close the active Tab |
| `C-b P/N` | Move the active Tab left / right |
| `C-b R/r` | Rename the Session / active Tab |
| `C-b [` | Enter copy mode |
| `C-b /` / `C-b ?` | Search forward / backward in copy mode |

The mouse can focus panes, select tabs, create a tab from the status `+`, reorder tabs by dragging,
resize split dividers, select terminal text, and scroll canonical history. Mouse reports are sent to
the child when its active terminal modes request them. Visible pane and built-in editor cursors use
a block shape; pane-requested blinking is preserved.

## Copy mode

Copy mode uses Vim-shaped movement over Ghostty-owned history. `h/j/k/l`, arrows, word movement,
line movement, and page movement update the copy cursor. `v`, `V`, and `C-v` start character, line,
and block selection. `y` or Enter copies the selection and leaves copy mode.

`Super-c` and `Ctrl-Shift-c` copy the current copy-mode or mouse selection. Lemma currently uses
bounded OSC 52 output for user-authorized clipboard writes; it has no native clipboard provider.

## Automation

Use one Proc for one or more ordered Commands and Events for an observation stream:

```sh
lemma proc pane input --session work --pane 0:1 --paste 'just test' --key enter
lemma proc pane wait --session work --pane 0:1 --until-prompt --timeout 2m
lemma proc --file proc.json
lemma events --session work --pane 0:1 --screen
lemma api schema --json
```

See [Automation API](api.md) for the control model. `lemma skill` prints the version-matched
single-file guide intended for coding agents.

## Current limits

- A Session accepts one attached controller at a time.
- Session, process, terminal, and history state survive detach, not daemon death or reboot.
- Kitty graphics and the Glyph Protocol are disabled.
- Lemma uses `xterm-256color` and does not yet ship a dedicated terminfo entry.
