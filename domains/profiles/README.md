# profiles

The other Lemmas on a machine: each profile is a home of its own, with its own
plugins, config, look, threads, and logins, served by a host of its own, as a
browser's profiles are. Where they live and how a host or client picks one is
the runtime's (`@lemma/contracts/profiles`, and
[Configuration](../../docs/configuration.md#profiles)), decided before any
plugin runs; this domain lists and makes them (`@lemma/profiles/local`, Node
only), and is how a client reaches one from another. Its contract is
[`@lemma/profiles`](contract/src/profiles.ts).

| Plugin                                    | Halves     | What it does                                                                                                                                                                                                 |
| ----------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`profiles.switcher`](switcher/README.md) | host + web | Lists the machine's profiles, opens one (starting its host), makes, renames, stops, and deletes one; the web half switches between them once there is more than one, and manages them in Settings › Profiles |

## Extending it

What the contract offers in each of the [five shapes](../../docs/plugins.md#the-five-shapes):

| Shape     | What the contract offers                                                                                                                                                                                                                                                                                                                                                                 |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add       | Nothing                                                                                                                                                                                                                                                                                                                                                                                  |
| Intercept | Nothing                                                                                                                                                                                                                                                                                                                                                                                  |
| Observe   | Nothing                                                                                                                                                                                                                                                                                                                                                                                  |
| Call      | `ProfileChannels` from a client: `profiles.list`, `profiles.open` (a token crosses it: `secret`), `profiles.create`, `profiles.rename`, `profiles.set-avatar`, `profiles.stop`, `profiles.remove`; `profileAddress` and `profilePage` say where a client reaches the profile opened, `profileTitle` what to call one, and `profileNameFor` a new one's name from what it is to be called |
| Serve     | `ProfileChannels`: a plugin serving them (one that starts hosts another way, say) replaces `profiles.switcher`'s host half                                                                                                                                                                                                                                                               |
