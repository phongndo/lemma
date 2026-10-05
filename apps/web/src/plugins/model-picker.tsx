import { For, Show, createMemo, createSignal } from "solid-js";
import type { HarnessInfo, ModelInfo, ThinkingLevel } from "@lemma/contracts";
import { contextSize } from "../model/format.ts";
import { DEFAULT_THINKING, filterModels, thinkingLevels } from "../model/prefs.ts";
import { ActionIds, Actions, ComposerControls, Harnesses, Models, SectionIds, SettingsGroups, Slots } from "../ui/contracts.ts";
import type { HarnessesService, ModelsService } from "../ui/contracts.ts";
import { defineUiPlugin } from "../ui/define.ts";
import {
  AlertIcon,
  BrainIcon,
  CheckIcon,
  ChevronDownIcon,
  ImageIcon,
  Popover,
  ProviderLogo,
  RefreshIcon,
  SearchIcon,
  SettingRow,
  Spinner,
  StarIcon,
} from "../ui/parts.tsx";
import type { Placement } from "../ui/contracts.ts";
import styles from "./model-picker.css?inline";

const LEVEL_LABEL: Record<ThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

/** The selected model's own reasoning levels; the choice is remembered per model. */
function ThinkingPicker(props: { models: ModelsService; placement?: Placement; afterPick?: () => void }) {
  const { selected: selectedModel, thinking: effectiveThinking, chooseThinking } = props.models;
  const levels = createMemo(() => thinkingLevels(selectedModel()));
  return (
    <Show when={levels().length > 0}>
      <span class="control-separator" aria-hidden="true" />
      <Popover
        label="Reasoning"
        tip={`Reasoning for ${selectedModel()?.name ?? "this model"}`}
        triggerClass="select-chip"
        placement={props.placement ?? "top-start"}
        trigger={
          <>
            <BrainIcon />
            <span>{LEVEL_LABEL[effectiveThinking() ?? DEFAULT_THINKING]}</span>
            <ChevronDownIcon />
          </>
        }
      >
        {(close) => (
          <>
            <div class="menu-section">Reasoning · {selectedModel()?.name}</div>
            <For each={levels()}>
              {(level) => (
                <button
                  class="menu-item"
                  role="menuitemradio"
                  aria-checked={effectiveThinking() === level}
                  onClick={() => {
                    chooseThinking(level);
                    close();
                    props.afterPick?.();
                  }}
                >
                  <span class="menu-check">
                    <Show when={effectiveThinking() === level}>
                      <CheckIcon />
                    </Show>
                  </span>
                  {LEVEL_LABEL[level]}
                </button>
              )}
            </For>
          </>
        )}
      </Popover>
    </Show>
  );
}

/** Picks the harness the next prompt runs on; shown while there is another to switch to. */
function HarnessPicker(props: { harnesses: HarnessesService; afterPick?: () => void }) {
  const { list, selected, selectedId, current, choose, refresh } = props.harnesses;
  const [checking, setChecking] = createSignal(false);
  const title = (id: string | undefined) => list().find((harness) => harness.id === id)?.title ?? id;
  const tip = () => {
    const from = current();
    if (from !== undefined && from !== selectedId()) return `The next prompt moves this thread from ${title(from)} to ${title(selectedId())}`;
    return selected()?.status.state === "unavailable" ? `${title(selectedId())} cannot run turns now` : "Harness";
  };
  const check = async () => {
    setChecking(true);
    await refresh();
    setChecking(false);
  };
  return (
    <Show when={list().some((harness) => harness.id !== selectedId())}>
      <Popover
        label="Harness"
        tip={tip()}
        triggerClass="select-chip harness-chip"
        placement="top-start"
        menuClass="harness-menu"
        trigger={
          <>
            <Show when={selected()?.status.state === "unavailable"}>
              <AlertIcon />
            </Show>
            <span class="picker-label">{title(selectedId())}</span>
            <ChevronDownIcon />
          </>
        }
      >
        {(close) => (
          <>
            <div class="menu-section">Harness</div>
            <For each={list()}>
              {(harness) => {
                const ready = () => harness.status.state === "ready";
                return (
                  <button
                    class="menu-item harness-item"
                    role="menuitemradio"
                    aria-checked={harness.id === selectedId()}
                    aria-disabled={!ready()}
                    onClick={() => {
                      if (!ready()) return;
                      choose(harness.id);
                      close();
                      props.afterPick?.();
                    }}
                  >
                    <span class="menu-check">
                      <Show when={harness.id === selectedId()}>
                        <CheckIcon />
                      </Show>
                    </span>
                    <span class="harness-text">
                      <span class="harness-title">{harness.title}</span>
                      <Show when={harness.description}>{(description) => <span class="harness-desc">{description()}</span>}</Show>
                      <Show when={!ready()}>
                        <span class="harness-detail">{harness.status.detail ?? "Cannot run turns now"}</span>
                      </Show>
                    </span>
                  </button>
                );
              }}
            </For>
            <div class="menu-sep" />
            <button
              class="menu-item"
              role="menuitem"
              aria-disabled={checking()}
              onClick={() => {
                if (!checking()) void check();
              }}
            >
              <span class="menu-check">{checking() ? <Spinner /> : <RefreshIcon />}</span>
              <span class="menu-label">{checking() ? "Checking…" : "Check again"}</span>
            </button>
          </>
        )}
      </Popover>
      <span class="control-separator" aria-hidden="true" />
    </Show>
  );
}

/** In place of the model picker while the harness runs on a model of its own. */
function OwnModel(props: { harness: HarnessInfo }) {
  return (
    <span class="select-chip static" data-tip={`${props.harness.title} runs on a model of its own: the model picked here does not apply`}>
      <span class="picker-label">{props.harness.title}'s model</span>
    </span>
  );
}

type Rail = "favorites" | "all" | string;

/** Picks the preferred model, shared by the composer and settings. */
function ModelPicker(props: {
  models: ModelsService;
  placement?: Placement;
  afterPick?: () => void;
  onProviders?: (() => void) | undefined;
  controller?: (handle: { readonly open: () => void }) => void;
}) {
  const { selected: selectedModel, favorites: favoriteModels, choose: chooseModel, toggleFavorite } = props.models;
  const [query, setQuery] = createSignal("");
  const [rail, setRail] = createSignal<Rail>("all");
  const providerName = (id: string) => props.models.providers().find((provider) => provider.id === id)?.name ?? id;
  const providers = createMemo(() => [...new Set(props.models.models().map((model) => model.provider))]);
  const shown = createMemo((): readonly ModelInfo[] => {
    // Searching always covers every model.
    if (query().trim() !== "") return filterModels(props.models.models(), query()).flatMap((group) => group.models);
    if (rail() === "favorites") return favoriteModels().flatMap((ref) => props.models.models().filter((model) => model.ref === ref));
    if (rail() === "all") return props.models.models();
    return props.models.models().filter((model) => model.provider === rail());
  });
  const label = () => selectedModel()?.name ?? (props.models.preferred() !== undefined && props.models.modelsLoaded() ? "Model unavailable" : "Choose a model");
  const pick = (ref: string, close: () => void) => {
    chooseModel(ref);
    close();
    props.afterPick?.();
  };
  const railKeys = (event: KeyboardEvent) => {
    if (query() !== "" || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
    const keys: Rail[] = [...(favoriteModels().length > 0 ? ["favorites"] : []), "all", ...providers()];
    const index = keys.indexOf(rail());
    event.preventDefault();
    setRail(keys[(index + (event.key === "ArrowRight" ? 1 : -1) + keys.length) % keys.length]!);
  };

  return (
    <Popover
      label="Model"
      tip={selectedModel() === undefined ? "Model" : `${providerName(selectedModel()!.provider)} · ${selectedModel()!.id}`}
      triggerClass="select-chip"
      placement={props.placement ?? "top-start"}
      menuClass="model-menu"
      onOpen={() => {
        setQuery("");
        const current = selectedModel();
        setRail(favoriteModels().length > 0 && (current === undefined || favoriteModels().includes(current.ref)) ? "favorites" : (current?.provider ?? "all"));
      }}
      {...(props.controller === undefined ? {} : { controller: props.controller })}
      trigger={
        <>
          <span class="picker-label">{label()}</span>
          <ChevronDownIcon />
        </>
      }
    >
      {(close) => (
        <>
          <label class="model-search">
            <SearchIcon />
            <input
              placeholder="Search models"
              aria-label="Search models"
              autocomplete="off"
              spellcheck={false}
              data-autofocus
              value={query()}
              onInput={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={railKeys}
            />
          </label>
          <div class="model-body">
            <nav class="model-rail" aria-label="Providers">
              <Show when={favoriteModels().length > 0}>
                <button
                  type="button"
                  class="rail-item"
                  classList={{ active: query() === "" && rail() === "favorites" }}
                  tabindex="-1"
                  aria-label="Favorites"
                  data-tip="Favorites"
                  onClick={() => {
                    setQuery("");
                    setRail("favorites");
                  }}
                >
                  <StarIcon filled />
                </button>
              </Show>
              <button
                type="button"
                class="rail-item"
                classList={{ active: query() !== "" || rail() === "all" }}
                tabindex="-1"
                aria-label="All models"
                data-tip="All models"
                onClick={() => {
                  setQuery("");
                  setRail("all");
                }}
              >
                <span class="rail-all">All</span>
              </button>
              <div class="rail-sep" />
              <For each={providers()}>
                {(provider) => (
                  <button
                    type="button"
                    class="rail-item"
                    classList={{ active: query() === "" && rail() === provider }}
                    tabindex="-1"
                    aria-label={providerName(provider)}
                    data-tip={providerName(provider)}
                    onClick={() => {
                      setQuery("");
                      setRail(provider);
                    }}
                  >
                    <ProviderLogo
                      id={provider}
                      name={providerName(provider)}
                      custom={props.models.providers().find((candidate) => candidate.id === provider)?.logo}
                    />
                  </button>
                )}
              </For>
            </nav>
            <div class="model-list" role="listbox">
              <For each={shown()}>
                {(model) => {
                  const selected = () => selectedModel()?.ref === model.ref;
                  const favorite = () => favoriteModels().includes(model.ref);
                  return (
                    <div class="model-row menu-item" role="option" aria-selected={selected()} onClick={() => pick(model.ref, close)}>
                      <span class="model-text">
                        <span class="model-name">{model.name}</span>
                        <span class="model-meta">
                          <span>{providerName(model.provider)}</span>
                          <span class="dot" />
                          <span>{contextSize(model.contextWindow)}</span>
                          <Show when={model.reasoning}>
                            <span class="meta-icon" data-tip="Reasoning">
                              <BrainIcon />
                            </span>
                          </Show>
                          <Show when={model.input.includes("image")}>
                            <span class="meta-icon" data-tip="Images">
                              <ImageIcon />
                            </span>
                          </Show>
                        </span>
                      </span>
                      <Show when={selected()}>
                        <span class="model-current">
                          <CheckIcon />
                        </span>
                      </Show>
                      <button
                        type="button"
                        class="model-star"
                        classList={{ on: favorite() }}
                        tabindex="-1"
                        aria-label={favorite() ? `Unfavorite ${model.name}` : `Favorite ${model.name}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleFavorite(model.ref);
                        }}
                      >
                        <StarIcon filled={favorite()} />
                      </button>
                    </div>
                  );
                }}
              </For>
              <Show when={shown().length === 0}>
                <div class="picker-empty">
                  <Show
                    when={props.models.models().length > 0}
                    fallback={
                      <>
                        No models yet.{" "}
                        <Show when={props.onProviders}>
                          {(open) => (
                            <button
                              type="button"
                              class="link-button"
                              onClick={() => {
                                close();
                                open()();
                              }}
                            >
                              Log in to a provider
                            </button>
                          )}
                        </Show>
                      </>
                    }
                  >
                    {rail() === "favorites" && query() === "" ? "Star a model to keep it here" : "No matching models"}
                  </Show>
                </div>
              </Show>
            </div>
          </div>
        </>
      )}
    </Popover>
  );
}

/**
 * The harness, model, and reasoning pickers: in the composer's toolbar, in
 * General settings, and behind "Switch model…".
 */
export default defineUiPlugin({
  id: "model-picker",
  styles,
  requires: { models: Models, harnesses: Harnesses, slots: Slots },
  setup: ({ models, harnesses, slots }, plugin) => {
    const [open, setOpen] = createSignal<() => void>();
    /** The harness the next prompt runs on, while it runs on a model of its own. */
    const ownModel = () => {
      const harness = harnesses.selected();
      return harness?.capabilities.models === false ? harness : undefined;
    };
    /** Other plugins' actions, run when they exist: focus the prompt, open the providers settings. */
    const runAction = (id: string) => slots.get(Actions, id)?.run();
    const providers = () => (slots.get(Actions, ActionIds.providers) === undefined ? undefined : () => runAction(ActionIds.providers));
    const add = plugin.onCleanup;
    add(
      slots.add(ComposerControls, {
        id: "harness",
        order: -10,
        component: () => <HarnessPicker harnesses={harnesses} afterPick={() => runAction(ActionIds.focusComposer)} />,
      }),
    );
    add(
      slots.add(ComposerControls, {
        id: "model",
        component: () => (
          <Show
            when={ownModel()}
            fallback={
              <ModelPicker
                models={models}
                afterPick={() => runAction(ActionIds.focusComposer)}
                onProviders={providers()}
                controller={(handle) => setOpen(() => handle.open)}
              />
            }
          >
            {(harness) => <OwnModel harness={harness()} />}
          </Show>
        ),
      }),
    );
    add(
      slots.add(ComposerControls, {
        id: "thinking",
        order: 10,
        component: () => (
          <Show when={ownModel() === undefined}>
            <ThinkingPicker models={models} afterPick={() => runAction(ActionIds.focusComposer)} />
          </Show>
        ),
      }),
    );
    add(
      slots.add(Actions, {
        id: "model-picker.open",
        order: 2,
        title: "Switch model…",
        category: "Model",
        keywords: ["provider", "llm"],
        icon: BrainIcon,
        when: () => open() !== undefined && ownModel() === undefined,
        run: () => open()?.(),
      }),
    );
    add(
      slots.add(SettingsGroups, {
        id: "model-picker",
        section: SectionIds.general,
        title: "New threads",
        entries: () => [
          {
            text: "Model provider llm default",
            view: () => (
              <SettingRow title="Model" description="Used for every prompt until you pick another here or in the composer.">
                <ModelPicker models={models} placement="bottom-end" onProviders={providers()} />
              </SettingRow>
            ),
          },
          {
            text: "Reasoning thinking effort level",
            view: () => (
              <SettingRow title="Reasoning" description="How hard the model thinks. Remembered for each model.">
                <Show when={models.selected()?.reasoning} fallback={<span class="muted small">Not offered by this model</span>}>
                  <ThinkingPicker models={models} placement="bottom-end" />
                </Show>
              </SettingRow>
            ),
          },
        ],
      }),
    );
  },
});
