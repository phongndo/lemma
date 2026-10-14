import type { AuthType, ProviderInfo } from "../llm.ts";
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

export const ProviderLogo = partView(ProviderLogoPart);

export const ProviderRowView = partView(ProviderRowPart);

/**
 * The composer's model control: `llm.model-picker`'s picker of Lemma's models by default, in the phase `default`. A
 * picker that also chooses what runs the turn (the agent picker, with each harness's models) takes its place.
 */
export const ComposerModelPart = definePart<{}>("composer.model");
