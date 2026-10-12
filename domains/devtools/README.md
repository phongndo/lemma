# devtools

The devtools: panels docked under the app (`mod+shift+d`) for its routes, events, channels, plugins, hooks, registries, inspectors, and the host's trace. Its contract is [`@lemma/devtools`](contract/src/index.ts) (the trace's channels) and [`@lemma/devtools/web`](contract/src/web/index.ts) (the dock's panels).

| Plugin                     | Halves     | What it does                                                               |
| -------------------------- | ---------- | -------------------------------------------------------------------------- |
| [`devtools.dock`](dock/)   | web        | The dock and its panels: provides `Devtools`                               |
| [`devtools.trace`](trace/) | host + web | Serves the host's trace (`TraceChannels`), and shows it as the Trace panel |

## Extending it

What the contract offers in each of the [five shapes](../../docs/plugins.md#the-five-shapes):

| Shape     | What the contract offers                                                             |
| --------- | ------------------------------------------------------------------------------------ |
| Add       | `DevtoolsPanels`: a panel                                                            |
| Intercept | Nothing                                                                              |
| Observe   | Nothing                                                                              |
| Call      | `Devtools`: open a panel, a snapshot of each; the trace's channels (`TraceChannels`) |
| Serve     | `Devtools`; `TraceChannels`                                                          |
