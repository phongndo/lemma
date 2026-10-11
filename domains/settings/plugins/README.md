# settings.plugins

Settings › Plugins: every plugin of the host and of the web app in one table,
grouped by domain, each turned on or off, restarted, configured, and inspected
there. Adds the Plugins section to `SettingsSections` (`SectionIds.plugins`),
with a badge while a plugin has failed and a button that reloads the config
files; an entry for each half of each plugin to `SettingsGroups`, so the
settings search finds them; its tabs to `PluginTabs`; and `plugins-page.open`
(Show plugins) to `Actions` ([`@lemma/settings`](../contract/src/index.ts)).
Draws the `PluginsFacts` in its summary. Requires `Settings`, `HostPlugins`,
`WebPlugins`, `Client`, `Notify`, and `Slots`. Pinned: replace it with a web
half of your own with its id, never turn it off, since it is where plugins are
turned back on. No config.

| Tab (`PluginTabs`) | Order | What it shows of the selected plugin                                                                                                                    |
| ------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plugins.overview` | 0     | Its state and why, source, version, the config file that sets it, why it is locked, what turning it off stops or on replaces, what waits on it; restart |
| `plugins.wiring`   | 10    | What it adds, intercepts (its place in each chain), observes, calls (and who provides each), and serves (and who uses each, and its channels)           |
| `plugins.settings` | 20    | Its config form, and the effective config, secrets named but not shown                                                                                  |
| `plugins.faults`   | 30    | Its recent faults                                                                                                                                       |

## Behavior

- **One row per plugin.** A host half and a web half with one id are one row
  with one switch, as one config row decides both; its details switch between
  the halves.
- **By domain.** Each domain an id names (`tools` for `tools.bash`) is one
  folded row summing up its plugins (`1 failed · 2 off`, or Running), in order
  of name, with plugins in no domain, as a user's often are, after them.
  Domains start folded; a filter opens those with a match, and selecting a
  plugin opens its domain.
- **The filter**: `is:running`, `is:failed`, `is:off`, `is:halted`,
  `is:locked`, `is:configurable`, `is:faulted`, `kind:host|web`,
  `source:bundled|user|project`, `domain:<domain>`, and words matched in a
  plugin's id, state, source, capabilities, and why it is not running. `-`
  before a term excludes it; every term must hold, of either half.
- **The address** keeps the selection, tab, and filter
  (`?plugin=<id>&kind=host|web&tab=<tab id>&filter=…`), so a link, a reload, and
  back and forward return to them. Another plugin opens one's details with
  `settings.open(SectionIds.plugins, { plugin, kind })`.
- **A switch** asks first when turning the plugin off stops running plugins
  that need what it provides, or turning it on turns off those providing the
  same. It writes the user's config file, or the project's when that one sets
  the plugin, and says so when the other file still decides. A locked plugin
  (pinned, or needed by one that is) has its switch disabled, with the reason
  as its tooltip.
- **Restart** starts a failed plugin, or one another halted, again with the
  plugins it halted; on a running plugin that is not locked, it stops it and
  the plugins that need it, then starts them again.
- **With nothing selected**, the details show the counts, what each app
  provides itself and who uses it, the host's facts (its address, home,
  project, config files, the web app's plugin files, and its composition), and
  the `PluginsFacts` lines.
- **Keys.** ↑ and ↓ in the table move the selection.
