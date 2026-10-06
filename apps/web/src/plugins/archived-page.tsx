import type { SessionInfo } from "@lemma/contracts";
import { relativeTime, tildePath } from "../model/format.ts";
import { sessionTitle } from "../model/threads.ts";
import { Actions, Client, Threads, Settings, SettingsGroups, SettingsSections, Slots } from "../ui/contracts.ts";
import type { ClientService, ThreadsService, SettingsService } from "../ui/contracts.ts";
import { defineUiPlugin } from "../ui/define.ts";
import { ArchiveIcon } from "../ui/parts.tsx";
import styles from "./archived-page.css?inline";

const SECTION = "archived";

function ArchivedRow(props: { client: ClientService; threads: ThreadsService; settings: SettingsService; session: SessionInfo }) {
  const open = () => {
    props.settings.open(undefined);
    void props.threads.select(props.session.id);
  };
  return (
    <div class="setting-row archived-row">
      <div class="setting-text">
        <button class="setting-title archived-title" data-tip="Open" onClick={open}>
          {sessionTitle(props.session)}
        </button>
        <div class="setting-desc" data-tip={props.session.cwd}>
          {tildePath(props.session.cwd, props.client.info()?.home)} · {relativeTime(props.session.updatedAt, Date.now())}
        </div>
      </div>
      <div class="setting-control">
        <button class="button small" onClick={() => void props.threads.mark(props.session.id, { archived: false })}>
          Unarchive
        </button>
        <button class="button small archived-delete" onClick={() => void props.threads.remove(props.session.id)}>
          Delete
        </button>
      </div>
    </div>
  );
}

/** Archived threads, as a settings section: open, unarchive, or delete each. */
export default defineUiPlugin({
  id: "archived-page",
  styles,
  requires: { client: Client, threads: Threads, settings: Settings, slots: Slots },
  setup: ({ client, threads, settings, slots }) => {
    const archived = () =>
      threads
        .list()
        .filter((session) => session.archived === true)
        .sort((a, b) => b.updatedAt - a.updatedAt);
    slots.add(SettingsSections, {
      id: SECTION,
      order: 45,
      title: "Archived",
      icon: ArchiveIcon,
      empty: () => <p class="settings-empty">No archived threads. Archive one from its menu in the sidebar.</p>,
    });
    slots.add(SettingsGroups, {
      id: SECTION,
      section: SECTION,
      entries: () =>
        archived().map((session) => ({
          text: `archived ${sessionTitle(session)} ${session.cwd}`,
          view: () => <ArchivedRow client={client} threads={threads} settings={settings} session={session} />,
        })),
    });
    slots.add(Actions, {
      id: "archived-page.open",
      order: 10,
      title: "Archived threads",
      category: "Thread",
      keywords: ["archive", "hidden", "restore"],
      icon: ArchiveIcon,
      run: () => settings.open(SECTION),
    });
  },
});
