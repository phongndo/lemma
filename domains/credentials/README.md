# credentials

Stored API keys and OAuth tokens. Its contract is [`@lemma/credentials`](contract/src/credentials.ts).

| Plugin                               | Halves | What it does                                                |
| ------------------------------------ | ------ | ----------------------------------------------------------- |
| [`credentials.file`](file/README.md) | host   | Stores them in `~/.lemma/auth.json`: provides `Credentials` |

## Extending it

What the contract offers in each of the [five shapes](../../docs/plugins.md#the-five-shapes):

| Shape     | What the contract offers                                                           |
| --------- | ---------------------------------------------------------------------------------- |
| Add       | Nothing                                                                            |
| Intercept | Nothing                                                                            |
| Observe   | Nothing                                                                            |
| Call      | `Credentials`: get, set, remove a provider's credential                            |
| Serve     | `Credentials`: a plugin providing it (a keychain, say) replaces `credentials.file` |
