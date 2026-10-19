import { For, Show, createEffect, createMemo, createSignal, on } from "solid-js";
import { ThinkingLevel } from "@lemma/llm";
import { Models } from "@lemma/llm/web";
import { ComposerControls, Threads, TurnOptionSources } from "@lemma/threads";
import { CheckIcon, ChevronDownIcon, Popover, SettingRow } from "@lemma/look";
import { SectionIds, SettingsGroups } from "@lemma/settings";
import { Client, Slots, defineWebPlugin } from "@lemma/web";
import { load, save } from "@lemma/web/storage";
import type { SessionEvent } from "@lemma/sessions";
import { ProfileChannels, PROFILES_PLUGIN } from "@lemma/agent";
import type { ProfileInfo } from "@lemma/agent";

/** The profile a new thread starts with, kept in this browser. */
const NEXT_KEY = "lemma.profiles.next";

/** The profile the branch's latest turn was taken with. */
const loggedOn = (branch: readonly SessionEvent[]): string | undefined => {
  for (let at = branch.length - 1; at >= 0; at--) {
    const data = branch[at]!.data;
    if (data.type !== "turn-start") continue;
    const chosen = data.plugins?.[PROFILES_PLUGIN];
    return typeof chosen === "string" ? chosen : undefined;
  }
  return undefined;
};

const isThinking = (value: string | undefined): value is ThinkingLevel => value !== undefined && (ThinkingLevel.literals as readonly string[]).includes(value);

/**
 * The profile picker, before the model picker: which profile the thread is given, sent with each prompt
 * (`TurnOptionSources`). A thread keeps the one its latest turn was taken with until another is picked; a new thread
 * starts with this browser's last pick, else the host's default. Picking one picks its model and reasoning too, which
 * the model picker then shows and can change.
 */
export default defineWebPlugin({
  id: PROFILES_PLUGIN,
  requires: { client: Client, threads: Threads, models: Models, slots: Slots },
  setup: ({ client, threads, models, slots }, plugin) => {
    const [profiles, setProfiles] = createSignal<readonly ProfileInfo[]>([]);
    const [fallback, setFallback] = createSignal<string | undefined>(undefined);
    const [next, setNext] = createSignal<string | undefined>(load(NEXT_KEY));
    /** Picks made here, by thread, before a turn logs them. */
    const [picked, setPicked] = createSignal<ReadonlyMap<string, string>>(new Map());

    const cwd = createMemo(() => threads.active()?.cwd ?? threads.pendingCwd());
    createEffect(
      on(cwd, (dir) => {
        void client.channel.call(ProfileChannels.list, dir === undefined ? {} : { cwd: dir }).then(
          (answer) => {
            setProfiles(answer.profiles);
            setFallback(answer.default);
          },
          () => setProfiles([]),
        );
      }),
    );

    /** The profile a thread (`undefined`: a new one) goes on with, as chosen, logged, or by default. */
    const profileOf = (sessionId: string | undefined): string | undefined => {
      if (sessionId === undefined) return next();
      return picked().get(sessionId) ?? (sessionId === threads.activeId() ? loggedOn(threads.branch()) : undefined);
    };
    const current = () => (threads.blank() ? next() : profileOf(threads.activeId())) ?? fallback();

    /** Gives `profile` to a thread (`undefined`: the next new one), with its model and reasoning. */
    const pick = (profile: ProfileInfo, sessionId: string | undefined) => {
      if (sessionId === undefined) {
        setNext(profile.name);
        save(NEXT_KEY, profile.name);
      } else setPicked((all) => new Map([...all, [sessionId, profile.name]]));
      if (profile.model !== undefined) models.choose(profile.model);
      if (isThinking(profile.thinking)) models.chooseThinking(profile.thinking);
    };
    const describe = (name: string | undefined) => profiles().find((profile) => profile.name === name)?.description;

    /** The profiles, as a menu under `trigger`, `current` checked. */
    function ProfileMenu(props: { current: string | undefined; onPick: (profile: ProfileInfo) => void; placement: "top-start" | "bottom-end" }) {
      return (
        <Popover
          label="Profile"
          tip={describe(props.current) ?? "What the agent is for in this thread"}
          triggerClass="select-chip"
          placement={props.placement}
          trigger={
            <>
              <span class="picker-label">{props.current ?? "Profile"}</span>
              <ChevronDownIcon />
            </>
          }
        >
          {(close) => (
            <For each={profiles()}>
              {(profile) => (
                <button
                  class="menu-item"
                  role="menuitemradio"
                  aria-checked={props.current === profile.name}
                  data-tip={profile.description}
                  onClick={() => {
                    props.onPick(profile);
                    close();
                  }}
                >
                  <span class="menu-check">
                    <Show when={props.current === profile.name}>
                      <CheckIcon />
                    </Show>
                  </span>
                  {profile.name}
                  <Show when={profile.source !== "bundled"}>
                    <span class="muted"> · {profile.source}</span>
                  </Show>
                </button>
              )}
            </For>
          )}
        </Popover>
      );
    }

    plugin.onCleanup(slots.add(TurnOptionSources, { id: PROFILES_PLUGIN, value: profileOf }));
    plugin.onCleanup(
      slots.add(ComposerControls, {
        id: "profile",
        order: -10,
        component: () => (
          <Show when={profiles().length > 0}>
            <ProfileMenu current={current()} placement="top-start" onPick={(profile) => pick(profile, threads.blank() ? undefined : threads.activeId())} />
          </Show>
        ),
      }),
    );
    // The profile a new thread starts with, first among General's settings for new threads.
    const forNew = () => next() ?? fallback();
    plugin.onCleanup(
      slots.add(SettingsGroups, {
        id: "profiles",
        order: -10,
        section: SectionIds.general,
        title: "New threads",
        entries: () =>
          profiles().length === 0
            ? []
            : [
                {
                  text: `Profile agent role coding general system prompt ${profiles()
                    .map((profile) => profile.name)
                    .join(" ")}`,
                  view: () => (
                    <SettingRow
                      title="Profile"
                      description={describe(forNew()) ?? "What the agent is for: its guidance, and the tools it keeps. Picking one picks its model too."}
                    >
                      <ProfileMenu current={forNew()} placement="bottom-end" onPick={(profile) => pick(profile, undefined)} />
                    </SettingRow>
                  ),
                },
              ],
      }),
    );
  },
});
