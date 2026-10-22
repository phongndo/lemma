# release

What this Lemma is, and replacing it with another release: its version and
build, whether a newer release is out on its channel, and installing one
([versioning](../../docs/versioning.md), [installation](../../docs/installation.md#updating)).
Its contract is [`@lemma/release`](contract/src/index.ts): the channels
`ReleaseChannels`, and what they answer, with what a release is (`Build`,
`Channel`) and `compareVersions`, which the `lemma` command shares.

| Plugin                        | Halves     | What it does                                                                                               |
| ----------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------- |
| [`release.updates`](updates/) | host + web | Serves `ReleaseChannels` by asking the `lemma` command; Settings › About, its check, and its Update button |

## Extending it

What the contract offers in each of the [five shapes](../../docs/plugins.md#the-five-shapes):

| Shape     | What the contract offers                                                   |
| --------- | -------------------------------------------------------------------------- |
| Add       | Nothing                                                                    |
| Intercept | Nothing                                                                    |
| Observe   | Nothing                                                                    |
| Call      | `ReleaseChannels`: `release.status`, `release.check`, and `release.update` |
| Serve     | `ReleaseChannels`, by a plugin that replaces `release.updates`             |
