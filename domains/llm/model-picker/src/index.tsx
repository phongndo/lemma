import { For, Show, createMemo, createSignal } from "solid-js";
import type { ModelInfo, ThinkingLevel } from "@lemma/llm";
import { contextSize } from "./context-size.ts";
import { ComposerModelPart, DEFAULT_THINKING, filterModels, thinkingLevels, Models, LlmActionIds, ProviderLogo } from "@lemma/llm/web";
import { Actions } from "@lemma/actions";
import { SectionIds, SettingsGroups } from "@lemma/settings";
import { ComposerControls, composerTurn, picksOwnModel, ThreadsActionIds } from "@lemma/threads";
import { First, Slots, defineWebPlugin } from "@lemma/web";
import type { ModelsService } from "@lemma/llm/web";
import { BrainIcon, CheckIcon, ChevronDownIcon, ImageIcon, Popover, SearchIcon, SettingRow, StarIcon } from "@lemma/look";
import type { Placement } from "@lemma/look";
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
 * The model and reasoning pickers: in the composer's toolbar, in General
 * settings, and behind "Switch model…".
 */
export default defineWebPlugin({
  id: "llm.model-picker",
  styles,
  requires: { models: Models, slots: Slots },
  setup: ({ models, slots }, plugin) => {
    const [open, setOpen] = createSignal<() => void>();
    /** Other plugins' actions, run when they exist: focus the prompt, open the providers settings. */
    const runAction = (id: string) => slots.get(Actions, id)?.run();
    const providers = () => (slots.get(Actions, LlmActionIds.providers) === undefined ? undefined : () => runAction(LlmActionIds.providers));
    const add = plugin.onCleanup;
    /** The prompt runs on another coding agent, which picks its own model: the pickers have nothing to choose. */
    const ownModel = () => picksOwnModel(composerTurn(slots));
    add(slots.add(ComposerControls, { id: "model", component: () => <First slot={ComposerModelPart} /> }));
    add(
      slots.add(ComposerModelPart, {
        id: "llm.model-picker",
        phase: "default",
        component: () => (
          <Show when={!ownModel()}>
            <ModelPicker
              models={models}
              afterPick={() => runAction(ThreadsActionIds.focusComposer)}
              onProviders={providers()}
              controller={(handle) => setOpen(() => handle.open)}
            />
          </Show>
        ),
      }),
    );
    add(
      slots.add(ComposerControls, {
        id: "thinking",
        order: 10,
        component: () => (
          <Show when={!ownModel()}>
            <ThinkingPicker models={models} afterPick={() => runAction(ThreadsActionIds.focusComposer)} />
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
        when: () => open() !== undefined,
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
