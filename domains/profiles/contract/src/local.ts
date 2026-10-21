import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { Data, Effect, Schema } from "effect";
import { readDiscovery } from "@lemma/contracts/discovery";
import type { Discovery } from "@lemma/contracts/discovery";
import { errorCode, writeFileAtomic } from "@lemma/contracts/fs";
import { DEFAULT_PROFILE, profileFilePath, profileHome, profileNameProblem, profilesDir, readProfileFile } from "@lemma/contracts/profiles";
import type { ProfileFile } from "@lemma/contracts/profiles";
import { MAX_PICTURE_BYTES } from "./profiles.ts";
import type { AvatarChange, ProfileAvatar } from "./profiles.ts";

/*
 * Node only: `@lemma/profiles/local`. The profiles on this machine, as their folders under the root say
 * (`@lemma/contracts/profiles`): listed, with each one's port and running host, and made, and each one's picture. The
 * CLI's `lemma profile` and the profiles plugin use them alike.
 */

/** A profile as it is on this machine. */
export interface ProfileEntry {
  /** `default` for the root's own. */
  readonly name: string;
  readonly home: string;
  /** Its `profile.json`'s port, when it has one. */
  readonly port?: number;
  /** Its host, while one runs. */
  readonly running?: Discovery;
}

const entryOf = (root: string, name: string): Effect.Effect<ProfileEntry> =>
  Effect.gen(function* () {
    const home = profileHome(root, name);
    const [file, running] = yield* Effect.all([readProfileFile(home), readDiscovery(home)], { concurrency: "unbounded" });
    return { name, home, ...(file?.port === undefined ? {} : { port: file.port }), ...(running === undefined ? {} : { running }) };
  });

/** The profiles under `root`: the default first, then the others by name. A folder whose name is no profile name is none. */
export const listProfiles = (root: string): Effect.Effect<readonly ProfileEntry[]> =>
  Effect.gen(function* () {
    const folders = yield* Effect.promise(async () => {
      const entries = await readdir(profilesDir(root), { withFileTypes: true }).catch(() => []);
      const named = entries.filter((entry) => profileNameProblem(entry.name) === undefined && entry.name !== DEFAULT_PROFILE);
      // A folder, or a link to one, as `--profile` reaches it.
      const isFolder = (name: string) =>
        stat(join(profilesDir(root), name)).then(
          (found) => found.isDirectory(),
          () => false,
        );
      const kept = await Promise.all(
        named.map(async (entry) => (entry.isDirectory() || (entry.isSymbolicLink() && (await isFolder(entry.name))) ? entry.name : undefined)),
      );
      return kept.filter((name) => name !== undefined);
    });
    const names = [DEFAULT_PROFILE, ...folders.sort()];
    return yield* Effect.forEach(names, (name) => entryOf(root, name), { concurrency: "unbounded" });
  });

/** The port a profile's host listens on, as its address says: its host's while one runs, else its `profile.json`'s. */
export const portOf = (entry: ProfileEntry): number | undefined => {
  if (entry.running !== undefined) {
    const port = Number(new URL(entry.running.url).port);
    if (Number.isInteger(port) && port > 0) return port;
  }
  return entry.port;
};

/** The port profiles start from; the transport's default (7433) stays the default profile's. */
export const FIRST_PROFILE_PORT = 7434;

/** Whether nothing listens on `port` on loopback now. */
const isFree = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });

/** The lowest port from `FIRST_PROFILE_PORT` that no profile under `root` keeps, and nothing listens on now. */
export const freeProfilePort = (root: string): Effect.Effect<number> =>
  Effect.gen(function* () {
    const taken = new Set((yield* listProfiles(root)).flatMap((entry) => [entry.port, portOf(entry)].filter((port) => port !== undefined)));
    for (let port = FIRST_PROFILE_PORT; port < 65_536; port++) {
      if (!taken.has(port) && (yield* Effect.promise(() => isFree(port)))) return port;
    }
    return 0;
  });

/**
 * A profile cannot be made, or given a picture: `Name`, its name is none (`profileNameProblem`) or `default`; `Exists`,
 * a folder of the name is there; `Picture`, what was given is no picture it takes; `Write`, a file could not be
 * written.
 */
export class ProfileError extends Data.TaggedError("ProfileError")<{
  readonly reason: "Name" | "Exists" | "Picture" | "Write";
  readonly message: string;
}> {}

/**
 * Makes the profile `name` under `root`: its home, empty but for a `profile.json` naming a port of its own
 * (`freeProfilePort`). Everything else it gets as a fresh home does, from its first host.
 */
export const createProfile = (root: string, name: string): Effect.Effect<ProfileEntry, ProfileError> =>
  Effect.gen(function* () {
    const problem = name === DEFAULT_PROFILE ? `"${DEFAULT_PROFILE}" is the profile ${root} itself` : profileNameProblem(name);
    if (problem !== undefined) return yield* new ProfileError({ reason: "Name", message: problem });
    const home = profileHome(root, name);
    const port = yield* freeProfilePort(root);
    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(profilesDir(root), { recursive: true, mode: 0o700 });
        // Not recursive: an existing folder is an error, so a profile is never made over another.
        await mkdir(home, { mode: 0o700 });
      },
      catch: (cause) =>
        errorCode(cause) === "EEXIST"
          ? new ProfileError({ reason: "Exists", message: `A profile "${name}" is there already: ${home}` })
          : new ProfileError({ reason: "Write", message: `Cannot make ${home}: ${cause instanceof Error ? cause.message : String(cause)}` }),
    });
    yield* Effect.tryPromise({
      try: () => writeFileAtomic(profileFilePath(home), `${JSON.stringify({ port } satisfies ProfileFile, null, 2)}\n`),
      catch: (cause) =>
        new ProfileError({ reason: "Write", message: `Cannot write ${profileFilePath(home)}: ${cause instanceof Error ? cause.message : String(cause)}` }),
    });
    return { name, home, port };
  });

/** `<home>/avatar.json`: the picture a profile chose, a pattern's seed or its picture's file in its home; none, its name's pattern. */
const AvatarFile = Schema.Struct({ seed: Schema.optional(Schema.String), picture: Schema.optional(Schema.String) });
const avatarFile = (home: string) => join(home, "avatar.json");

/** The pictures a profile takes, by their `data:` URL's type, and the file each is kept in. */
const PICTURES: Readonly<Record<string, string>> = {
  "image/png": "avatar.png",
  "image/jpeg": "avatar.jpg",
  "image/webp": "avatar.webp",
  "image/gif": "avatar.gif",
};
const typeOf = (file: string) => Object.entries(PICTURES).find(([, name]) => name === file)?.[0];

/** The picture of the profile `name`, whose home is `home`: its own, the pattern it chose, else its name's pattern. */
export const readAvatar = (name: string, home: string): Effect.Effect<ProfileAvatar> =>
  Effect.promise(async () => {
    const chosen = await readFile(avatarFile(home), "utf8").then(
      (text) => Schema.decodeUnknownOption(Schema.fromJsonString(AvatarFile))(text),
      () => undefined,
    );
    const file = chosen?._tag === "Some" ? chosen.value : {};
    const type = file.picture === undefined ? undefined : typeOf(file.picture);
    if (type !== undefined) {
      const bytes = await readFile(join(home, file.picture!)).catch(() => undefined);
      if (bytes !== undefined) return { kind: "picture" as const, url: `data:${type};base64,${bytes.toString("base64")}` };
    }
    return { kind: "pattern" as const, seed: file.seed ?? name };
  });

/**
 * Gives the profile whose home is `home` the picture `change` says: a pattern's seed, a picture of its own (a `data:`
 * URL of a PNG, JPEG, WebP, or GIF, kept as `avatar.<type>`), or none, back to its name's pattern.
 */
export const writeAvatar = (home: string, change: AvatarChange): Effect.Effect<void, ProfileError> =>
  Effect.gen(function* () {
    let picture: { readonly file: string; readonly bytes: Buffer } | undefined;
    if (change.kind === "picture") {
      const match = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(change.url);
      const file = match === null ? undefined : PICTURES[match[1]!];
      if (match === null || file === undefined)
        return yield* new ProfileError({ reason: "Picture", message: "A profile's picture is a PNG, JPEG, WebP, or GIF, as a data: URL" });
      const bytes = Buffer.from(match[2]!, "base64");
      if (bytes.length > MAX_PICTURE_BYTES)
        return yield* new ProfileError({ reason: "Picture", message: `A profile's picture holds at most ${MAX_PICTURE_BYTES / 1024} KiB` });
      picture = { file, bytes };
    }
    yield* Effect.tryPromise({
      try: async () => {
        for (const file of Object.values(PICTURES)) if (file !== picture?.file) await rm(join(home, file), { force: true });
        if (change.kind === "default") return void (await rm(avatarFile(home), { force: true }));
        if (picture !== undefined) {
          // Whole or not at all, as `writeFileAtomic` writes text.
          const temp = join(home, `.${picture.file}.${process.pid}.tmp`);
          await writeFile(temp, picture.bytes, { mode: 0o600 });
          await rename(temp, join(home, picture.file));
        }
        const chosen: typeof AvatarFile.Type = change.kind === "pattern" ? { seed: change.seed } : { picture: picture!.file };
        await writeFileAtomic(avatarFile(home), `${JSON.stringify(chosen)}\n`);
      },
      catch: (cause) =>
        new ProfileError({ reason: "Write", message: `Cannot keep the picture in ${home}: ${cause instanceof Error ? cause.message : String(cause)}` }),
    });
  });
