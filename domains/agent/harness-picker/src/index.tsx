import { For, Show, createMemo, createSignal } from "solid-js";
import { ACCESS_LEVELS, HarnessChannels, lastHarness, NATIVE_HARNESS } from "@lemma/agent";
import type { Access, HarnessInfo } from "@lemma/agent";
import { Actions } from "@lemma/actions";
import { IntegrationsSection } from "@lemma/integrations";
import { BotIcon, CheckIcon, ChevronDownIcon, LockIcon, PencilIcon, Popover, SettingRow, SparklesIcon, UnlockIcon } from "@lemma/look";
import type { Placement } from "@lemma/look";
import { SectionIds, Settings, SettingsGroups } from "@lemma/settings";
import { ComposerControls, ComposerTurnOptions, Threads, ThreadsActionIds } from "@lemma/threads";
import { ComposerModelPart, LlmActionIds, Models } from "@lemma/llm/web";
import { Client, Slots, defineWebPlugin } from "@lemma/web";
import { load, loadJson, save } from "@lemma/web/storage";
import type { JSX } from "solid-js";
import { AgentModelPicker, HarnessMark } from "./picker.tsx";
import { effectiveAccess, effectiveHarness } from "./model.ts";
import styles from "./harness-picker.css?inline";

const DEFAULT_KEY = "lemma.agent.harness-picker.default";
/** Each harness's last model, by its id. */
const MODEL_KEY = "lemma.agent.harness-picker.model";
/** Lemma's own loop as the picker shows it before the host has listed the harnesses. */
const NATIVE_ENTRY: HarnessInfo = { id: NATIVE_HARNESS, title: "Lemma", source: "agent.loop", status: { state: "ready" } };
/** Each harness's last access level, by its id. */
const ACCESS_KEY = "lemma.agent.harness-picker.access";

const ACCESS_ICONS: Readonly<Record<Access, () => JSX.Element>> = {
  supervised: LockIcon,
  "auto-edits": PencilIcon,
  auto: SparklesIcon,
  full: UnlockIcon,
};

/** How much the harness's agent may do without asking: the levels it offers, the current one checked. */
function AccessMenu(props: { offered: readonly Access[]; current: Access; pick: (access: Access) => void }) {
  const level = (access: Access) => ACCESS_LEVELS.find((known) => known.access === access)!;
  return (
    <Popover
      label="Access"
      tip={level(props.current).description}
      triggerClass="harness-chip"
      placement="top-start"
      menuClass="harness-menu"
      trigger={
        <>
          {ACCESS_ICONS[props.current]()}
          <span class="harness-label">{level(props.current).title}</span>
          <ChevronDownIcon />
        </>
      }
    >
      {(close) => (
        <For each={props.offered}>
          {(access) => (
            <button
              type="button"
              class="menu-item harness-item"
              role="menuitemradio"
              aria-checked={access === props.current}
              onClick={() => {
                props.pick(access);
                close();
              }}
            >
              <span class="harness-item-mark">{ACCESS_ICONS[access]()}</span>
              <span class="harness-item-text">
                <span>{level(access).title}</span>
                <span class="harness-item-detail">{level(access).description}</span>
              </span>
            </button>
          )}
        </For>
      )}
    </Popover>
  );
}

/** A menu of the harnesses, the current one checked; one that cannot run turns now says why and cannot be picked. */
function HarnessMenu(props: {
  harnesses: readonly HarnessInfo[];
  current: string;
  label: string;
  placement?: Placement;
  pick: (id: string) => void;
  setUp: () => void;
  controller?: (handle: { readonly open: () => void }) => void;
}) {
  const shown = () => props.harnesses.find((harness) => harness.id === props.current);
  return (
    <Popover
      label={props.label}
      tip={shown()?.description ?? props.label}
      triggerClass="harness-chip"
      placement={props.placement ?? "top-start"}
      menuClass="harness-menu"
      {...(props.controller === undefined ? {} : { controller: props.controller })}
      trigger={
        <>
          <HarnessMark harness={shown()} />
          <span class="harness-label">{shown()?.title ?? props.current}</span>
          <ChevronDownIcon />
        </>
      }
    >
      {(close) => (
        <>
          <div class="menu-section">Runs the next turn</div>
          <For each={props.harnesses}>
            {(harness) => (
              <button
                type="button"
                class="menu-item harness-item"
                role="menuitemradio"
                aria-checked={harness.id === props.current}
                disabled={harness.status.state !== "ready"}
                title={harness.status.detail}
                onClick={() => {
                  props.pick(harness.id);
                  close();
                }}
              >
                <span class="menu-check">
                  <Show when={harness.id === props.current}>
                    <CheckIcon />
                  </Show>
                </span>
                <span class="harness-item-mark">
                  <HarnessMark harness={harness} />
                </span>
                <span class="harness-item-text">
                  <span>{harness.title}</span>
                  <span class="harness-item-detail">
                    {harness.status.state === "ready" ? (harness.description ?? "") : (harness.status.detail ?? "Cannot run turns now")}
                  </span>
                </span>
              </button>
            )}
          </For>
          <div class="menu-sep" />
          <button
            type="button"
            class="menu-item"
            onClick={() => {
              close();
              props.setUp();
            }}
          >
            <span class="menu-check" />
            Set up agents…
          </button>
        </>
      )}
    </Popover>
  );
}

/**
 * The agent picker: in the composer's toolbar, which harness runs the thread's next turn (Lemma's own loop, or another
 * coding agent such as Claude Code); in General settings, the one new threads start on. A thread keeps the one its
 * last turn ran on until another is picked for it.
 */
export default defineWebPlugin({
  id: "agent.harness-picker",
  styles,
  requires: { client: Client, slots: Slots, threads: Threads, settings: Settings, models: Models },
  setup: ({ client, slots, threads, settings, models }, plugin) => {
    const [harnesses, setHarnesses] = createSignal<readonly HarnessInfo[]>([]);
    plugin.onCleanup(client.follow(HarnessChannels.changes, undefined, setHarnesses));
    const [fallback, setFallback] = createSignal(load(DEFAULT_KEY));
    const chooseDefault = (id: string) => {
      const value = id === NATIVE_HARNESS ? undefined : id;
      save(DEFAULT_KEY, value);
      setFallback(value);
    };
    /** What was picked in each thread here; a new thread's pick is the default. */
    const [picked, setPicked] = createSignal<ReadonlyMap<string, string>>(new Map());
    const last = createMemo(() => lastHarness(threads.branch()));
    const current = () => {
      const id = threads.activeId();
      return effectiveHarness(id === undefined ? undefined : picked().get(id), id === undefined ? undefined : last(), fallback());
    };
    const pick = (harness: string) => {
      const id = threads.activeId();
      if (id === undefined) return chooseDefault(harness);
      setPicked((now) => new Map(now).set(id, harness));
    };
    const setUp = () => settings.open(IntegrationsSection, { kind: "agents" });

    /** The levels the current harness offers; none for the agent's own loop. */
    const levels = createMemo((): readonly Access[] => harnesses().find((harness) => harness.id === current())?.status.access ?? []);
    /** What was picked in each thread, and each harness's last pick, which new threads start with. */
    const [pickedAccess, setPickedAccess] = createSignal<ReadonlyMap<string, Access>>(new Map());
    const [savedAccess, setSavedAccess] = createSignal<Readonly<Record<string, Access>>>(
      loadJson(ACCESS_KEY, {}, (value): value is Record<string, Access> => typeof value === "object" && value !== null),
    );
    const access = () => {
      const id = threads.activeId();
      return effectiveAccess(id === undefined ? undefined : pickedAccess().get(id), savedAccess()[current()], levels());
    };
    const pickAccess = (level: Access) => {
      const id = threads.activeId();
      if (id !== undefined) setPickedAccess((now) => new Map(now).set(id, level));
      const saved = { ...savedAccess(), [current()]: level };
      save(ACCESS_KEY, JSON.stringify(saved));
      setSavedAccess(saved);
    };
    const [open, setOpen] = createSignal<() => void>();
    const focusComposer = () => slots.get(Actions, ThreadsActionIds.focusComposer)?.run();

    /** Each harness's model: picked in a thread here, else its last pick, which new threads start with. */
    const [pickedModels, setPickedModels] = createSignal<ReadonlyMap<string, string | undefined>>(new Map());
    const [savedModels, setSavedModels] = createSignal<Readonly<Record<string, string>>>(
      loadJson(MODEL_KEY, {}, (value): value is Record<string, string> => typeof value === "object" && value !== null),
    );
    const threadKey = (harness: string) => `${threads.activeId() ?? ""}\u0000${harness}`;
    const modelOf = (harness: string) => {
      const key = threadKey(harness);
      const offered = harnesses().find((candidate) => candidate.id === harness)?.status.models ?? [];
      const chosen = pickedModels().has(key) ? pickedModels().get(key) : savedModels()[harness];
      // One the agent no longer offers falls back to its default.
      return chosen !== undefined && offered.some((model) => model.id === chosen) ? chosen : undefined;
    };
    const pickModel = (harness: string, model: string | undefined) => {
      setPickedModels((now) => new Map(now).set(threadKey(harness), model));
      const saved = { ...savedModels() };
      if (model === undefined) delete saved[harness];
      else saved[harness] = model;
      save(MODEL_KEY, JSON.stringify(saved));
      setSavedModels(saved);
    };

    slots.add(ComposerTurnOptions, {
      id: "harness",
      options: () => {
        const level = access();
        const model = current() === NATIVE_HARNESS ? undefined : modelOf(current());
        return { harness: current(), ...(level === undefined ? {} : { access: level }), ...(model === undefined ? {} : { model }) };
      },
    });
    const connect = () => (slots.get(Actions, LlmActionIds.providers) === undefined ? undefined : () => slots.get(Actions, LlmActionIds.providers)?.run());
    // The model control: a model of any harness, which picks the harness too.
    slots.add(ComposerModelPart, {
      id: "agent.harness-picker",
      component: () => (
        <AgentModelPicker
          harnesses={harnesses().length === 0 ? [NATIVE_ENTRY] : harnesses()}
          current={current()}
          models={models}
          modelOf={modelOf}
          pickNative={(ref) => {
            models.choose(ref);
            pick(NATIVE_HARNESS);
            focusComposer();
          }}
          pickAgent={(harness, model) => {
            pickModel(harness, model);
            pick(harness);
            focusComposer();
          }}
          setUp={setUp}
          connect={connect()}
          controller={(handle) => setOpen(() => handle.open)}
        />
      ),
    });
    slots.add(ComposerControls, {
      id: "harness-access",
      order: 5,
      component: () => (
        <Show when={access()}>
          {(level) => (
            <AccessMenu
              offered={levels()}
              current={level()}
              pick={(picked) => {
                pickAccess(picked);
                focusComposer();
              }}
            />
          )}
        </Show>
      ),
    });
    slots.add(Actions, {
      id: "harness-picker.open",
      order: 2,
      title: "Switch model or agent…",
      category: "Model",
      keywords: ["harness", "agent", "claude", "codex", "pi", "acp", "provider", "llm"],
      icon: BotIcon,
      when: () => open() !== undefined,
      run: () => open()?.(),
    });
    slots.add(SettingsGroups, {
      id: "harness-picker",
      section: SectionIds.general,
      title: "New threads",
      entries: () => [
        {
          text: "Agent harness claude codex default new threads",
          view: () => (
            <SettingRow title="Agent" description="Runs a new thread's turns: Lemma's own, or another coding agent set up in Integrations.">
              <HarnessMenu
                harnesses={harnesses()}
                current={fallback() ?? NATIVE_HARNESS}
                label="Agent for new threads"
                placement="bottom-end"
                pick={chooseDefault}
                setUp={setUp}
              />
            </SettingRow>
          ),
        },
      ],
    });
  },
});
