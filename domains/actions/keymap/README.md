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
  that the question dialog shows it, only `global` actions run. A question a
  view shows in place, as the Providers page shows its logins', holds no
  keys back.
- **A value first.** An action with `input` is not run directly: its keys run
  `ActionIds.palette` with its id, so the palette asks for the value. With no
  action at that id (`actions.palette` off), it runs with no value.
- **Handled keys.** A key already handled (`defaultPrevented`), or typed while
  composing text with an input method, is left alone. A key that runs an
  action has its default prevented.
- **Replacing it.** Settings › Keyboard and the palette's shortcut hints read
  and write the `bindings` config of the plugin with this id (`KEYMAP_PLUGIN`,
  `overridesFrom`), so a replacement takes the id `actions.keymap` and reads
  `bindings` as `parseBindings` and `keysFor` do, or they show keys it does
  not use.
