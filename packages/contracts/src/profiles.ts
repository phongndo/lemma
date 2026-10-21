import { join } from "node:path";
import { Effect, Schema } from "effect";
import { readJsonFile } from "./fs.ts";

/*
 * Node only: `@lemma/contracts/profiles`. A profile is a home of its own, served by a host of its own, apart from every
 * other profile's, as a browser's profiles are (docs/configuration.md#profiles). The default profile is the home
 * itself (`~/.lemma`, or `$LEMMA_HOME`), the root the others live under, each in `<root>/profiles/<name>`.
 * `LEMMA_PROFILE` names the one a host runs for and a client goes to; unset, or `default`, it is the root's own. Which
 * home a host runs for is decided before any plugin runs, so it is the runtime's; listing and making profiles is the
 * profiles domain's (`@lemma/profiles/local`).
 */

/** The default profile's name: the root's own. */
export const DEFAULT_PROFILE = "default";

/** Why `name` cannot name a profile, or undefined when it can: a lowercase word (`work`, `trading-desk`), its folder's name. */
export const profileNameProblem = (name: string): string | undefined =>
  /^[a-z0-9][a-z0-9_-]{0,39}$/.test(name) ? undefined : `"${name}" is no profile name: use lowercase letters, digits, - and _ (at most 40)`;

/** The profile `LEMMA_PROFILE` names; undefined for the default (unset, blank, or `default`). Not checked: see `profileNameProblem`. */
export const profileOf = (env: Readonly<Record<string, string | undefined>>): string | undefined => {
  const name = env.LEMMA_PROFILE?.trim();
  return name === undefined || name === "" || name === DEFAULT_PROFILE ? undefined : name;
};

/** The folder the profiles other than the default live in. */
export const profilesDir = (root: string): string => join(root, "profiles");

/** A profile's home: the root for the default, else `<root>/profiles/<name>`. */
export const profileHome = (root: string, name: string | undefined): string =>
  name === undefined || name === DEFAULT_PROFILE ? root : join(profilesDir(root), name);

/** `<home>/profile.json`: what a profile keeps of itself, apart from its config. */
export const ProfileFile = Schema.Struct({
  /**
   * The port its host listens on unless its config names another: chosen when it was made and kept, so its address
   * stays the same, and with it what a browser keeps for the address.
   */
  port: Schema.optional(Schema.Int),
});
export type ProfileFile = typeof ProfileFile.Type;

export const profileFilePath = (home: string): string => join(home, "profile.json");

/** A profile's `profile.json`, or undefined when it has none (the default never needs one) or it does not decode. */
export const readProfileFile = (home: string): Effect.Effect<ProfileFile | undefined> => Effect.promise(() => readJsonFile(profileFilePath(home), ProfileFile));
