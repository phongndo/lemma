import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Schema } from "effect";
import { definePlugin, Events } from "@lemma/core";
import { Channels, HostControl, Notice, Paths, resourcesOf, serveChannel } from "@lemma/contracts";
import { AgentInputHook, AgentRequestHook, ModeChannels, MODES_PLUGIN, PromptSections } from "@lemma/agent";
import type { RequestDraft } from "@lemma/agent";
import { Sessions } from "@lemma/sessions";
import type { SessionEvent } from "@lemma/sessions";
import { byName, firstMode, keeps, parseMode, RENAMED } from "./mode.ts";
import type { Mode } from "./mode.ts";

export { byName, firstMode, keeps, parseMode, RENAMED } from "./mode.ts";
export type { Mode } from "./mode.ts";

/** Its row in config.jsonc's `plugins`. */
export const Config = Schema.Struct({
  default: Schema.String.pipe(Schema.withDecodingDefaultType(Effect.sync(() => "work"))).annotate({
    title: "Default mode",
    description: "The mode a new thread has when none is chosen for it.",
  }),
});
export type Config = typeof Config.Type;

/** The modes that ship with Lemma. */
const BUNDLED = fileURLToPath(new URL("../modes", import.meta.url));

/** The id of the system prompt's section a mode is (`PromptSections`). */
const SECTION = "mode";

/**
 * Reads the `.md` files of a directory as modes, caching each by its size and mtime, so finding a request's mode costs
 * a directory listing and a `stat` a mode, as finding skills does. A directory that is not there has none.
 */
const modeReader = () => {
  const cache = new Map<string, { readonly mtimeMs: number; readonly size: number; readonly mode: Mode }>();
  const read = async (dir: string, name: string, source: Mode["source"]): Promise<Mode | undefined> => {
    const file = path.join(dir, name);
    const key = `${source}:${file}`;
    const stat = await fs.stat(file).catch(() => undefined);
    if (stat?.isFile() !== true) return void cache.delete(key);
    const hit = cache.get(key);
    if (hit !== undefined && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.mode;
    const text = await fs.readFile(file, "utf8").catch(() => undefined);
    if (text === undefined) return void cache.delete(key);
    const mode = parseMode(name.slice(0, -3), text, source);
    cache.set(key, { mtimeMs: stat.mtimeMs, size: stat.size, mode });
    return mode;
  };
  return async (dir: string, source: Mode["source"]): Promise<Mode[]> => {
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    const found = await Promise.all(names.filter((name) => name.endsWith(".md")).map((name) => read(dir, name, source)));
    return found.filter((mode) => mode !== undefined);
  };
};

/**
 * Modes: what a thread's agent is for. A thread is given one with its first prompt
 * (`TurnOptions.plugins["agent.modes"]`, which the web half's picker sends for a new thread), else the configured
 * default, and keeps it: the first turn logs it, and later prompts go with it whatever they name. Its prompt is a
 * section of the system prompt, and in `AgentRequestHook`'s `select` phase it keeps the tools and sections it allows
 * of what every `shape` handler offered. Found by the session's directory: bundled, then those plugins' packages bring
 * (`"resources": { "modes": "./modes" }`), then `~/.lemma/modes`, then the project's `.lemma/modes`, a later one of a
 * name winning. Modes are data: they carry no code, and narrow what plugins offer, so a project's load as its
 * `AGENTS.md` and skills do. Each request reads the mode from its turn's branch, so a resumed turn keeps it and its
 * requests rebuild from the log.
 */
export default definePlugin({
  id: MODES_PLUGIN,
  uses: ["lemma/agent@2"],
  config: Config,
  requires: { paths: Paths, host: HostControl, sessions: Sessions },
  setup: function* ({ paths, host, sessions }, owner) {
    const config = owner.config;
    const events = yield* Events;
    const readDir = modeReader();
    const told = new Set<string>();
    const load = (cwd: string) =>
      Effect.gen(function* () {
        const packs = resourcesOf(yield* host.plugins, "modes");
        const found = yield* Effect.promise(() =>
          Promise.all([
            readDir(BUNDLED, "bundled"),
            ...packs.map(({ dir, source }) => readDir(dir, source)),
            readDir(path.join(paths.home, "modes"), "user"),
            readDir(path.join(cwd, ".lemma", "modes"), "project"),
          ]),
        );
        return byName(found.flat());
      });
    /**
     * The mode of a request's thread: the one its first turn logged (`firstMode`), kept for the thread, else the
     * default. One named that is not there is said so once; a bundled one since renamed is its successor.
     */
    const active = (cwd: string, branch: readonly SessionEvent[]) =>
      Effect.gen(function* () {
        const modes = yield* load(cwd);
        const name = firstMode(branch)?.name ?? config.default;
        const mode = modes.get(name) ?? (RENAMED[name] === undefined ? undefined : modes.get(RENAMED[name]));
        if (mode === undefined && !told.has(`${cwd}\n${name}`)) {
          told.add(`${cwd}\n${name}`);
          yield* events.publish(Notice, {
            level: "warning",
            source: owner.id,
            message: `No mode named "${name}" in ${cwd}: the thread goes on without one`,
          });
        }
        return mode;
      });

    yield* owner.add(
      PromptSections,
      {
        id: SECTION,
        text: ({ cwd, branch }) => Effect.map(active(cwd, branch), (mode) => (mode === undefined || mode.prompt === "" ? undefined : mode.prompt)),
      },
      { order: 100 },
    );

    // A thread's mode is chosen with its first prompt and kept: that prompt goes with the one chosen (the default when
    // none is), so its turn logs it; a later prompt naming another goes with the thread's own, as the log then says.
    yield* owner.on(AgentInputHook, (input, next) =>
      Effect.gen(function* () {
        const asked = input.options.plugins?.[MODES_PLUGIN];
        // A log it cannot read leaves the prompt as it came: each request still takes the mode from the turn's branch.
        const branch = yield* sessions.branch(input.sessionId).pipe(Effect.catch(() => Effect.succeed(undefined)));
        if (branch === undefined) return yield* next(input);
        const first = firstMode(branch);
        const mode = first === undefined ? (typeof asked === "string" ? asked : config.default) : (first.name ?? config.default);
        // A later prompt naming none is left as it came: the thread's first turn says its mode.
        if (asked === mode || (first !== undefined && asked === undefined)) return yield* next(input);
        return yield* next({ ...input, options: { ...input.options, plugins: { ...input.options.plugins, [MODES_PLUGIN]: mode } } });
      }),
    );

    yield* owner.on(
      AgentRequestHook,
      (draft: RequestDraft, next) =>
        Effect.gen(function* () {
          const mode = yield* active(draft.cwd, draft.branch);
          if (mode === undefined || (mode.tools === undefined && mode.sections === undefined)) return yield* next(draft);
          return yield* next({
            ...draft,
            tools: draft.tools.filter((tool) => keeps(mode.tools, tool.spec.name)),
            // Its own section stays whatever it lists: it is the mode.
            sections: draft.sections.filter((section) => section.id === SECTION || keeps(mode.sections, section.id)),
          });
        }),
      { phase: "select" },
    );

    yield* owner.add(
      Channels,
      serveChannel(ModeChannels.list, ({ cwd }) =>
        Effect.map(load(cwd ?? paths.cwd), (modes) => ({
          modes: [...modes.values()]
            .map(({ name, description, model, thinking, use, source }) => ({
              name,
              ...(description === undefined ? {} : { description }),
              ...(model === undefined ? {} : { model }),
              ...(thinking === undefined ? {} : { thinking }),
              ...(use === undefined ? {} : { use }),
              source,
            }))
            .sort((a, b) => a.name.localeCompare(b.name)),
          default: config.default,
        })),
      ),
    );
  },
});
