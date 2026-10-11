import type { AuthType, CustomProviderSpec, ModelInfo, ModelRef, ProviderInfo, ThinkingLevel } from "../llm.ts";
import { Context } from "effect";
import type { Accessor } from "solid-js";

export interface ModelsService {
  readonly providers: Accessor<readonly ProviderInfo[]>;
  readonly providersLoaded: Accessor<boolean>;
  /** Models usable now. */
  readonly models: Accessor<readonly ModelInfo[]>;
  readonly modelsLoaded: Accessor<boolean>;
  /** Some provider is set up. */
  readonly configured: Accessor<boolean>;
  /** The remembered choice, which may name a model that is not available. */
  readonly preferred: Accessor<string | undefined>;
  readonly selected: Accessor<ModelInfo | undefined>;
  readonly thinking: Accessor<ThinkingLevel | undefined>;
  readonly choose: (ref: string | undefined) => void;
  /** Remembered for the selected model only. */
  readonly chooseThinking: (level: ThinkingLevel) => void;
  readonly favorites: Accessor<readonly string[]>;
  readonly toggleFavorite: (ref: string) => void;
  /** What the next turn should use: the agent's `TurnOptions`. */
  readonly turnOptions: () => ModelChoice | undefined;
  /** The provider whose login is running. */
  readonly loggingIn: Accessor<string | undefined>;
  /** Resolves true once the provider is connected; a cancelled login resolves false without a message. */
  readonly login: (provider: ProviderInfo, type: AuthType) => Promise<boolean>;
  /** Stops the provider's running login, from this client or another; false when none was running. */
  readonly cancelLogin: (provider: ProviderInfo) => Promise<boolean>;
  readonly logout: (provider: ProviderInfo) => Promise<void>;
  /** Adds a provider of the user's; resolves with it once the host lists it. Rejects when the host refuses. */
  readonly addCustom: (spec: CustomProviderSpec) => Promise<ProviderInfo>;
  /** Removes a provider `addCustom` added, and its logo; resolves once the host no longer lists it. */
  readonly removeCustom: (provider: ProviderInfo) => Promise<void>;
  /** Sets or clears a custom provider's logo (SVG the caller has checked); resolves once the host lists it. */
  readonly setLogo: (provider: ProviderInfo, svg: string | undefined) => Promise<void>;
  readonly refresh: () => Promise<void>;
}

export class Models extends Context.Service<Models, ModelsService>()("lemma-web/Models") {}

/** Actions other plugins run by id (`slots.get(Actions, id)?.run()`), so a replacement keeps the id and what calls it keeps working. */
export const LlmActionIds = { providers: "providers.open" } as const;

/** A model and a thinking level, as a turn names them (`TurnOptions` in `@lemma/agent`). */
export interface ModelChoice {
  readonly model?: ModelRef | undefined;
  readonly thinking?: ThinkingLevel | undefined;
}
