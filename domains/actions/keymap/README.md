# actions.keymap

Runs actions on their keys. It listens for keys on the page and runs the first
`Actions` item ([`@lemma/actions`](../contract/src/actions.ts)) whose keys
match and whose `when` holds, with the user's `bindings` in place of the
action's own keys. Every app-wide shortcut, the palette's `mod+k` included,
is such an item, so with this plugin off none of them works (Settings ›
Keyboard says so). Requires `Slots`, `Dialogs` (`@lemma/frame`), and
`Interactions`; provides nothing and adds to no slot.

```jsonc
{ "plugins": { "actions.keymap": { "config": { "bindings": ["palette.open = mod+k, mod+shift+p", "shell.toggle-sidebar ="] } } } }
```

| Config     | Default | What it does                                                                                                                                                                                     |
| ---------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bindings` | unset   | One line per action, `<action id> = <keys>`, replacing that action's own keys; nothing after `=` unbinds it (`parseBindings` reads them). Settings › Keyboard (`actions.keys-page`) writes these |

## Behavior

- **Dialogs and questions.** While a dialog is open (`Dialogs.current`), or
  the host waits on a question no view has claimed (`Interactions.claim`), so
  that the question dialog shows it, only `global` actions run. A view that
  claims a question and shows it in place, outside any dialog, holds no keys
  back; one that shows it in a dialog of its own (the Providers page's logins)
  is a dialog like any other.
- **A value first.** An action with `input` is not run directly: its keys run
  `ActionIds.palette` with its id, so the palette asks for the value. With no
  action at that id (`actions.palette` off), it runs with no value.
- **Held keys.** Modifiers held down alone for a moment (200 ms, so a
  shortcut pressed at once passes first) tell each action they would run with
  one more key (`onHold`, with that binding), as pressing it would choose: the
  first in order for each binding, held back as above. It hears again
  (`undefined`) once a modifier changes, the window loses focus, or a key
  pressed with them runs nothing (`mod+c`); one that runs an action keeps the
  hold, so `mod+1` then `mod+2` show throughout. A modifier already handled
  is held for something else: a quick-pick list showing (`createQuickHold`
  in `@lemma/web/quick-pick`, a popover's menu) marks ⌘ handled for its own
  `⌘1`, so no action hears it.
- **Handled keys.** A key already handled (`defaultPrevented`), typed while
  composing text with an input method, or typed with AltGr (which Windows
  reports as Ctrl+Alt: AltGr+A types ą, not `mod+alt+a`) is left alone. A key
  that runs an action has its default prevented.
- **Replacing it.** Settings › Keyboard and the palette's shortcut hints read
  and write the `bindings` config of the plugin with this id (`KEYMAP_PLUGIN`,
  `overridesFrom`), so a replacement takes the id `actions.keymap` and reads
  `bindings` as `parseBindings` and `keysFor` do, or they show keys it does
  not use.
