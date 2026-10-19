import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Schema } from "effect";
import { definePlugin, Events } from "@lemma/core";
import { Channels, HostControl, Notice, Paths, resourcesOf, serveChannel } from "@lemma/contracts";
import { AgentRequestHook, ProfileChannels, PROFILES_PLUGIN, PromptSections } from "@lemma/agent";
import type { RequestDraft } from "@lemma/agent";
import { byName, keeps, parseProfile } from "./profile.ts";
import type { Profile } from "./profile.ts";

export { byName, keeps, parseProfile } from "./profile.ts";
export type { Profile } from "./profile.ts";

/** Its row in config.jsonc's `plugins`. */
export const Config = Schema.Struct({
  default: Schema.String.pipe(Schema.withDecodingDefaultType(Effect.sync(() => "coding"))).annotate({
    title: "Default profile",
    description: "The profile a thread has until one is chosen for it.",
  }),
});
export type Config = typeof Config.Type;

/** The profiles that ship with Lemma. */
const BUNDLED = fileURLToPath(new URL("../profiles", import.meta.url));

/**
 * Reads the `.md` files of a directory as profiles, caching each by its size and mtime, so finding a request's profile
 * costs a directory listing and a `stat` a profile, as finding skills does. A directory that is not there has none.
 */
const profileReader = () => {
  const cache = new Map<string, { readonly mtimeMs: number; readonly size: number; readonly profile: Profile }>();
  const read = async (dir: string, name: string, source: Profile["source"]): Promise<Profile | undefined> => {
    const file = path.join(dir, name);
    const key = `${source}:${file}`;
    const stat = await fs.stat(file).catch(() => undefined);
    if (stat?.isFile() !== true) return void cache.delete(key);
    const hit = cache.get(key);
    if (hit !== undefined && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.profile;
    const text = await fs.readFile(file, "utf8").catch(() => undefined);
    if (text === undefined) return void cache.delete(key);
    const profile = parseProfile(name.slice(0, -3), text, source);
    cache.set(key, { mtimeMs: stat.mtimeMs, size: stat.size, profile });
    return profile;
  };
  return async (dir: string, source: Profile["source"]): Promise<Profile[]> => {
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    const found = await Promise.all(names.filter((name) => name.endsWith(".md")).map((name) => read(dir, name, source)));
    return found.filter((profile) => profile !== undefined);
  };
};

/**
 * Profiles: what a thread's agent is for. A thread is given one (`TurnOptions.plugins["agent.profiles"]`, which the
 * web half's picker sends with each prompt), else the configured default: its prompt is a section of the system prompt,
 * and in `AgentRequestHook`'s `select` phase it keeps the tools and sections it allows of what every `shape` handler
 * offered. Found by the session's directory: bundled, then those plugins' packages bring (`"resources": { "profiles":
 * "./profiles" }`), then `~/.lemma/profiles`, then the project's `.lemma/profiles`, a later one of a name winning. Profiles are data: they carry no code, and narrow what plugins offer, so a
 * project's load as its `AGENTS.md` and skills do. The turn logs the choice (`turn-start`), so a resumed turn keeps it
 * and its requests rebuild from the log.
 */
export default definePlugin({
  id: PROFILES_PLUGIN,
  uses: ["lemma/agent@1"],
  config: Config,
  requires: { paths: Paths, host: HostControl },
  setup: function* ({ paths, host }, owner) {
    const config = owner.config;
    const events = yield* Events;
    const user = path.join(paths.home, "profiles");
    const readDir = profileReader();
    const load = (cwd: string) =>
      Effect.flatMap(host.plugins, (plugins) =>
        Effect.promise(async () =>
          byName([
            ...(await readDir(BUNDLED, "bundled")),
            ...(await Promise.all(resourcesOf(plugins, "profiles").map(({ dir, source }) => readDir(dir, source)))).flat(),
            ...(await readDir(user, "user")),
            ...(await readDir(path.join(cwd, ".lemma", "profiles"), "project")),
          ]),
        ),
      );
    const told = new Set<string>();
    /** The profile a request's turn was taken with, else the default; one named that is not there is said so once. */
    const active = (cwd: string, plugins: Readonly<Record<string, unknown>> | undefined) =>
      Effect.gen(function* () {
        const profiles = yield* load(cwd);
        const chosen = plugins?.[PROFILES_PLUGIN];
        const name = typeof chosen === "string" ? chosen : config.default;
        const profile = profiles.get(name);
        if (profile === undefined && !told.has(`${cwd}\n${name}`)) {
          told.add(`${cwd}\n${name}`);
          yield* events.publish(Notice, {
            level: "warning",
            source: owner.id,
            message: `No profile named "${name}" in ${cwd}: the thread goes on without one`,
          });
        }
        return profile;
      });

    yield* owner.add(
      PromptSections,
      {
        id: "profile",
        text: ({ cwd, plugins }) =>
          Effect.map(active(cwd, plugins), (profile) => (profile === undefined || profile.prompt === "" ? undefined : profile.prompt)),
      },
      { order: 100 },
    );

    yield* owner.on(
      AgentRequestHook,
      (draft: RequestDraft, next) =>
        Effect.gen(function* () {
          const profile = yield* active(draft.cwd, draft.plugins);
          if (profile === undefined || (profile.tools === undefined && profile.sections === undefined)) return yield* next(draft);
          return yield* next({
            ...draft,
            tools: draft.tools.filter((tool) => keeps(profile.tools, tool.spec.name)),
            // Its own section stays whatever it lists: it is the profile.
            sections: draft.sections.filter((section) => section.id === "profile" || keeps(profile.sections, section.id)),
          });
        }),
      { phase: "select" },
    );

    yield* owner.add(
      Channels,
      serveChannel(ProfileChannels.list, ({ cwd }) =>
        Effect.map(load(cwd ?? paths.cwd), (profiles) => ({
          profiles: [...profiles.values()]
            .map(({ name, description, model, thinking, source }) => ({
              name,
              ...(description === undefined ? {} : { description }),
              ...(model === undefined ? {} : { model }),
              ...(thinking === undefined ? {} : { thinking }),
              source,
            }))
            .sort((a, b) => a.name.localeCompare(b.name)),
          default: config.default,
        })),
      ),
    );
  },
});
