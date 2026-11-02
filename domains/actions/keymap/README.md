# actions.keymap

Runs actions on their keys. It listens for keys on the page and runs the first
`Actions` item ([`@lemma/actions`](../contract/src/actions.ts)) whose keys
match and whose `when` holds, with the user's `bindings` in place of the
action's own keys. Every app-wide shortcut, the palette's `mod+k` included, is
such an item. So with this plugin off none of them works, and Settings ›
Keyboard says so. It provides nothing and adds to no slot.

```jsonc
{ "plugins": { "actions.keymap": { "config": { "bindings": ["palette.open = mod+k, mod+shift+p", "shell.toggle-sidebar ="] } } } }
```

| Config     | Default | What it does                                                                                                                                                                                     |
| ---------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bindings` | unset   | One line per action, `<action id> = <keys>`, replacing that action's own keys; nothing after `=` unbinds it (`parseBindings` reads them). Settings › Keyboard (`actions.keys-page`) writes these |

## Behavior

- **Dialogs and questions.** While a dialog is open (`Dialogs.current`), or the
  host waits on a question no view has claimed (`Interactions.claim`), only
  `global` actions run. A view that claims a question and shows it outside any
  dialog holds no keys back.
- **A value first.** An action with `input` is not run directly: its keys run
  `ActionIds.palette` with its id, so the palette asks for the value. With
  `actions.palette` off, the action runs with no value.
- **Held keys.** Modifiers held alone for 200 ms tell each action they would
  run with one more key (`onHold`, with that binding). The wait lets a
  shortcut pressed at once pass first. The action hears `undefined` once a
  modifier changes, the window loses focus, or a key pressed with them runs
  nothing. A key that runs an action keeps the hold, so `mod+1` then `mod+2`
  show throughout. A modifier already handled (a quick-pick list's ⌘, from
  `createQuickHold` in `@lemma/web/quick-pick`) reaches no action.
- **Keys left alone.** A key already handled (`defaultPrevented`), typed while
  composing text with an input method, or typed with AltGr is left alone.
  Windows reports AltGr as Ctrl+Alt, so AltGr+A types ą rather than running
  `mod+alt+a`. A key that runs an action has its default prevented.
- **Replacing it.** Settings › Keyboard and the palette's shortcut hints read
  and write the `bindings` config of the plugin with this id (`KEYMAP_PLUGIN`,
  `overridesFrom`). So a replacement takes the id `actions.keymap`, and reads
  `bindings` as `parseBindings` and `keysFor` do, or they show keys it does not
  use.
