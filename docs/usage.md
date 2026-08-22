# Using Lemma

Lemma is currently a development project. Run it from a checkout rather than treating it as a
stable installed tool.

## Build and run

The supported development environment is Nix:

```sh
nix develop
just build
just run
```

`just build` and `just run` use the release profile. Use `just profile=debug build` and
`just profile=debug run` for a debug build. Debug and release binaries share the same per-user
daemon endpoint; run `just kill` before switching profiles.

The Nix shell supplies the pinned Ghostty source. A non-Nix build must initialize it first:

```sh
git submodule update --init --depth 1 third_party/ghostty
```

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

Arguments after `--` execute directly without shell interpretation. Pane processes normally keep
running without `--hold`; `--hold` retains the Pane and its terminal after the process exits.

The complete structured Session, Tab, and Pane interface is under `lemma action`:

```sh
lemma action tab new --session work --title tests -- just test
lemma action pane split --session work --pane 0:1 --right
lemma action pane capture --session work --pane 0:1
lemma action pane split --help
```

Inside a Lemma pane, omitted Action targets resolve from the current Session, Tab, and Pane IDs.
Explicit selectors can address another resource. Use `lemma action DOMAIN OP --help` for the exact
installed grammar.

## Interactive controls

The default prefix is `C-b`.

| Binding | Action |
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
the child when its active terminal modes request them.

## Copy mode

Copy mode uses Vim-shaped movement over Ghostty-owned history. `h/j/k/l`, arrows, word movement,
line movement, and page movement update the copy cursor. `v`, `V`, and `C-v` start character, line,
and block selection. `y` or Enter copies the selection and leaves copy mode.

`Super-c` and `Ctrl-Shift-c` copy the current copy-mode or mouse selection. Lemma currently uses
bounded OSC 52 output for user-authorized clipboard writes; it has no native clipboard provider.

## Automation

Use one Action for one operation, a Procedure for a bounded dependent sequence, and Events for an
observation stream:

```sh
lemma action pane input --session work --pane 0:1 --paste 'just test' --key enter
lemma action pane wait --session work --pane 0:1 --until-prompt --timeout 2m
lemma proc procedure.json
lemma events --session work --pane 0:1 --screen
lemma api schema --json
```

See [Automation API](api.md) for the control model. `lemma skill` prints the version-matched
single-file guide intended for coding agents.

## Current limits

- A Session accepts one attached controller at a time.
- Session, process, terminal, and history state survive detach, not daemon death or reboot.
- Kitty graphics and the Glyph Protocol are disabled.
- Lua configuration infrastructure exists, but registered settings, callbacks, keymaps, and UI are
  not connected to the user path.
- Lemma uses `xterm-256color` and does not yet ship a dedicated terminfo entry.
