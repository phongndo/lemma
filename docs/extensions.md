# Configuration runtime

Lemma loads user configuration from Lua in a separate bounded host process. The daemon never
executes Lua while routing input, processing PTY bytes, or composing frames. A successful load is
validated and compiled into one immutable native configuration generation before any Session can
use it.

This is the initial extension-runtime surface. It covers the portable mux baseline shared by tmux,
Zellij, WezTerm, Screen, and kitty: input policy, terminal history, native status UI, and launch
defaults. Custom commands, events, jobs, and UI surfaces are not exposed yet.

## Location and validation

The default file is:

```text
$XDG_CONFIG_HOME/lemma/init.lua
```

If `XDG_CONFIG_HOME` is unset or not absolute, Lemma uses:

```text
$HOME/.config/lemma/init.lua
```

`LEMMA_CONFIG` selects another file. Lemma does not start the host when the default file is absent.
Validate a file without starting or changing the daemon:

```sh
lemma config check
lemma config check ./init.lua
```

The host has a 64 MiB Lua allocation bound. Startup must produce a complete configuration within two
seconds, the encoded native draft is bounded to 64 KiB, and at most 240 effective bindings are
accepted. A syntax error, runtime error, unknown option, invalid binding, capacity failure, timeout,
or host crash rejects the complete generation. Daemon startup then continues with built-in
configuration.

Configuration and modules execute with the user's operating-system permissions. Only load code you
trust. `require()` searches beside `init.lua` before the ordinary Lua module path.

## API

```lua
local lemma = require("lemma")
local keymap = lemma.keymap
local ctx = lemma.context

lemma.setup({
  input = {
    preset = "none",
    prefix = false,
  },
  terminal = {
    scrollback_lines = 100000,
  },
  ui = {
    status_line = false,
  },
  launch = {
    default_cwd = "/work/project",
    default_program = { "/bin/sh", "-l" },
  },
})

ctx.set("resize", {
  label = " RESIZE ",
  lifetime = "persistent",
  unbound = "consume",
})

keymap.set("normal", "Cmd-d", "split_left_right")
keymap.set("normal", "M-r", ctx.push("resize"))
keymap.set("resize", "q", ctx.pop())
keymap.del("normal", "Cmd-c")
```

All `lemma.setup()` groups and fields are optional:

- `input.preset` is `"default"` or `"none"`. The default preset seeds ordinary context and binding
  declarations; `none` retains the routing-context slots but starts with no bindings. Both are
  validated and compiled through the same path. Selecting a preset resets its prefix to `C-b` or no
  prefix respectively, and `input.prefix` in the same table can override it.
- `input.prefix` is any valid key chord, or `false` for no prefix. A configured prefix enters the
  one-shot `prefix` context. Direct bindings in `normal` do not require a prefix.
- `terminal.scrollback_lines` is a nonnegative integer up to 10,000,000, or `false` for the native
  memory-bounded default.
- `ui.status_line` enables or disables the native one-row status line. Disabling it gives the full
  viewport to panes.
- `launch.default_cwd` is empty or an absolute path. It applies when creation does not specify
  `--cwd`.
- `launch.default_program` is an exact argv array, not a shell command. It is bounded to 64
  arguments and 4 KiB including terminators. An empty array selects the account login shell.
  Explicit creation arguments after `--` take precedence.

`lemma.keymap.set(CONTEXT, KEY, ACTION[, DISPOSITION])` replaces or adds one binding. `ACTION`
may be a command string or one of these native-policy descriptors:

```lua
lemma.context.push("resize")                   -- push another routing context
lemma.context.push("prefix", { defer = true })  -- retain trigger bytes for replay
lemma.context.pop()                             -- pop the current transient context
lemma.keymap.replay()                           -- replay a deferred trigger
lemma.keymap.send("Home")                       -- encode a physical key for the pane
```

`DISPOSITION` applies to command strings: `"retain"` is the default and `"base"` returns from
transient contexts before invocation. `lemma.keymap.del(CONTEXT, KEY)` removes one seeded or
previously configured binding. Repeated declarations use the last declaration.

`lemma.context.push()` and `lemma.context.pop()` change routing state only. Semantic interactions
still use commands such as `enter_copy_mode`, `copy_leave`, `begin_rename_tab`, and
`rename_cancel` so Core remains authoritative for their state and invariants.

`lemma.context.set(CONTEXT, OPTIONS)` configures `label`, `lifetime` (`"persistent"` or
`"one_shot"`), unbound behavior (`"forward"`, `"consume"`, `"replay"`, or `"retry"`), and whether
the context `preempts` another Attachment interaction. `retry` leaves a one-shot context and routes
the unmatched key through its base context.

The bounded routing contexts are:

- `normal`: ordinary pane input;
- `prefix`: the conventional one-shot command context;
- `resize`: resize policy;
- `copy`: copy navigation and selection;
- `copy_go`: the default `g` one-shot grammar;
- `copy_search`: editable search query input;
- `copy_searching`: an in-progress bounded search;
- `rename`: session and tab prompt editing.

Core owns the operations and interaction state, but not their keys. Resize transitions, copy
navigation/search, rename editing, prefix replay, and pane key rewrites all come from the compiled
configuration. An explicit `preset = "none"` configuration can recreate the complete shipped
policy. After publication the router cannot distinguish a seeded binding from a user binding.

Key names use printable ASCII or structured names. Modifiers are `C-`, `S-`, `M-`/`A-`, and
`Super-`/`Cmd-`/`Command-`/`Win-`/`D-`. Named keys are `Space`, `Enter`, `Tab`, `Backspace`,
`Escape`, `Up`, `Down`, `Left`, `Right`, `Home`, `End`, `Insert`, `Delete`, `PageUp`, `PageDown`,
and `F1` through `F12`. Super/Cmd and other non-terminal chords work for structured keyboard
clients; legacy byte-stream terminals cannot report chords they do not encode.

Commands are:

```text
detach
split_left_right split_top_bottom
resize_left resize_right resize_up resize_down
focus_left focus_right focus_up focus_down focus_next focus_previous
close_pane toggle_zoom
enter_copy_mode enter_copy_search_forward enter_copy_search_backward copy_selection
copy_cancel_or_leave copy_leave copy_cancel_selection
copy_move_left copy_move_down copy_move_up copy_move_right
copy_word_left copy_word_right copy_word_end
copy_line_start copy_line_first_nonblank copy_line_end
copy_history_top copy_history_bottom
copy_viewport_top copy_viewport_middle copy_viewport_bottom
copy_half_page_up copy_half_page_down copy_page_up copy_page_down
copy_visual_character copy_visual_line copy_visual_block copy_swap_endpoint
copy_repeat_search copy_reverse_search copy_cancel_search copy_commit_search copy_query_backspace
rename_cancel rename_commit rename_backspace rename_delete
rename_cursor_left rename_cursor_right rename_cursor_home rename_cursor_end
rename_clear rename_delete_word
create_tab next_tab previous_tab close_tab
begin_rename_session begin_rename_tab move_tab_left move_tab_right
swap_pane_left swap_pane_right swap_pane_up swap_pane_down
select_tab_0 select_tab_1 select_tab_2 select_tab_3 select_tab_4
select_tab_5 select_tab_6 select_tab_7 select_tab_8 select_tab_9
```

## Failure and lifetime

The daemon owns the compiled configuration after publication. The Lua VM remains resident in its
host process for the daemon lifetime, but it is not consulted by input routing. Closing the daemon's
private lease closes the host. Invalid configuration never partially changes the native map.
