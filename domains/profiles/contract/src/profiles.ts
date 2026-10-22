import { Schema } from "effect";
import { appUrl, deepLinkPath, DEEP_LINK_SCHEME, defineChannel } from "@lemma/contracts";

/*
 * Profiles: the Lemmas on one machine (docs/configuration.md#profiles), each a home and a host of its own
 * (`@lemma/contracts/profiles` says where they live). A host serves the list of its machine's profiles, and opens one,
 * starting its host when none runs, so a client reaches it there: from a page, the same machine at that profile's
 * port. Nothing crosses between profiles but this: what one profile's host answers of the others.
 */

/**
 * A profile's picture, as a client draws it: a pattern made from `seed`, as GitHub draws an account with no picture
 * (unique enough to tell profiles apart, made from its name until another is chosen), or a picture of its own, a
 * `data:` URL of an image.
 */
export const ProfileAvatar = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("pattern"), seed: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("picture"), url: Schema.String }),
]);
export type ProfileAvatar = typeof ProfileAvatar.Type;

/**
 * A change to a profile's picture: another pattern, a picture of its own (a `data:` URL of a PNG, JPEG, WebP, or GIF,
 * at most `MAX_PICTURE_BYTES`), or back to the pattern its name makes.
 */
export const AvatarChange = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("pattern"), seed: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("picture"), url: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("default") }),
]);
export type AvatarChange = typeof AvatarChange.Type;

/** The most a profile's picture may hold, decoded: a client shrinks one to a small square first. */
export const MAX_PICTURE_BYTES = 512 * 1024;

/**
 * What the default profile is called until it is given another name. It is the default's alone, whatever it is
 * called: `--profile core` names it (`isDefaultProfile` in `@lemma/contracts/profiles`).
 */
export const DEFAULT_PROFILE_TITLE = "Core";

/** The longest name a profile can be given. */
export const MAX_TITLE_LENGTH = 60;

/**
 * Why `title` cannot be a profile's name as people read it, or undefined when it can: any text on one line,
 * `MAX_TITLE_LENGTH` at most; for `profile`, when said, not `DEFAULT_PROFILE_TITLE` unless it is the default.
 */
export const titleProblem = (title: string, profile?: Pick<ProfileInfo, "default">): string | undefined => {
  if ([...title].some((char) => char < " " || char === "\u007f")) return "A profile's name is one line of text";
  if (title.trim().length > MAX_TITLE_LENGTH) return `A profile's name is at most ${MAX_TITLE_LENGTH} characters`;
  if (profile?.default === false && title.trim().toLowerCase() === DEFAULT_PROFILE_TITLE.toLowerCase())
    return `${DEFAULT_PROFILE_TITLE} is the default profile's name`;
  return undefined;
};

/** A profile as a host lists it. */
export const ProfileInfo = Schema.Struct({
  /** Its name, which `--profile` takes and its folder has; `default` for the home's own. It never changes. */
  name: Schema.String,
  /** The name it was given to be shown by (`profiles.rename`), any text; absent, `profileTitle` makes one from `name`. */
  title: Schema.optional(Schema.String),
  /** The home's own profile, which every other's is under. */
  default: Schema.Boolean,
  /** The one the host answering runs for. */
  current: Schema.Boolean,
  /** Whether a host runs for it now. */
  running: Schema.Boolean,
  /** The port its host listens on, or will, on its machine: what a client elsewhere reaches it at. */
  port: Schema.optional(Schema.Int),
  /** Its home on its machine, which holds all of it. */
  home: Schema.optional(Schema.String),
  /** Its picture. */
  avatar: ProfileAvatar,
});
export type ProfileInfo = typeof ProfileInfo.Type;

/** A profile's host, opened: its address on its machine, its port, and its token. */
export const OpenedProfile = Schema.Struct({
  name: Schema.String,
  /** Its base URL on its machine (`http://127.0.0.1:7434`). */
  url: Schema.String,
  port: Schema.Int,
  token: Schema.String,
});
export type OpenedProfile = typeof OpenedProfile.Type;

/** What a profiles plugin serves clients: the web app's switcher, the desktop app, and `lemma --profile` with `--env`. */
export const ProfileChannels = {
  list: defineChannel({
    kind: "call",
    id: "profiles.list",
    access: "read",
    title: "List profiles",
    description: "The profiles on the host's machine, the default first, each with whether its host runs",
    payload: Schema.Void,
    success: Schema.Array(ProfileInfo),
    repeatable: true,
  }),
  open: defineChannel({
    kind: "call",
    id: "profiles.open",
    // Its answer is a token: whoever holds it runs that profile's tools.
    access: "secret",
    title: "Open a profile",
    description: "A profile's host, started when none runs: its address on its machine, its port, and its token",
    payload: Schema.Struct({ name: Schema.String }),
    success: OpenedProfile,
    repeatable: true,
  }),
  setAvatar: defineChannel({
    kind: "call",
    id: "profiles.set-avatar",
    access: "change",
    title: "Change a profile's picture",
    description: "Another pattern for a profile, a picture of its own (a data: URL), or back to the pattern its name makes",
    payload: Schema.Struct({ name: Schema.String, avatar: AvatarChange }),
    success: ProfileInfo,
    repeatable: true,
  }),
  create: defineChannel({
    kind: "call",
    id: "profiles.create",
    access: "change",
    title: "Make a profile",
    description: "A new profile on the host's machine: an empty home with a port of its own, its host not yet started, shown as `title` when given",
    payload: Schema.Struct({ name: Schema.String, title: Schema.optional(Schema.String) }),
    success: ProfileInfo,
  }),
  rename: defineChannel({
    kind: "call",
    id: "profiles.rename",
    access: "change",
    title: "Rename a profile",
    description: "Gives a profile the name it is shown by, any text on one line; blank gives it back the one its name makes. Its name for --profile stays",
    payload: Schema.Struct({ name: Schema.String, title: Schema.String }),
    success: ProfileInfo,
    repeatable: true,
  }),
  stop: defineChannel({
    kind: "call",
    id: "profiles.stop",
    access: "change",
    title: "Stop a profile's host",
    description:
      "Stops the host running for another profile, as `lemma --profile <name> stop --force` does: its running turns are cut off, and resume when it starts again",
    payload: Schema.Struct({ name: Schema.String }),
    success: ProfileInfo,
    repeatable: true,
  }),
  remove: defineChannel({
    kind: "call",
    id: "profiles.remove",
    access: "change",
    title: "Delete a profile",
    description:
      "Deletes another profile and everything in its home, its threads, config, plugins, and logins, stopping its host first. Neither the default (the home itself) nor the profile of the host answering",
    payload: Schema.Struct({ name: Schema.String }),
    success: Schema.Void,
  }),
} as const;

/** Addresses a page is served from on its own machine. */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Whether `url` is on loopback: this machine's, or a tunnel to another (`ssh -L`), which a client cannot tell apart.
 * A client of a host on another machine opens none of that machine's other profiles through one: a tunnel carries one
 * port, and another profile's port on loopback would be this machine's.
 */
export const isLoopback = (url: string): boolean => LOOPBACK.has(new URL(url).hostname);

/**
 * Where a client reaches a profile's host, from a page (or host) at `from`: on its own machine (loopback), the address
 * the host gives; from elsewhere, the same scheme and machine at the profile's port, as a profile is exposed beyond
 * its machine (docs/remote.md: each at its own port, `tailscale serve --https=<port> <port>`).
 */
export const profileAddress = (from: string, opened: Pick<OpenedProfile, "url" | "port">): string => {
  const at = new URL(from);
  if (LOOPBACK.has(at.hostname)) return new URL(opened.url).origin;
  return `${at.protocol}//${at.hostname}:${opened.port}`;
};

/** The web app of a profile opened from `from`, at `path`, with its token (see `profileAddress`). */
export const profilePage = (from: string, opened: OpenedProfile, path = "/"): string => appUrl(profileAddress(from, opened), path, opened.token);

/**
 * A profile's name as people read it: the one it was given, else the default's is Core, and another's is its name
 * with its dashes as spaces, capitalized (`trading-desk` is Trading desk).
 */
export const profileTitle = (profile: Pick<ProfileInfo, "name" | "default" | "title">): string => {
  const given = profile.title?.trim();
  if (given !== undefined && given !== "") return given;
  if (profile.default) return DEFAULT_PROFILE_TITLE;
  const words = profile.name.replace(/[-_]+/g, " ").trim() || profile.name;
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/**
 * A name for a new profile shown as `title`, which `--profile` takes and its folder has: the title in lowercase
 * letters, digits, and dashes (`Trading desk` is `trading-desk`), numbered past those `taken`; `profile` when it has
 * none of them.
 */
export const profileNameFor = (title: string, taken: Iterable<string>): string => {
  const used = new Set(taken);
  const base =
    title
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 36)
      .replace(/-+$/, "") || "profile";
  // The default's names are the home's own, which no folder can be: `isDefaultProfile`'s (`@lemma/contracts/profiles`,
  // which reads files, so not here, where a page runs this too).
  if (base !== "default" && base !== DEFAULT_PROFILE_TITLE.toLowerCase() && !used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
};

/**
 * The query parameter a deep link names its profile by (`lemma://threads/abc?profile=desk`):
 * the desktop app shows the address in that profile's window, and takes the parameter off first. Absent, the link is
 * for the profile the app started with.
 */
export const DEEP_LINK_PROFILE = "profile";

/** A deep link to the web app's `path`, in `profile` when one is named, for the app that opens `scheme`'s links. */
export const deepLink = (path: string, profile?: string, scheme = DEEP_LINK_SCHEME): string => {
  const url = new URL(path, "http://app.invalid");
  if (profile !== undefined) url.searchParams.set(DEEP_LINK_PROFILE, profile);
  return `${scheme}://${url.pathname.replace(/^\/+/, "")}${url.search}`;
};

/** A deep link's address, as `deepLinkPath` reads it, without the profile it names (`DEEP_LINK_PROFILE`), and that profile. */
export const deepLinkTarget = (link: string): { readonly path: string; readonly profile?: string } | undefined => {
  const path = deepLinkPath(link);
  if (path === undefined) return undefined;
  const url = new URL(path, "http://app.invalid");
  const profile = url.searchParams.get(DEEP_LINK_PROFILE) ?? undefined;
  url.searchParams.delete(DEEP_LINK_PROFILE);
  return { path: `${url.pathname}${url.search}`, ...(profile === undefined || profile === "" ? {} : { profile }) };
};
