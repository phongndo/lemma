# llm.client

Provides `Models` ([`@lemma/llm/web`](../contract/src/web/models.ts)): the
providers and models the host reports, kept current, and this browser's
choices among them (the model, a reasoning level for each model, and
favorites), which the composer sends with each turn (`turnOptions`). What it
changes on the host (logins, logouts, custom providers and their logos) it
asks of the provider of `Llm` through the `llm.*` channels (`LlmChannels`).
No config.

## Behavior

- **Kept current.** It lists again on each `llm.changes`, a login in another
  client included. An answer to an earlier listing that arrives after a later
  one is dropped. A listing that fails is reported.
- **Choices are this browser's.** `localStorage` keeps the model
  (`lemma.model`), the levels (`lemma.thinkingByModel`), and the favorites
  (`lemma.favoriteModels`), so another browser keeps its own. A model with no
  level chosen uses `DEFAULT_THINKING`. A level the model does not offer is
  clamped (`clampThinking`).
- **One login at a time.** `login` resolves false at once while another login
  this page started runs. A failed login is reported and resolves false.
  `logout` reports a failure rather than rejecting.
- **Sign-ins from any client.** `signIns` lists every sign-in running on the
  host (`llm.sign-ins`), and follows them again after a reconnect.
  `browserPlace` is the host's machine when the page came from `localhost`, so
  a flow uses a device code only elsewhere. In the desktop app, the sign-in page
  links back to the app (`signInReturn`: `lemma://settings/providers`). A
  browser tab gets no link back, as a tab it opened would have no copy of the
  host's token.
- **Custom providers settle.** `addCustom`, `removeCustom`, and `setLogo` wait
  up to five seconds for `llm.providers` to list the change, since the llm
  plugin's reload can finish after the call returns. `addCustom` rejects if the
  provider is not listed by then. The other two resolve regardless.

## Rationale

- **A model apart from its views.** It is what other plugins need beside a
  view a user might drop, so it is a plugin of its own: `threads.composer`,
  `llm.model-picker`, and `llm.providers` require `Models`, and a replacement
  provides it for them.
