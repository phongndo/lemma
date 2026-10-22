# credentials

Stored API keys and OAuth tokens, and how signing in for them looks. Its contract is [`@lemma/credentials`](contract/src/credentials.ts).

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

## Signing in

A plugin whose sign-in goes through a browser draws it as the others do, so a model provider's and an MCP server's look the same: on the host, the page a browser lands on when the sign-in sends it back (`signInPage`, in [`page.ts`](contract/src/page.ts)); in a web half, from `@lemma/credentials/web` ([`web.tsx`](contract/src/web.tsx)), where this page's browser is (`browserPlace`) and the field that takes the address a browser on another device landed on (`SignInPaste`).
