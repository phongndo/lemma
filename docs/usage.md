# Using Lemma

Lemma is currently a development project. Run it from a checkout rather than treating it as a
stable installed tool.

## Build and run

The supported development environment is Nix:

```sh
nix develop
just run
just run split --right

# Equivalent convenience command inside the development shell:
lemma
lemma split --right
```

`just run [args...]` is the canonical development entry point; the shell's `lemma` alias uses the
same runner. For bare `lemma`, `lemma new`, and `lemma start`, it supplies the invocation directory
when `--cwd` is omitted. See [Development](development.md#workflow) for build profiles and caching.

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

Use [Configuration](configuration.md) to customize keys, terminal history, status UI, launch
defaults, and Lua commands. Start with its [complete example](configuration.md#api) and validate
without changing a daemon:

```sh
lemma config check
lemma config check ./init.lua
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

`lemma --help` groups commands under **Basic**, **Resources**, **Automation**, and **Other**.
Use `lemma COMMAND --help` (or `lemma help COMMAND`) for behavior, options, and examples.

Basic pane commands are available directly:

```sh
lemma split --right                         # open another terminal beside this pane
lemma send --paste 'just test' --key enter   # type into the running program and press Enter
lemma wait --contains 'Ready' --timeout 10s  # wait for matching terminal content
lemma capture                              # print the current screen as text
lemma capture --source recent --lines 100   # include bounded scrollback
lemma focus --pane 1:1
lemma zoom --on                             # fill the tab with this pane; --off restores it
lemma resize right 5                        # move the divider five cells to the right
lemma swap --pane 0:1 1:1
```

`send` sends one ordered batch of text, paste, or key presses to an existing Pane; it does not launch
a process directly or press Enter automatically. `capture` prints terminal text, not an image, and
does not send input or move the viewport. `wait` blocks until the Pane's process exits or a specified
condition matches, with a default timeout of 30 seconds. Any process exit satisfies a conditionless
wait; use `--exit-code 0` to require success. `--until-prompt` requires shell-integration markers.
Terminal conditions can match existing state; use `--after-generation` when newer state is required.
Waiting for an entire Session or Tab to end is not supported.

Inside a Lemma pane, omitted command targets resolve from the current Session and Pane IDs. Outside
Lemma, provide `--session NAME|ID` and `--pane ID` (or a positional Pane ID). Explicit selectors
can address another resource; Pane IDs are Session-scoped.

`split` prints the new Pane ID, `capture` prints captured text, and the other basic pane commands
succeed quietly. Failures go to stderr. Their exit status is 0 for success, 1 for execution failure,
or 2 for invalid arguments/requests. Add `--json` to any basic pane command for the canonical Proc
result, including IDs, generations, and failure details. Output behavior does not depend on whether
stdout is a terminal or a pipe.

The complete structured interface is also available through resource commands:

```sh
lemma tab new --session work --title tests -- just test
lemma pane split --session work --pane 0:1 --right
lemma pane capture --session work --pane 0:1
lemma pane --help
```

Resource commands and their `lemma proc DOMAIN COMMAND` forms print the same Proc envelope with one
nested Command result. The basic verbs use that same execution path; `send` maps to `pane.input`.
The interactive `:` prompt continues to use the resource grammar described below.

## Interactive controls

The default prefix is `C-b`.

| Binding | Effect |
| --- | --- |
| `C-b C-b` | Send a literal `C-b` |
| `C-b d` | Detach |
| `C-b :` | Open the interactive command line |
| `C-b ~` | Open the bounded message history viewer |
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

The replaceable statusline extension supplies the normal top row. `C-b s` opens the shipped
[session manager](extensions.md#shipped-user-layer).

The status row is the only persistent interaction chrome. An active resize, copy, search, log, or command mode
replaces normal Session and Tab status with one flat, left-aligned mode row; mode labels and prompts
never cover pane content. Normal status returns immediately when the interaction ends.

## Command line

`C-b :` replaces the status row with an empty `:` prompt. Up recalls the most recently submitted
command, and Up/Down continue through the bounded per-attachment history. Tab completes command
words and live Session names, Enter runs the command, and Escape, `C-c`, or `C-g` cancels. Arrows,
Home/End, `C-a`/`C-e`, Backspace/Delete, `C-u`, and `C-w` edit the line. The row stays otherwise
empty while editing. After Enter, a failure closes the prompt and replaces the status row with a
left-aligned error message. The message clears after 1.5 seconds or on the next keyboard or mouse
input, immediately restoring Session and Tab status. Repeated failures restart the timeout.

Each Attachment retains the latest 16 status messages. `C-b ~` opens a timestamped, read-only
full-pane view with the newest messages at the bottom while the status row reads `LOG`. Use `k`/Up
and `j`/Down, PageUp/PageDown,
`g`/Home, and `G`/End to navigate; use `q`, Escape, Enter, `C-c`, or `C-g` to leave.

Command history is separately limited to 16 entries and is memory-only by default. See
[`history.file`](configuration.md#api) for persistence and failure behavior.

The grammar is the human, mutating subset of `lemma proc`: omit `proc` and omit selectors for the
current Session, Tab, and Pane. Quotes and backslashes group literal text without shell expansion.
For example:

```text
pane split --right
tab new --title tests
pane resize --left 5
switch work
```

`switch SESSION` moves the live client connection to an existing detached Session without
restarting the client. `attach SESSION` and `session switch SESSION` are aliases; none of these
creates a nested Session. Session names are completed from the daemon's live Session registry.
Native commands and registered Lua commands share command-line discovery and completion. Lua
commands run asynchronously in the isolated host and submit ordinary Procs. See
[Custom commands](configuration.md#custom-commands) for registration, invocation, bounds, and failure
behavior.

Command and copy-search editors are native; the shipped statusline extension presents their prompts. With
`ui.status_line = false`, their bindings are intentionally inert rather than capturing invisible
input.

## Copy mode

Copy mode uses Vim-shaped movement over Ghostty-owned history. Its status row includes the current
history position as `COPY [current/total]`. `h/j/k/l`, arrows, word movement, line movement, and page
movement update the copy cursor. `v`, `V`, and `C-v` start character, line, and block selection. `y`
or Enter copies the selection and leaves copy mode. Search replaces that row with the editable
`/query` or `?query` prompt; progress and feedback return to the same row without covering the pane.

`Super-c` and `Ctrl-Shift-c` copy the current copy-mode or mouse selection. Lemma currently uses
bounded OSC 52 output for user-authorized clipboard writes; it has no native clipboard provider.

## Automation

Use one Proc for one or more ordered Commands and Events for an observation stream:

```sh
lemma send --json --session work --pane 0:1 --paste 'just test' --key enter
lemma wait --json --session work --pane 0:1 --until-prompt --timeout 2m
lemma proc --file proc.json
lemma events --session work --pane 0:1 --screen
lemma api schema --json
```

See [Automation API](api.md) for the control model. `lemma skill` prints a version-matched,
Agent Skills-compatible `SKILL.md` intended for coding agents. Save it under a directory named
`lemma` in the skill location used by the agent host. For example, Pi discovers the shared location
below:

```sh
mkdir -p ~/.agents/skills/lemma
lemma skill > ~/.agents/skills/lemma/SKILL.md
```

Repeat the export after updating Lemma so the installed guide stays matched to the binary.

## Current limits

- A Session accepts one attached controller at a time.
- Session, process, terminal, and history state survive detach, not daemon death or reboot.
- Kitty graphics and the Glyph Protocol are disabled.
- Lemma uses `xterm-256color` and does not yet ship a dedicated terminfo entry.
