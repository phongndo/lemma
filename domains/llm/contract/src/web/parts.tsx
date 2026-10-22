import type { AuthType, ModelRef, ProviderInfo, ThinkingLevel } from "../llm.ts";
import { definePart, partView } from "@lemma/web";

export interface ProviderLogoProps {
  readonly id: string;
  readonly name: string;
  readonly custom?: string | undefined;
}

export const ProviderLogoPart = definePart<ProviderLogoProps>("provider-logo");

export interface ProviderRowProps {
  readonly provider: ProviderInfo;
  /** Starts a login by this method; the Providers page answers its questions. */
  readonly login: (type: AuthType) => void;
}

/** A provider on the Providers page: its logo, status, models, and login or logout. */
export const ProviderRowPart = definePart<ProviderRowProps>("providers.row");

export interface ModelPickerProps {
  /** The model chosen: checked in the list, and named on the button (as unavailable while no provider lists it). */
  readonly value: ModelRef | undefined;
  readonly choose: (ref: ModelRef) => void;
}

/**
 * A setting's model, chosen as the composer's is (searched, by provider, with favorites), for a choice of a plugin's
 * own: it leaves the composer's model alone.
 */
export const ModelPickerPart = definePart<ModelPickerProps>("model-picker");

export interface ThinkingPickerProps {
  /** The model whose levels it offers (`thinkingLevels`): it shows nothing for one that offers no choice. */
  readonly model: ModelRef | undefined;
  readonly value: ThinkingLevel | undefined;
  readonly choose: (level: ThinkingLevel) => void;
}

/** How hard a setting's model reasons, chosen as the composer's level is, of the levels that model offers. */
export const ThinkingPickerPart = definePart<ThinkingPickerProps>("thinking-picker");

export const ProviderLogo = partView(ProviderLogoPart);

export const ProviderRowView = partView(ProviderRowPart);

export const ModelPickerView = partView(ModelPickerPart);

export const ThinkingPickerView = partView(ThinkingPickerPart);
