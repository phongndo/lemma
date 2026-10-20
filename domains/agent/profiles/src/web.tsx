import { For, Show, createEffect, createMemo, createSignal, on } from "solid-js";
import { ThinkingLevel } from "@lemma/llm";
import { Models } from "@lemma/llm/web";
import { ThreadCard, Threads, ThreadStart, TurnOptionSources } from "@lemma/threads";
import { CheckIcon, ChevronDownIcon, Popover, SettingRow, SlidersIcon } from "@lemma/look";
import { SectionIds, SettingsGroups } from "@lemma/settings";
import { Client, Slots, defineWebPlugin } from "@lemma/web";
import { load, save } from "@lemma/web/storage";
import { ProfileChannels, PROFILES_PLUGIN } from "@lemma/agent";
import type { ProfileInfo } from "@lemma/agent";
import { firstMode, RENAMED } from "./profile.ts";
import styles from "./web.css?inline";

/** The mode a new thread starts with, kept in this browser. */
const NEXT_KEY = "lemma.profiles.next";

/** A mode's name as the picker shows it: `work` is Work. */
const titled = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

const isThinking = (value: string | undefined): value is ThinkingLevel => value !== undefined && (ThinkingLevel.literals as readonly string[]).includes(value);

/**
 * The mode picker (a thread's profile), before the model picker. A mode is chosen for a new thread, sent with its
 * first prompt (`TurnOptionSources`), and kept from then on, as the host keeps it: an open thread shows its mode, which
 * no longer picks. A new thread starts with this browser's last pick, else the host's default. Picking one picks its
 * model and reasoning too, which the model picker then shows and can change.
 */
export default defineWebPlugin({
  id: PROFILES_PLUGIN,
  styles,
  requires: { client: Client, threads: Threads, models: Models, slots: Slots },
  setup: ({ client, threads, models, slots }, plugin) => {
    const [profiles, setProfiles] = createSignal<readonly ProfileInfo[]>([]);
    const [fallback, setFallback] = createSignal<string | undefined>(undefined);
    const [next, setNext] = createSignal<string | undefined>(load(NEXT_KEY));

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

    /** The modes as the menu lists them: the default first, then the rest as the host sorts them. */
    const ordered = createMemo(() => [...profiles()].sort((a, b) => Number(b.name === fallback()) - Number(a.name === fallback())));
    const listed = (name: string) => profiles().some((profile) => profile.name === name);
    /** The mode a new thread starts with: this browser's pick while the host still offers it, else the default. */
    const forNew = () => {
      const name = next();
      return name !== undefined && (profiles().length === 0 || listed(name)) ? name : fallback();
    };
    /** The open thread's mode once its first turn has logged it (a bundled one since renamed is its successor, as the host has it). */
    const thread = () => {
      const first = firstMode(threads.branch());
      if (first === undefined) return undefined;
      const name = first.name ?? fallback();
      return name === undefined || listed(name) || RENAMED[name] === undefined ? name : RENAMED[name];
    };
    const describe = (name: string | undefined) => profiles().find((profile) => profile.name === name)?.description;

    /** Gives `profile` to the next new thread, with its model and reasoning. */
    const pick = (profile: ProfileInfo) => {
      setNext(profile.name);
      save(NEXT_KEY, profile.name);
      if (profile.model !== undefined) models.choose(profile.model);
      if (isThinking(profile.thinking)) models.chooseThinking(profile.thinking);
    };

    /** The modes, each named over what it is for, `current` checked. */
    function ModeMenu(props: {
      current: string | undefined;
      onPick: (profile: ProfileInfo) => void;
      placement: "bottom" | "bottom-end";
      triggerClass: string;
    }) {
      return (
        <Popover
          label="Mode"
          tip={describe(props.current) ?? "What the agent is set up to do in a new thread"}
          triggerClass={props.triggerClass}
          menuClass="agent-mode-menu"
          placement={props.placement}
          trigger={
            <>
              <span class="picker-label">{props.current === undefined ? "Mode" : titled(props.current)}</span>
              <ChevronDownIcon />
            </>
          }
        >
          {(close) => (
            <For each={ordered()}>
              {(profile) => (
                <button
                  class="menu-item agent-mode-item"
                  role="menuitemradio"
                  aria-checked={props.current === profile.name}
                  onClick={() => {
                    props.onPick(profile);
                    close();
                  }}
                >
                  <span class="agent-mode-text">
                    <span class="agent-mode-name">
                      {titled(profile.name)}
                      <Show when={profile.source !== "bundled"}>
                        <span class="muted"> · {profile.source}</span>
                      </Show>
                    </span>
                    <Show when={profile.description}>{(description) => <span class="agent-mode-description">{description()}</span>}</Show>
                  </span>
                  <span class="menu-check">
                    <Show when={props.current === profile.name}>
                      <CheckIcon />
                    </Show>
                  </span>
                </button>
              )}
            </For>
          )}
        </Popover>
      );
    }

    // Only a new thread's first prompt names a mode: a thread's own is in its log, which the host keeps to.
    plugin.onCleanup(slots.add(TurnOptionSources, { id: PROFILES_PLUGIN, value: (sessionId) => (sessionId === undefined ? forNew() : undefined) }));
    // An open thread's mode, kept since its first prompt: the thread card's first row.
    plugin.onCleanup(
      slots.add(ThreadCard, {
        id: "profile",
        order: 0,
        component: () => (
          <Show when={profiles().length > 0 && thread()}>
            {(name) => (
              <div class="menu-item" data-tip={`${describe(name()) ?? `${titled(name())} mode`}. Kept for this thread: start a new one for another mode.`}>
                <span class="menu-check">
                  <SlidersIcon />
                </span>
                <span class="menu-label">{titled(name())} mode</span>
                <span class="menu-hint">kept</span>
              </div>
            )}
          </Show>
        ),
      }),
    );
    // A new thread picks its mode first on its start line, before where it works.
    plugin.onCleanup(
      slots.add(ThreadStart, {
        id: "profile",
        order: -10,
        component: () => (
          <Show when={profiles().length > 0}>
            <ModeMenu current={forNew()} placement="bottom" onPick={pick} triggerClass="agent-mode-chip" />
            <span class="agent-mode-sep" aria-hidden="true">
              ·
            </span>
          </Show>
        ),
      }),
    );
    // The mode a new thread starts with, first among General's settings for new threads.
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
                  text: `Mode profile agent role system prompt ${profiles()
                    .map((profile) => profile.name)
                    .join(" ")}`,
                  view: () => (
                    <SettingRow
                      title="Mode"
                      description={
                        describe(forNew()) ??
                        "What a new thread's agent is set up to do: its guidance, and the tools it keeps. Picking one picks its model too."
                      }
                    >
                      <ModeMenu current={forNew()} placement="bottom-end" onPick={pick} triggerClass="select-chip" />
                    </SettingRow>
                  ),
                },
              ],
      }),
    );
  },
});
