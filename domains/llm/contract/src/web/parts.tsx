import type { AuthType, ProviderInfo } from "../llm.ts";
import { definePart, partView } from "@lemma/ui";

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
