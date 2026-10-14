import { For, Show, createMemo, createSignal } from "solid-js";
import { NATIVE_HARNESS } from "@lemma/agent";
import type { HarnessInfo, HarnessModel } from "@lemma/agent";
import { filterModels, ProviderLogo } from "@lemma/llm/web";
import type { ModelsService } from "@lemma/llm/web";
import { AlertIcon, BotIcon, CheckIcon, ChevronDownIcon, Popover, SearchIcon } from "@lemma/look";
import type { Placement } from "@lemma/look";
import { matchesQuery } from "@lemma/web/match";
import { Logo } from "./logo.tsx";

/** A harness's mark, or a generic one for a harness that brings none. */
export function HarnessMark(props: { harness: HarnessInfo | undefined; size?: number }) {
  return (
    <Show when={props.harness?.logo} fallback={<BotIcon />}>
      {(logo) => <Logo logo={logo()} size={props.size ?? 14} />}
    </Show>
  );
}

export interface AgentModelPickerProps {
  readonly harnesses: readonly HarnessInfo[];
  /** The harness the next turn runs on. */
  readonly current: string;
  /** Lemma's own models, and the one picked. */
  readonly models: ModelsService;
  /** The model picked for another harness; none: the agent's own default. */
  readonly modelOf: (harness: string) => string | undefined;
  readonly pickNative: (ref: string) => void;
  readonly pickAgent: (harness: string, model: string | undefined) => void;
  readonly setUp: () => void;
  /** Connecting a provider, when there is a way to: for Lemma with no model. */
  readonly connect?: (() => void) | undefined;
  readonly placement?: Placement;
  readonly controller?: (handle: { readonly open: () => void }) => void;
}

/** The model a harness runs on now, by its name. */
const agentModel = (harness: HarnessInfo | undefined, picked: string | undefined): HarnessModel | undefined => {
  const id = picked ?? harness?.status.model;
  return harness?.status.models?.find((model) => model.id === id);
};

/**
 * The composer's model control when turns can run on other agents: the harnesses on the left, each by its mark (Lemma,
 * Claude Code, Codex, pi…), and the models of the one shown on the right: Lemma's, by provider, or the agent's own.
 * Picking a model picks its harness too.
 */
export function AgentModelPicker(props: AgentModelPickerProps) {
  const [query, setQuery] = createSignal("");
  const [rail, setRail] = createSignal(props.current);
  const harness = (id: string) => props.harnesses.find((candidate) => candidate.id === id);
  const shown = () => harness(rail());
  const currentHarness = () => harness(props.current);
  const providerName = (id: string) => props.models.providers().find((provider) => provider.id === id)?.name ?? id;
  const label = () => {
    if (props.current === NATIVE_HARNESS) return props.models.selected()?.name ?? "Choose a model";
    return agentModel(currentHarness(), props.modelOf(props.current))?.name ?? currentHarness()?.title ?? props.current;
  };
  const tip = () => `${currentHarness()?.title ?? props.current} · ${label()}`;
  const nativeGroups = createMemo(() => filterModels(props.models.models(), query()));
  /** The shown agent's models matching the search, its default first. */
  const agentModels = createMemo(() => {
    const models = (shown()?.status.models ?? []).filter((model) => matchesQuery(query(), `${model.name} ${model.id} ${model.description ?? ""}`));
    const first = shown()?.status.model;
    return [...models.filter((model) => model.id === first), ...models.filter((model) => model.id !== first)];
  });
  const railKeys = (event: KeyboardEvent) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    if (!event.altKey) return;
    const ids = props.harnesses.map((candidate) => candidate.id);
    const index = ids.indexOf(rail());
    event.preventDefault();
    setRail(ids[(index + (event.key === "ArrowDown" ? 1 : -1) + ids.length) % ids.length]!);
  };
  return (
    <Popover
      label="Model"
      tip={tip()}
      triggerClass="harness-chip"
      placement={props.placement ?? "top-start"}
      menuClass="amp-menu"
      onOpen={() => {
        setQuery("");
        setRail(props.current);
      }}
      {...(props.controller === undefined ? {} : { controller: props.controller })}
      trigger={
        <>
          <HarnessMark harness={currentHarness()} />
          <span class="harness-label">{label()}</span>
          <ChevronDownIcon />
        </>
      }
    >
      {(close) => (
        <>
          <label class="amp-search">
            <SearchIcon />
            <input
              placeholder={`Search ${shown()?.title ?? ""} models`}
              aria-label="Search models"
              autocomplete="off"
              spellcheck={false}
              data-autofocus
              value={query()}
              onInput={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={railKeys}
            />
          </label>
          <div class="amp-body">
            <nav class="amp-rail" aria-label="Agents">
              <For each={props.harnesses}>
                {(candidate) => (
                  <button
                    type="button"
                    class="amp-rail-item"
                    classList={{ active: rail() === candidate.id, unavailable: candidate.status.state !== "ready" }}
                    tabindex="-1"
                    aria-label={candidate.title}
                    aria-pressed={rail() === candidate.id}
                    data-tip={candidate.status.state === "ready" ? candidate.title : `${candidate.title}: ${candidate.status.detail ?? "cannot run turns now"}`}
                    onClick={() => setRail(candidate.id)}
                  >
                    <HarnessMark harness={candidate} size={18} />
                  </button>
                )}
              </For>
            </nav>
            <div class="amp-list" role="listbox" aria-label={`${shown()?.title ?? ""} models`}>
              <div class="amp-heading">
                <span>{shown()?.title}</span>
                <Show when={shown()?.description}>{(description) => <span class="amp-heading-detail">{description()}</span>}</Show>
              </div>
              <Show
                when={shown()?.status.state !== "unavailable"}
                fallback={
                  <div class="amp-empty">
                    <AlertIcon />
                    <span>{shown()?.status.detail ?? "It cannot run turns now."}</span>
                    <Show
                      when={rail() === NATIVE_HARNESS ? props.connect : undefined}
                      fallback={
                        <button
                          type="button"
                          class="button small"
                          onClick={() => {
                            close();
                            props.setUp();
                          }}
                        >
                          Set it up
                        </button>
                      }
                    >
                      {(connect) => (
                        <button
                          type="button"
                          class="button small"
                          onClick={() => {
                            close();
                            connect()();
                          }}
                        >
                          Connect a provider
                        </button>
                      )}
                    </Show>
                  </div>
                }
              >
                <Show
                  when={rail() === NATIVE_HARNESS}
                  fallback={
                    <Show
                      when={(shown()?.status.models?.length ?? 0) > 0}
                      fallback={
                        <>
                          <button
                            type="button"
                            class="amp-item"
                            role="option"
                            aria-selected={props.current === rail()}
                            onClick={() => {
                              props.pickAgent(rail(), undefined);
                              close();
                            }}
                          >
                            <span class="amp-check">
                              <Show when={props.current === rail()}>
                                <CheckIcon />
                              </Show>
                            </span>
                            <span class="amp-item-text">
                              <span>Its default model</span>
                              <span class="amp-item-detail">It has not listed its models yet: Check it in Settings › Integrations to choose one.</span>
                            </span>
                          </button>
                        </>
                      }
                    >
                      <For each={agentModels()} fallback={<p class="amp-note">No model matches.</p>}>
                        {(model) => {
                          const selected = () => props.current === rail() && agentModel(shown(), props.modelOf(rail()))?.id === model.id;
                          return (
                            <button
                              type="button"
                              class="amp-item"
                              role="option"
                              aria-selected={selected()}
                              onClick={() => {
                                props.pickAgent(rail(), model.id);
                                close();
                              }}
                            >
                              <span class="amp-check">
                                <Show when={selected()}>
                                  <CheckIcon />
                                </Show>
                              </span>
                              <span class="amp-item-text">
                                <span>
                                  {model.name}
                                  <Show when={model.id === shown()?.status.model}>
                                    <span class="amp-badge">default</span>
                                  </Show>
                                </span>
                                <Show when={model.description}>{(description) => <span class="amp-item-detail">{description()}</span>}</Show>
                              </span>
                            </button>
                          );
                        }}
                      </For>
                    </Show>
                  }
                >
                  <For
                    each={nativeGroups()}
                    fallback={
                      <div class="amp-empty">
                        <span>{props.models.models().length === 0 ? "No model is available: connect a provider." : "No model matches."}</span>
                        <Show when={props.models.models().length === 0 && props.connect}>
                          {(connect) => (
                            <button
                              type="button"
                              class="button small"
                              onClick={() => {
                                close();
                                connect()();
                              }}
                            >
                              Connect a provider
                            </button>
                          )}
                        </Show>
                      </div>
                    }
                  >
                    {(group) => (
                      <>
                        <div class="amp-group">
                          <ProviderLogo
                            id={group.provider}
                            name={providerName(group.provider)}
                            custom={props.models.providers().find((provider) => provider.id === group.provider)?.logo}
                          />
                          <span>{providerName(group.provider)}</span>
                        </div>
                        <For each={group.models}>
                          {(model) => {
                            const selected = () => props.current === NATIVE_HARNESS && props.models.selected()?.ref === model.ref;
                            return (
                              <button
                                type="button"
                                class="amp-item"
                                role="option"
                                aria-selected={selected()}
                                onClick={() => {
                                  props.pickNative(model.ref);
                                  close();
                                }}
                              >
                                <span class="amp-check">
                                  <Show when={selected()}>
                                    <CheckIcon />
                                  </Show>
                                </span>
                                <span class="amp-item-text">
                                  <span>{model.name}</span>
                                  <span class="amp-item-detail">{model.id}</span>
                                </span>
                              </button>
                            );
                          }}
                        </For>
                      </>
                    )}
                  </For>
                </Show>
              </Show>
            </div>
          </div>
          <div class="amp-foot">
            <button
              type="button"
              class="link-button"
              onClick={() => {
                close();
                props.setUp();
              }}
            >
              Set up agents…
            </button>
            <span class="amp-hint">Alt ↑↓ moves between agents</span>
          </div>
        </>
      )}
    </Popover>
  );
}
