# llm.providers

Settings › Providers: connecting a model provider by signing in with a
subscription or pasting an API key, and adding a provider of your own (an
endpoint speaking one of the wire APIs in `CUSTOM_APIS`, such as Ollama or a
company gateway). Adds the `providers` section to `SettingsSections` and its
lists (Connected, Popular, All providers, a search's results, and Custom) to
`SettingsGroups`, the connect, custom-provider, and logout dialogs to
`Layers`, a notice to `ComposerNotices` while no provider is set up, a way to
connect again to `ErrorActions` (in `@lemma/threads`), the
`LlmActionIds.providers` action ("Log in to a provider…") to `Actions`, and
its row as the default of `ProviderRowPart`
([`@lemma/llm/web`](../contract/src/web/parts.tsx)). Requires `Models`,
`Settings`, `Dialogs`, `Notify`, `Slots`, and `WebPlugins`.

| Config  | Default | What it does                                                                                                                                                                                          |
| ------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `logos` | unset   | Custom provider logos an earlier version kept here, by provider id. On start, each moves to its provider (`Models.setLogo`, into the llm plugin's config) unless it has one, and the field is cleared |

## Behavior

- **Logins from any client.** The connect dialog shows what a running
  sign-in asks now (`Models.signIns`), whichever client started it: the page
  to open, the device code to enter and how long it lasts, the key to paste
  (and why the provider refused the last one), or the flow's question, and
  answers it (`Models.answerSignIn`). One another client started shows while
  it waits on the person. Closing the dialog cancels the login
  (`Models.cancelLogin`) wherever it runs; a click beside it does not close it.
- **A browser on another machine.** One that cannot reach the host ends the
  sign-in on a page that fails to load; the dialog takes that page's address
  (a `browser` step that takes a paste), with the field open from the start
  when the app itself is served from another machine, and says the
  credentials are stored on the host.
- **Who it is signed in as.** A row says the account and plan a sign-in
  names, and one whose sign-in expired (`ProviderInfo.expired`) offers
  **Sign in again**. A failed request in the transcript whose provider is not
  connected, or whose sign-in expired, offers the same (`ErrorActions`).
- **Logging out says what it does.** Lemma forgets its copy of the key or
  sign-in; the dialog says the provider honors it until it is revoked there,
  and links where a key is deleted.
- **Custom providers.** The form asks a name, a base URL, a wire API, model
  ids, and optionally a key and an SVG logo (checked by `logoProblem`). The
  key never enters config: it answers the new provider's `api_key` sign-in,
  so the host checks and stores it as it does any key; a key it refuses opens
  the connect dialog to take another. Removing a custom provider logs out
  of it first, unless its key comes from the environment or it needs none.
- **Opened with nothing set up**, from the composer's notice or the palette,
  the section says why, and Settings closes once a login connects a provider.
- **Enter in the search** starts the first unconnected match's sign-in, else
  its first way in.
