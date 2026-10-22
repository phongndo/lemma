import { For, Show, createMemo, createSignal, onCleanup } from "solid-js";
import type { Accessor, Setter } from "solid-js";
import { usesPlan } from "@lemma/llm";
import type { ModelInfo, ModelRef, ThinkingLevel } from "@lemma/llm";
import { contextSize } from "./context-size.ts";
import { DEFAULT_THINKING, filterModels, thinkingLevels, Models, LlmActionIds, ModelPickerPart, ProviderLogo, ThinkingPickerPart } from "@lemma/llm/web";
import type { ModelPickerProps, ThinkingPickerProps } from "@lemma/llm/web";
import { Actions } from "@lemma/actions";
import { SectionIds, SettingsGroups } from "@lemma/settings";
import { ComposerControls, PromptCommands, ThreadsActionIds } from "@lemma/threads";
import { Slots, defineWebPlugin } from "@lemma/web";
import type { ModelsService } from "@lemma/llm/web";
import { BrainIcon, CheckIcon, ChevronDownIcon, ImageIcon, PlusIcon, Popover, SearchIcon, SettingRow, StarIcon } from "@lemma/look";
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

/**
 * What a reasoning picker shows and sets: the level of the composer's model, or a setting's own (`ThinkingPickerPart`),
 * whose chip sits beside its model's in the same row. A picker is one or the other for as long as it is drawn.
 */
interface LevelChoice {
  readonly model: () => ModelInfo | undefined;
  readonly level: () => ThinkingLevel | undefined;
  readonly choose: (level: ThinkingLevel) => void;
  readonly besideModel: boolean;
}

const composerLevel = (models: ModelsService): LevelChoice => ({
  model: models.selected,
  level: models.thinking,
  choose: models.chooseThinking,
  besideModel: false,
});

const settingLevel = (models: ModelsService, own: ThinkingPickerProps): LevelChoice => ({
  model: () => models.models().find((model) => model.ref === own.model),
  level: () => own.value,
  choose: (level) => own.choose(level),
  besideModel: true,
});

/**
 * The model's own reasoning levels; the composer's choice is remembered per model. `quiet`: in the composer's row,
 * after the model with a dot, its level alone, with no chevron. `own`: a setting's model and level instead.
 */
function ThinkingPicker(props: {
  models: ModelsService;
  own?: ThinkingPickerProps;
  placement?: Placement;
  afterPick?: () => void;
  controller?: (handle: { readonly open: () => void }) => void;
  quiet?: boolean;
}) {
  const choice = props.own === undefined ? composerLevel(props.models) : settingLevel(props.models, props.own);
  const { model: selectedModel, level: effectiveThinking, choose: chooseThinking } = choice;
  const levels = createMemo(() => thinkingLevels(selectedModel()));
  return (
    <Show when={levels().length > 0}>
      <Show when={props.quiet} fallback={choice.besideModel ? undefined : <span class="control-separator" aria-hidden="true" />}>
        <span class="control-dot" aria-hidden="true">
          ·
        </span>
      </Show>
      <Popover
        label="Reasoning"
        tip={`Reasoning for ${selectedModel()?.name ?? "this model"}`}
        triggerClass={props.quiet ? "select-chip quiet" : "select-chip"}
        menuClass="thinking-menu"
        placement={props.placement ?? "top-start"}
        {...(props.controller === undefined ? {} : { controller: props.controller })}
        trigger={
          <>
            <Show when={!props.quiet}>
              <BrainIcon />
            </Show>
            <span>{LEVEL_LABEL[effectiveThinking() ?? DEFAULT_THINKING]}</span>
            <ChevronDownIcon />
          </>
        }
      >
        {(close) => (
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
        )}
      </Popover>
    </Show>
  );
}

type Rail = "favorites" | "all" | string;

/**
 * What a model picker shows and sets: the composer's preferred model, or a setting's own (`ModelPickerPart`). A picker
 * is one or the other for as long as it is drawn.
 */
interface ModelChoice {
  /** The model it names, of those available. */
  readonly selected: () => ModelInfo | undefined;
  /** The model chosen, which may be unavailable. */
  readonly wanted: () => ModelRef | undefined;
  readonly choose: (ref: ModelRef) => void;
}

const composerModel = (models: ModelsService): ModelChoice => ({ selected: models.selected, wanted: models.preferred, choose: models.choose });

const settingModel = (models: ModelsService, own: ModelPickerProps): ModelChoice => ({
  selected: () => models.models().find((model) => model.ref === own.value),
  wanted: () => own.value,
  choose: (ref) => own.choose(ref),
});

/** Picks the composer's preferred model, in the composer and in settings, or a setting's own (`own`). */
function ModelPicker(props: {
  models: ModelsService;
  own?: ModelPickerProps;
  placement?: Placement;
  afterPick?: () => void;
  onProviders?: (() => void) | undefined;
  controller?: (handle: { readonly open: () => void }) => void;
  /** In the composer's row: with no chevron. */
  quiet?: boolean;
}) {
  const { favorites: favoriteModels, toggleFavorite } = props.models;
  const choice = props.own === undefined ? composerModel(props.models) : settingModel(props.models, props.own);
  const { selected: selectedModel, choose: chooseModel } = choice;
  const [query, setQuery] = createSignal("");
  const [rail, setRail] = createSignal<Rail>("all");
  const providerName = (id: string) => props.models.providers().find((provider) => provider.id === id)?.name ?? id;
  /** Providers whose requests use the person's plan, not a price per token. */
  const onPlan = createMemo(
    () =>
      new Set(
        props.models
          .providers()
          .filter(usesPlan)
          .map((provider) => provider.id),
      ),
  );
  const providers = createMemo(() => [...new Set(props.models.models().map((model) => model.provider))]);
  /** The rail, while it has something to choose between: providers, or favorites besides all. */
  const railShown = () => providers().length > 1 || favoriteModels().length > 0;
  /** The list mixes providers' models: each row shows its provider's logo, as one model may come from several. */
  const mixed = () => providers().length > 1 && (query().trim() !== "" || rail() === "all" || rail() === "favorites");
  const shown = createMemo((): readonly ModelInfo[] => {
    // Searching always covers every model.
    if (query().trim() !== "") return filterModels(props.models.models(), query()).flatMap((group) => group.models);
    if (rail() === "favorites") return favoriteModels().flatMap((ref) => props.models.models().filter((model) => model.ref === ref));
    if (rail() === "all") return props.models.models();
    return props.models.models().filter((model) => model.provider === rail());
  });
  const label = () => selectedModel()?.name ?? (choice.wanted() !== undefined && props.models.modelsLoaded() ? "Model unavailable" : "Choose a model");
  const pick = (ref: ModelRef, close: () => void) => {
    chooseModel(ref);
    close();
    props.afterPick?.();
  };
  const railKeys = (event: KeyboardEvent) => {
    if (!railShown() || query() !== "" || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
    const keys: Rail[] = [...(favoriteModels().length > 0 ? ["favorites"] : []), "all", ...providers()];
    const index = keys.indexOf(rail());
    event.preventDefault();
    setRail(keys[(index + (event.key === "ArrowRight" ? 1 : -1) + keys.length) % keys.length]!);
  };

  return (
    <Popover
      label="Model"
      tip={selectedModel() === undefined ? "Model" : `${providerName(selectedModel()!.provider)} · ${selectedModel()!.id}`}
      triggerClass={props.quiet ? "select-chip quiet" : "select-chip"}
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
            {/* Another provider's models: connecting one is a step away. */}
            <Show when={props.onProviders}>
              {(open) => (
                <button
                  type="button"
                  class="icon-button model-connect"
                  tabindex="-1"
                  aria-label="Connect a provider"
                  data-tip="Connect a provider"
                  onClick={(event) => {
                    event.preventDefault();
                    close();
                    open()();
                  }}
                >
                  <PlusIcon />
                </button>
              )}
            </Show>
          </label>
          <div class="model-body" classList={{ "no-rail": !railShown() }}>
            <Show when={railShown()}>
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
            </Show>
            <div class="model-list" role="listbox">
              <For each={shown()}>
                {(model) => {
                  const selected = () => selectedModel()?.ref === model.ref;
                  const favorite = () => favoriteModels().includes(model.ref);
                  return (
                    <div class="model-row menu-item" role="option" aria-selected={selected()} onClick={() => pick(model.ref, close)}>
                      <Show when={mixed()}>
                        <span class="model-logo" data-tip={providerName(model.provider)}>
                          <ProviderLogo
                            id={model.provider}
                            name={providerName(model.provider)}
                            custom={props.models.providers().find((candidate) => candidate.id === model.provider)?.logo}
                          />
                        </span>
                      </Show>
                      <span class="model-name">{model.name}</span>
                      <span class="model-meta">
                        <Show when={onPlan().has(model.provider)}>
                          <span class="model-plan" data-tip="Included in your plan">
                            Plan
                          </span>
                        </Show>
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
                      {/* Its place kept on every row, so what models offer lines up. */}
                      <span class="model-current">
                        <Show when={selected()}>
                          <CheckIcon />
                        </Show>
                      </span>
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
                    <Show
                      when={rail() === "favorites" && query() === ""}
                      fallback={
                        <>
                          No matching models.{" "}
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
                                Connect another provider
                              </button>
                            )}
                          </Show>
                        </>
                      }
                    >
                      Star a model to keep it here
                    </Show>
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
 * settings, and behind "Switch model…"; and for another plugin's setting
 * (`ModelPickerPart`, `ThinkingPickerPart`).
 */
export default defineWebPlugin({
  id: "llm.model-picker",
  styles,
  requires: { models: Models, slots: Slots },
  setup: ({ models, slots }, plugin) => {
    // The composer's pickers, opened by their actions while they are drawn (the reasoning one, while the model reasons).
    const [open, setOpen] = createSignal<() => void>();
    const [openThinking, setOpenThinking] = createSignal<() => void>();
    const keep = (get: Accessor<(() => void) | undefined>, set: Setter<(() => void) | undefined>) => (handle: { readonly open: () => void }) => {
      set(() => handle.open);
      onCleanup(() => {
        if (get() === handle.open) set(undefined);
      });
    };
    /** Other plugins' actions, run when they exist: focus the prompt, open the providers settings. */
    const runAction = (id: string) => slots.get(Actions, id)?.run();
    const providers = () => (slots.get(Actions, LlmActionIds.providers) === undefined ? undefined : () => runAction(LlmActionIds.providers));
    const add = plugin.onCleanup;
    add(
      slots.add(ComposerControls, {
        id: "model",
        component: () => (
          <ModelPicker
            quiet
            models={models}
            afterPick={() => runAction(ThreadsActionIds.focusComposer)}
            onProviders={providers()}
            controller={keep(open, setOpen)}
          />
        ),
      }),
    );
    add(
      slots.add(ComposerControls, {
        id: "thinking",
        order: 10,
        component: () => (
          <ThinkingPicker quiet models={models} afterPick={() => runAction(ThreadsActionIds.focusComposer)} controller={keep(openThinking, setOpenThinking)} />
        ),
      }),
    );
    add(
      slots.add(ModelPickerPart, {
        id: "model-picker",
        phase: "default",
        component: (props: ModelPickerProps) => <ModelPicker models={models} own={props} placement="bottom-end" onProviders={providers()} />,
      }),
    );
    add(
      slots.add(ThinkingPickerPart, {
        id: "thinking-picker",
        phase: "default",
        component: (props: ThinkingPickerProps) => <ThinkingPicker models={models} own={props} placement="bottom-end" />,
      }),
    );
    /** The models `query` names: the one with that ref first, then those a search finds, in the picker's order. */
    const modelsFor = (query: string) => {
      const exact = models.models().filter((model) => model.ref === query);
      return [...exact, ...filterModels(models.models(), query).flatMap((group) => group.models.filter((model) => model.ref !== query))];
    };
    add(
      slots.add(PromptCommands, {
        id: "model",
        order: 29,
        description: "Choose the model, by its id or a search",
        icon: BrainIcon,
        args: [
          {
            name: "model",
            // As `run` chooses: the model with that ref, then those a search finds, in the picker's order.
            ranked: true,
            values: ({ query }) => {
              const current = models.selected()?.ref;
              return modelsFor(query).map((model) => ({ value: model.ref, detail: model.ref === current ? `${model.name} · current` : model.name }));
            },
          },
        ],
        run: ({ text }) => {
          const found = modelsFor(text)[0];
          if (found === undefined) throw new Error(models.models().length === 0 ? "No models yet: log in to a provider" : `No model matches “${text}”`);
          models.choose(found.ref);
        },
      }),
    );
    add(
      slots.add(PromptCommands, {
        id: "thinking",
        order: 30,
        description: "Set how hard the model reasons",
        icon: BrainIcon,
        args: [
          {
            name: "level",
            values: () => {
              const current = models.thinking() ?? DEFAULT_THINKING;
              return thinkingLevels(models.selected()).map((level) => ({ value: level, ...(level === current ? { detail: "current" } : {}) }));
            },
          },
        ],
        run: ({ args }) => {
          const levels = thinkingLevels(models.selected());
          const name = models.selected()?.name ?? "The selected model";
          if (levels.length === 0) throw new Error(`${name} has no reasoning levels`);
          const level = levels.find((candidate) => candidate === args[0]?.toLowerCase());
          if (level === undefined) throw new Error(`Choose one of ${levels.join(", ")} for ${name}`);
          models.chooseThinking(level);
        },
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
        // As Codex and T3 Code have it.
        keys: "mod+shift+m",
        when: () => open() !== undefined,
        run: () => open()?.(),
      }),
    );
    add(
      slots.add(Actions, {
        id: "model-picker.thinking",
        order: 2,
        title: "Switch reasoning level…",
        category: "Model",
        keywords: ["thinking", "effort"],
        icon: BrainIcon,
        // As T3 Code has it: E for effort.
        keys: "mod+shift+e",
        when: () => openThinking() !== undefined,
        run: () => openThinking()?.(),
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
