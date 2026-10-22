import { For, Show, createEffect, createMemo, createSignal, on } from "solid-js";
import { ThinkingLevel } from "@lemma/llm";
import { Models } from "@lemma/llm/web";
import { ThreadCard, Threads, ThreadStart, TurnOptionSources } from "@lemma/threads";
import { CheckIcon, ChevronDownIcon, Popover, SettingRow, SlidersIcon } from "@lemma/look";
import { SectionIds, SettingsGroups } from "@lemma/settings";
import type { SettingsEntry } from "@lemma/settings";
import { Client, Slots, defineWebPlugin } from "@lemma/web";
import { load, save } from "@lemma/web/storage";
import { ModeChannels, MODES_PLUGIN, offeredFor } from "@lemma/agent";
import type { ModeInfo } from "@lemma/agent";
import { firstMode, RENAMED } from "./mode.ts";
import styles from "./web.css?inline";

/** The mode a new thread starts with, kept in this browser. */
const NEXT_KEY = "lemma.modes.next";

/** A mode's name as the picker shows it: `work` is Work. */
const titled = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

const isThinking = (value: string | undefined): value is ThinkingLevel => value !== undefined && (ThinkingLevel.literals as readonly string[]).includes(value);

/**
 * The mode picker, before the model picker. A mode is chosen for a new thread, sent with its
 * first prompt (`TurnOptionSources`), and kept from then on, as the host keeps it: an open thread shows its mode, which
 * no longer picks. A new thread starts with this browser's last pick, else the host's default. Picking one picks its
 * model and reasoning too, which the model picker then shows and can change.
 */
export default defineWebPlugin({
  id: MODES_PLUGIN,
  styles,
  requires: { client: Client, threads: Threads, models: Models, slots: Slots },
  setup: ({ client, threads, models, slots }, plugin) => {
    /** Every mode the host lists for the directory; the menu offers those for threads (`offeredFor`). */
    const [all, setAll] = createSignal<readonly ModeInfo[]>([]);
    const modes = createMemo(() => all().filter((mode) => offeredFor(mode, "thread")));
    const [fallback, setFallback] = createSignal<string | undefined>(undefined);
    const [next, setNext] = createSignal<string | undefined>(load(NEXT_KEY));

    const cwd = createMemo(() => threads.active()?.cwd ?? threads.pendingCwd());
    createEffect(
      on(cwd, (dir) => {
        void client.channel.call(ModeChannels.list, dir === undefined ? {} : { cwd: dir }).then(
          (answer) => {
            setAll(answer.modes);
            setFallback(answer.default);
          },
          () => setAll([]),
        );
      }),
    );

    /** The modes as the menu lists them: the default first, then the rest as the host sorts them. */
    const ordered = createMemo(() => [...modes()].sort((a, b) => Number(b.name === fallback()) - Number(a.name === fallback())));
    // An agent's thread has a mode offered to agents only (`explore`): it is the host's still, and named as one.
    const listed = (name: string) => all().some((mode) => mode.name === name);
    /** The mode a new thread starts with: this browser's pick while the host still offers it, else the default. */
    const forNew = () => {
      const name = next();
      return name !== undefined && (modes().length === 0 || modes().some((mode) => mode.name === name)) ? name : fallback();
    };
    /** The open thread's mode once its first turn has logged it (a bundled one since renamed is its successor, as the host has it). */
    const thread = () => {
      const first = firstMode(threads.branch());
      if (first === undefined) return undefined;
      const name = first.name ?? fallback();
      return name === undefined || listed(name) || RENAMED[name] === undefined ? name : RENAMED[name];
    };
    const describe = (name: string | undefined) => all().find((mode) => mode.name === name)?.description;

    /** Gives `mode` to the next new thread, with its model and reasoning. */
    const pick = (mode: ModeInfo) => {
      setNext(mode.name);
      save(NEXT_KEY, mode.name);
      if (mode.model !== undefined) models.choose(mode.model);
      if (isThinking(mode.thinking)) models.chooseThinking(mode.thinking);
    };

    /** The modes, each named over what it is for, `current` checked. */
    function ModeMenu(props: { current: string | undefined; onPick: (mode: ModeInfo) => void; placement: "bottom" | "bottom-end"; triggerClass: string }) {
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
              {(mode) => (
                <button
                  class="menu-item agent-mode-item"
                  role="menuitemradio"
                  aria-checked={props.current === mode.name}
                  onClick={() => {
                    props.onPick(mode);
                    close();
                  }}
                >
                  <span class="agent-mode-text">
                    <span class="agent-mode-name">
                      {titled(mode.name)}
                      <Show when={mode.source !== "bundled"}>
                        <span class="muted"> · {mode.source}</span>
                      </Show>
                    </span>
                    <Show when={mode.description}>{(description) => <span class="agent-mode-description">{description()}</span>}</Show>
                  </span>
                  <span class="menu-check">
                    <Show when={props.current === mode.name}>
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
    plugin.onCleanup(slots.add(TurnOptionSources, { id: MODES_PLUGIN, value: (sessionId) => (sessionId === undefined ? forNew() : undefined) }));
    // An open thread's mode, kept since its first prompt: the thread card's first row, unless it is the default, which goes
    // without saying.
    plugin.onCleanup(
      slots.add(ThreadCard, {
        id: "mode",
        order: 0,
        group: "thread",
        component: () => (
          <Show when={modes().length > 0 && thread() !== fallback() && thread()}>
            {(name) => (
              <div class="menu-item" data-tip={`${describe(name()) ?? `${titled(name())} mode`}. Kept for this thread: start a new one for another mode.`}>
                <span class="menu-check">
                  <SlidersIcon />
                </span>
                <span class="menu-label">{titled(name())} mode</span>
              </div>
            )}
          </Show>
        ),
      }),
    );
    // A new thread picks its mode first on its start line, before where it works.
    plugin.onCleanup(
      slots.add(ThreadStart, {
        id: "mode",
        order: -10,
        component: () => (
          <Show when={modes().length > 0}>
            <ModeMenu current={forNew()} placement="bottom" onPick={pick} triggerClass="agent-mode-chip" />
            <span class="agent-mode-sep" aria-hidden="true">
              ·
            </span>
          </Show>
        ),
      }),
    );
    // The mode a new thread starts with, first among General's settings for new threads. The row made once, so the
    // modes changing (which `entries` reads) leaves it drawn, with its menu open if it was.
    const row: SettingsEntry = {
      get text() {
        return `Mode agent role system prompt ${modes()
          .map((mode) => mode.name)
          .join(" ")}`;
      },
      view: () => (
        <SettingRow
          title="Mode"
          description={
            describe(forNew()) ?? "What a new thread's agent is set up to do: its guidance, and the tools it keeps. Picking one picks its model too."
          }
        >
          <ModeMenu current={forNew()} placement="bottom-end" onPick={pick} triggerClass="select-chip" />
        </SettingRow>
      ),
    };
    plugin.onCleanup(
      slots.add(SettingsGroups, {
        id: "modes",
        order: -10,
        section: SectionIds.general,
        title: "New threads",
        entries: () => (modes().length === 0 ? [] : [row]),
      }),
    );
  },
});
