import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Schema } from "effect";
import { definePlugin, Events } from "@lemma/core";
import { Channels, HostControl, Notice, Paths, resourcesOf, serveChannel } from "@lemma/contracts";
import { AgentInputHook, AgentRequestHook, ProfileChannels, PROFILES_PLUGIN, PromptSections } from "@lemma/agent";
import type { RequestDraft } from "@lemma/agent";
import { Sessions } from "@lemma/sessions";
import type { SessionEvent } from "@lemma/sessions";
import { byName, firstMode, keeps, parseProfile, RENAMED } from "./profile.ts";
import type { Profile } from "./profile.ts";

export { byName, firstMode, keeps, parseProfile, RENAMED } from "./profile.ts";
export type { Profile } from "./profile.ts";

/** Its row in config.jsonc's `plugins`. */
export const Config = Schema.Struct({
  default: Schema.String.pipe(Schema.withDecodingDefaultType(Effect.sync(() => "work"))).annotate({
    title: "Default mode",
    description: "The mode (profile) a new thread has when none is chosen for it.",
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
 * Profiles: what a thread's agent is for, its mode. A thread is given one with its first prompt
 * (`TurnOptions.plugins["agent.profiles"]`, which the web half's picker sends for a new thread), else the configured
 * default, and keeps it: the first turn logs it, and later prompts go with it whatever they name. Its prompt is a
 * section of the system prompt, and in `AgentRequestHook`'s `select` phase it keeps the tools and sections it allows
 * of what every `shape` handler offered. Found by the session's directory: bundled, then those plugins' packages bring
 * (`"resources": { "profiles": "./profiles" }`), then `~/.lemma/profiles`, then the project's `.lemma/profiles`, a
 * later one of a name winning. Profiles are data: they carry no code, and narrow what plugins offer, so a project's
 * load as its `AGENTS.md` and skills do. Each request reads the mode from its turn's branch, so a resumed turn keeps
 * it and its requests rebuild from the log.
 */
export default definePlugin({
  id: PROFILES_PLUGIN,
  uses: ["lemma/agent@1"],
  config: Config,
  requires: { paths: Paths, host: HostControl, sessions: Sessions },
  setup: function* ({ paths, host, sessions }, owner) {
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
    /**
     * The profile of a request's thread: the one its first turn logged (`firstMode`), kept for the thread, else the
     * default. One named that is not there is said so once; a bundled one since renamed is its successor.
     */
    const active = (cwd: string, branch: readonly SessionEvent[]) =>
      Effect.gen(function* () {
        const profiles = yield* load(cwd);
        const name = firstMode(branch)?.name ?? config.default;
        const profile = profiles.get(name) ?? (RENAMED[name] === undefined ? undefined : profiles.get(RENAMED[name]));
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
        text: ({ cwd, branch }) => Effect.map(active(cwd, branch), (profile) => (profile === undefined || profile.prompt === "" ? undefined : profile.prompt)),
      },
      { order: 100 },
    );

    // A thread's mode is chosen with its first prompt and kept: that prompt goes with the one chosen (the default when
    // none is), so its turn logs it; a later prompt naming another goes with the thread's own, as the log then says.
    yield* owner.on(AgentInputHook, (input, next) =>
      Effect.gen(function* () {
        const asked = input.options.plugins?.[PROFILES_PLUGIN];
        // A log it cannot read leaves the prompt as it came: each request still takes the mode from the turn's branch.
        const branch = yield* sessions.branch(input.sessionId).pipe(Effect.catch(() => Effect.succeed(undefined)));
        if (branch === undefined) return yield* next(input);
        const first = firstMode(branch);
        const mode = first === undefined ? (typeof asked === "string" ? asked : config.default) : (first.name ?? config.default);
        // A later prompt naming none is left as it came: the thread's first turn says its mode.
        if (asked === mode || (first !== undefined && asked === undefined)) return yield* next(input);
        return yield* next({ ...input, options: { ...input.options, plugins: { ...input.options.plugins, [PROFILES_PLUGIN]: mode } } });
      }),
    );

    yield* owner.on(
      AgentRequestHook,
      (draft: RequestDraft, next) =>
        Effect.gen(function* () {
          const profile = yield* active(draft.cwd, draft.branch);
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
