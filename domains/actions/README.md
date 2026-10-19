# actions

What a person does with keys and the palette. Its contract is [`@lemma/actions`](contract/src/actions.ts).

| Plugin                            | Halves | What it does                                         |
| --------------------------------- | ------ | ---------------------------------------------------- |
| [`actions.keymap`](keymap/)       | web    | Runs actions on their keys, as its config binds them |
| [`actions.palette`](palette/)     | web    | The command palette, searched as you type            |
| [`actions.keys-page`](keys-page/) | web    | Settings › Keyboard                                  |

## Extending it

What the contract offers in each of the [five shapes](../../docs/plugins.md#the-five-shapes):

| Shape     | What the contract offers                                                                                                          |
| --------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Add       | `Actions` (an action, with its default keys), `PaletteSources` (a list the palette searches, and a search of its own: the host's) |
| Intercept | Nothing: rebinding is the keymap's config                                                                                         |
| Observe   | Nothing                                                                                                                           |
| Call      | Run an action by id (`slots.get(Actions, id)?.run()`)                                                                             |
| Serve     | Nothing                                                                                                                           |
