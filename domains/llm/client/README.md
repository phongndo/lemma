# llm.client

Provides `Models` ([`@lemma/llm/web`](../contract/src/web/models.ts)): the
providers and models the host reports, kept current, and this browser's
choices among them (the model, a reasoning level for each model, and
favorites), which the composer sends with each turn (`turnOptions`). What it
changes on the host (logins, logouts, custom providers and their logos) it
asks of the provider of `Llm` through the `llm.*` channels (`LlmChannels`).
Requires `Client` and `Notify`. No config.

## Behavior

- **Kept current.** It lists the providers, and the models whose provider is
  configured, as `llm.changes` opens and on each change it reports, a login
  in another client included. An answer to an earlier listing that arrives
  after a later one is dropped, and a listing that fails is reported.
- **Choices are this browser's.** The model, the levels, and the favorites
  are kept in `localStorage` (`lemma.model`, `lemma.thinkingByModel`,
  `lemma.favoriteModels`), not on the host, so another browser keeps its own.
  A model with no level chosen uses `DEFAULT_THINKING`, and a level the model
  does not offer is clamped (`clampThinking`).
- **One login at a time.** `login` while another login this page started is
  running resolves false at once, and `loggingIn` names only a login this
  page started. A failed login is reported and resolves false. Once a login
  ends, the toasts it raised (its links, device codes, and progress) are
  dismissed, all but its `signed-in` notice. `logout` reports a failure
  rather than rejecting.
- **Custom providers settle.** `addCustom`, `removeCustom`, and `setLogo`
  change the llm plugin's config, whose reload can finish after the call
  returns, so each waits up to five seconds for `llm.providers` to list the
  change: `addCustom` rejects if the provider is not listed by then, and the
  other two resolve regardless. Their other failures reach the caller.

## Rationale

- **A model apart from its views.** It is what other plugins need beside a
  view a user might drop, so it is a plugin of its own: `threads.composer`,
  `llm.model-picker`, and `llm.providers` require `Models`, and a replacement
  provides it for them.
