# settings.page

The settings page at `/settings/<section>` (`SettingsRoute`): the sections
plugins add to `SettingsSections`, each showing the `SettingsGroups` entries
for it, and a search across all of them. Provides `Settings`
([`@lemma/settings`](../contract/src/index.ts)). Adds the page to `Pages`; the
General section (`SectionIds.general`), which has no entries of its own and
holds what other plugins add to it; and
`settings.open` (`mod+,`), `settings.close` (Escape or `mod+,`, while settings
show), and `settings.search` (`/`) to `Actions`. Requires `Slots`, `Router`,
`WebPlugins`, and `Layout` ([`@lemma/frame`](../../frame/contract/src/index.ts)).
Stays on while it provides `Settings`, which the pinned `settings.plugins`
requires: a plugin providing `Settings` takes its place. No config.

## Behavior

- **It takes the sidebar's place.** While settings show, it adds its list of
  sections to `SidebarRegion` (in `replace`, at order -10), ahead of the threads, so the shell
  sizes, collapses, and makes a drawer of it as it does the threads.
- **Every section opens on one head**: under the breadcrumb that names it, a
  line with its `description` and, at its end, its `actions`
  ([`SettingsSection`](../contract/src/index.ts)). A section with neither has
  none, and buttons that show only at times (Reset) leave none behind.
- **Search** finds the entries whose `text` holds every word of the query, in
  any order and case, and the list of sections shows how many each matched.
  Clearing it returns to the section being browsed.
- **Focus on opening** goes to the search at General. Opened straight to
  another section (the composer's Connect opens Providers), or with the search
  out of sight in a closed drawer, it goes to that section's own search, else
  its first control. `/` focuses the search, opening the drawer first when the
  search is in a closed one; a sidebar the person collapsed stays so.
- **Closing** returns to where settings were opened from: back through history
  when that entry is still behind, else to its address, else to a new thread.
  Each settings history entry keeps the way out, so a reload, or back and
  forward into settings, still finds it.
- **`/settings [section]`** in the prompt (`PromptCommands`) opens a section, by id or title, offered among those plugins add; without one, General.
- **Badges** are trouble or news, by a section's `badgeTone`. An `error` (the
  default: a plugin failed, an integration is down) reads in the error color,
  and the settings button counts it, by its leading number (`2`, `1 failed`)
  or as one. An `info` badge (an update out) reads neutrally in the nav and is
  only a dot on the button, so good news does not look like an alarm.
- **The settings button** opens the first section with a badge, errors first,
  and otherwise General. While an item of `SettingsMenu` shows (the profiles
  to switch to, from `profiles.switcher`), it opens a menu of their rows
  instead, then a row for each section in error, which opens it (Integrations,
  2 need attention), and Settings last; the first item with a `face` takes the gear's place (the
  profile's avatar). `mod+,` still opens settings directly.
- **A section no plugin adds** (its plugin off, say) shows the first section in
  its place.
