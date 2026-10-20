import { SectionIds, SettingsGroups, configSetting } from "@lemma/settings";
import { SettingRow, Toggle } from "@lemma/look";
import { HostPlugins, Notify, Slots, defineWebPlugin } from "@lemma/web";

const ID = "workspace.tidy";

/**
 * `workspace.tidy`'s web half: whether worktrees go when their threads are archived, in General › New threads beside
 * starting threads in them, read from its host half's row and written to it as the Plugins page would.
 */
export default defineWebPlugin({
  id: ID,
  requires: { host: HostPlugins, notify: Notify, slots: Slots },
  setup: ({ host, notify, slots }) => {
    const removeOnArchive = configSetting<boolean>(host, notify, ID, "removeOnArchive");
    slots.add(SettingsGroups, {
      id: ID,
      section: SectionIds.general,
      title: "New threads",
      order: 11,
      entries: () =>
        removeOnArchive.value() === undefined
          ? []
          : [
              {
                text: "Remove worktrees when archived clean up tidy delete worktree archive branch",
                view: () => (
                  <SettingRow
                    title="Remove worktrees when archived"
                    description="A worktree Lemma made goes once its last thread is archived, if nothing in it is uncommitted. Its branch stays, and unarchiving the thread makes it again."
                  >
                    <Toggle label="Remove worktrees when archived" checked={removeOnArchive.value() ?? true} onChange={removeOnArchive.set} />
                  </SettingRow>
                ),
              },
            ],
    });
  },
});
