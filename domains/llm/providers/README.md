# llm.providers

Settings › Providers: connecting a model provider by signing in with a
subscription or pasting an API key, and adding a provider of your own (an
endpoint speaking one of the wire APIs in `CUSTOM_APIS`, such as Ollama or a
company gateway). Adds the `providers` section to `SettingsSections` and its
lists (Connected, Popular, All providers, a search's results, and Custom) to
`SettingsGroups`, the connect and custom-provider dialogs to `Layers`, a
notice to `ComposerNotices` while no provider is set up, the
`LlmActionIds.providers` action ("Log in to a provider…") to `Actions`, and
its row as the default of `ProviderRowPart`
([`@lemma/llm/web`](../contract/src/web/parts.tsx)). Requires `Models`,
`Settings`, `Dialogs`, `Client`, `Interactions`, `Notify`, `Slots`, and
`WebPlugins`.

| Config  | Default | What it does                                                                                                                                                                                          |
| ------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `logos` | unset   | Custom provider logos an earlier version kept here, by provider id. On start, each moves to its provider (`Models.setLogo`, into the llm plugin's config) unless it has one, and the field is cleared |

## Behavior

- **Logins from any client.** The connect dialog shows a running login's
  questions, the page it opens, and its device code, whichever client started
  it: the plugin claims the questions (`Interactions.claim`) and notices
  (`Notify.claim`) whose origin is `login:<provider>` for a provider it lists,
  and leaves a question for one it does not list to the question dialog.
  Closing the dialog cancels the login (`Models.cancelLogin`) wherever it
  runs; a click beside it does not close it.
- **A browser on another machine.** One that cannot reach the host ends the
  sign-in on a page that fails to load; the dialog takes that page's address
  (the login's `sign-in-code` question), with the field open from the start
  when the app itself is served from another machine.
- **Custom providers.** The form asks a name, a base URL, a wire API, model
  ids, and optionally a key and an SVG logo (checked by `logoProblem`). The
  key never enters config: it answers the new provider's `api_key` login, so
  the host stores it as it stores any key. Removing a custom provider logs out
  of it first, unless its key comes from the environment or it needs none.
- **Opened with nothing set up**, from the composer's notice or the palette,
  the section says why, and Settings closes once a login connects a provider.
- **Enter in the search** starts the first unconnected match's sign-in, else
  its first way in.
