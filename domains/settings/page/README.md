# settings.page

The settings page at `/settings/<section>` (`SettingsRoute`): the sections
plugins add to `SettingsSections`, each showing the `SettingsGroups` entries
for it, and a search across all of them. Provides `Settings`
([`@lemma/settings`](../contract/src/index.ts)). Adds the page to `Pages`, and
the General section (`SectionIds.general`), which holds only what other plugins
add to it. Adds `settings.open` (`mod+,`), `settings.close` (Escape or `mod+,`,
while settings show), and `settings.search` (`/`) to `Actions`. It stays on
while it provides `Settings`, which the pinned `settings.plugins` requires: a
plugin providing `Settings` takes its place. No config.

## Behavior

- **The sidebar.** While settings show, it adds its list of sections to
  `SidebarRegion` (in `replace`, at order -10). So the shell sizes, collapses,
  and makes a drawer of it as it does the threads.
- **Section heads** show a section's `description` and `actions`
  ([`SettingsSection`](../contract/src/index.ts)).
- **Search** finds the entries whose `text` holds every word of the query, in
  any order and case. The list of sections shows how many each matched.
- **Closing** returns to where settings were opened from: back through
  history, else to that address, else to a new thread. Each settings history
  entry keeps the way out, so a reload, or back and forward, still finds it.
- **`/settings [section]`** in the prompt (`PromptCommands`) opens a section by
  id or title, or General without one.
- **Badges** follow a section's `badgeTone`. An `error` (the default) reads in
  the error color, and the settings button counts it, by its leading number
  (`2`, `1 failed`) or as one. An `info` badge (an update out) is only a dot on
  the button, so good news does not look like an alarm.
- **The settings button** opens the first section with a badge, errors first,
  else General. While a `SettingsMenu` item shows (`profiles.switcher`'s
  profiles), it opens a menu instead: those items, a row for each section in
  error, and Settings last. The first item with a `face` takes the gear's
  place. `mod+,` still opens settings directly.
- **A section no plugin adds** (its plugin off, say) shows the first section in
  its place.
