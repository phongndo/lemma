# settings

Settings: the page, its sections and groups, and the Plugins page. Its contract is [`@lemma/settings`](contract/src/index.ts).

| Plugin                         | Halves | What it does                                                                                       |
| ------------------------------ | ------ | -------------------------------------------------------------------------------------------------- |
| [`settings.page`](page/)       | web    | The page, its sections and groups, and General                                                     |
| [`settings.plugins`](plugins/) | web    | Settings › Plugins: every plugin, both halves, turned on or off, configured, and inspected. Pinned |

## Extending it

| Shape     | What the contract offers                                                                         |
| --------- | ------------------------------------------------------------------------------------------------ |
| Add       | `SettingsSections`, `SettingsGroups`, `PluginTabs` (a tab of a plugin's details), `PluginsFacts` |
| Intercept | Nothing                                                                                          |
| Observe   | Nothing                                                                                          |
| Call      | `Settings`: open a section                                                                       |
| Serve     | `Settings`: a plugin providing it replaces `settings.page`                                       |
