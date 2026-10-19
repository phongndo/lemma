/**
 * The version of the settings domain's contract, as a plugin names it in `uses` and its provider in `implements`
 * (`ContractVersions` in `@lemma/core`). Raised when a change breaks plugins written against it: something removed or
 * renamed, or a meaning changed; never for an addition.
 */
export const SETTINGS_CONTRACT = "lemma/settings@1";
