# settings

Settings: the page, its sections and groups, and the Plugins page. Its contract is [`@lemma/settings`](contract/src/index.ts).

| Plugin                         | Halves | What it does                                                                                       |
| ------------------------------ | ------ | -------------------------------------------------------------------------------------------------- |
| [`settings.page`](page/)       | web    | The page, its sections and groups, and General                                                     |
| [`settings.plugins`](plugins/) | web    | Settings › Plugins: every plugin, both halves, turned on or off, configured, and inspected. Pinned |

## Extending it

What the contract offers in each of the [five shapes](../../docs/plugins.md#the-five-shapes):

| Shape     | What the contract offers                                                                                                                      |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Add       | `SettingsSections`, `SettingsGroups`, `SettingsMenu` (the settings button's menu), `PluginTabs` (a tab of a plugin's details), `PluginsFacts` |
| Intercept | Nothing                                                                                                                                       |
| Observe   | Nothing                                                                                                                                       |
| Call      | `Settings`: open a section; `configSetting`: a plugin's config field as one setting, for a row                                                |
| Serve     | `Settings`: a plugin providing it replaces `settings.page`                                                                                    |
