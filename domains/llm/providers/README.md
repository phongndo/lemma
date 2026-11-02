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
([`@lemma/llm/web`](../contract/src/web/parts.tsx)).

| Config  | Default | What it does                                                                                                                                                                                          |
| ------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `logos` | unset   | Custom provider logos an earlier version kept here, by provider id. On start, each moves to its provider (`Models.setLogo`, into the llm plugin's config) unless it has one, and the field is cleared |

## Behavior

- **Sign-ins from any client.** The connect dialog shows and answers the step a
  running sign-in asks (`Models.signIns`, `Models.answerSignIn`), whichever
  client started it. Closing the dialog cancels the login wherever it runs
  (`Models.cancelLogin`). A click beside the dialog does not close it.
- **A browser on another machine.** Paste the address of the page the sign-in
  ended on, which failed to load. The field is open from the start when the app
  is served from another machine. The credentials are stored on the host.
- **Sign in again.** A row names the account and plan its sign-in names. An
  expired sign-in (`ProviderInfo.expired`) offers **Sign in again**. So does a
  failed request in the transcript whose provider is not connected
  (`ErrorActions`).
- **Logging out** forgets Lemma's copy of the key or sign-in. The provider
  honors it until you revoke it there, which the dialog links to.
- **Custom providers.** The key never enters config. It answers the new
  provider's `api_key` sign-in, so the host checks and stores it as any key.
  Removing a custom provider logs out of it first, unless its key comes from the
  environment or it needs none.
- **Enter in the search** starts the first unconnected match's sign-in.
