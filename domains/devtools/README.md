# devtools

The devtools: panels docked under the app (`mod+shift+d`) for its routes, events, channels, plugins, hooks, registries, and inspectors. Its contract is [`@lemma/devtools`](contract/src/index.ts).

| Plugin                   | Halves | What it does                                 |
| ------------------------ | ------ | -------------------------------------------- |
| [`devtools.dock`](dock/) | web    | The dock and its panels: provides `Devtools` |

## Extending it

What the contract offers in each of the [five shapes](../../docs/plugins.md#the-five-shapes):

| Shape     | What the contract offers                     |
| --------- | -------------------------------------------- |
| Add       | `DevtoolsPanels`: a panel                    |
| Intercept | Nothing                                      |
| Observe   | Nothing                                      |
| Call      | `Devtools`: open a panel, a snapshot of each |
| Serve     | `Devtools`                                   |
