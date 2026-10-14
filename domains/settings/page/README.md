# settings.page

The settings page at `/settings/<section>` (`SettingsRoute`): the sections
plugins add to `SettingsSections`, each showing the `SettingsGroups` entries
for it, and a search across all of them. Provides `Settings`
([`@lemma/settings`](../contract/src/index.ts)). Adds the page to `Pages`; the
General section (`SectionIds.general`), which has no entries of its own and
holds what other plugins add to it; a settings button to `SidebarFooter`; and
`settings.open` (`mod+,`), `settings.close` (Escape or `mod+,`, while settings
show), and `settings.search` (`/`) to `Actions`. Requires `Slots`, `Router`,
`WebPlugins`, and `Layout` ([`@lemma/frame`](../../frame/contract/src/index.ts)).
Stays on while it provides `Settings`, which the pinned `settings.plugins`
requires: a plugin providing `Settings` takes its place. No config.

## Behavior

- **It takes the sidebar's place.** While settings show, it adds its list of
  sections to `SidebarRegion` (in `replace`, at order -10), ahead of the threads, so the shell
  sizes, collapses, and makes a drawer of it as it does the threads.
- **Search** finds the entries whose `text` holds every word of the query, in
  any order and case, and the list of sections shows how many each matched.
  Clearing it returns to the section being browsed.
- **Closing** returns to where settings were opened from: back through history
  when that entry is still behind, else to its address, else to a new thread.
  Each settings history entry keeps the way out, so a reload, or back and
  forward into settings, still finds it.
- **`/settings [section]`** in the prompt (`PromptCommands`) opens a section, by id or title, offered among those plugins add; without one, General.
- **The settings button** opens the first section with a `badge`, showing its
  count, and otherwise General.
- **A section no plugin adds** (its plugin off, say) shows the first section in
  its place.
