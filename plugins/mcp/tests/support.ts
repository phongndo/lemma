import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effect, Layer, Stream } from "effect";
import type { Scope } from "effect";
import { definePlugin, Events, Hooks, makeCore, Registries } from "@lemma/core";
import type { Plugin } from "@lemma/core";
import { Credentials, HostControl, Interaction, McpManagers, Notice, Paths, Tools } from "@lemma/contracts";
import type { Credential, McpManager, NoticePayload, PluginChange, PluginInfo } from "@lemma/contracts";
import tools from "../../tools/src/index.ts";
import mcp from "../src/index.ts";

export const fixture = path.join(import.meta.dirname, "fixtures", "server.ts");

/** A stdio server spec running the fixture with this Node. */
export const stdioSpec = (id: string, env: Record<string, string> = {}) => ({ id, command: process.execPath, args: [fixture], env });

export const tempDir = () => fs.mkdtemp(path.join(os.tmpdir(), "lemma-mcp-"));

export type Question =
  | { readonly type: "confirm"; readonly title: string; readonly detail?: string | undefined }
  | { readonly type: "ask"; readonly title: string; readonly secret?: boolean | undefined }
  | { readonly type: "select"; readonly title: string; readonly options: readonly { readonly value: string; readonly label: string }[] };

/** Answers to the plugin's questions: by default confirms, picks the first option, and never answers an `ask`. */
export type Answer = (question: Question) => Effect.Effect<string | boolean, never>;
const defaultAnswer: Answer = (question) =>
  question.type === "confirm" ? Effect.succeed(true) : question.type === "select" ? Effect.succeed(question.options[0]!.value) : Effect.never;

export interface Harness {
  readonly manager: McpManager;
  readonly tools: Tools["Type"];
  readonly credentials: Map<string, Credential>;
  readonly configured: PluginChange[];
  readonly questions: Question[];
  readonly notices: NoticePayload[];
  /** Set to make the fake host report a configure that changed nothing, so the plugin is not restarted. */
  readonly unchanged: { value: boolean };
}

export interface HarnessOptions {
  readonly answer?: Answer;
  readonly credentials?: Record<string, Credential>;
  readonly cwd?: string;
  /** More plugins in the core (a stand-in `codemode` tool). */
  readonly extra?: readonly Plugin[];
}

/** Fakes for what the mcp plugin requires besides `Tools`, recording what the plugin does with them. */
export const makeFakes = (options: HarnessOptions = {}) => {
  const credentials = new Map(Object.entries(options.credentials ?? {}));
  const configured: PluginChange[] = [];
  const questions: Question[] = [];
  const unchanged = { value: false };
  const answer = options.answer ?? defaultAnswer;
  const ask = (question: Question) =>
    Effect.suspend(() => {
      questions.push(question);
      return answer(question);
    });
  const fakes = definePlugin({
    id: "fakes",
    provides: [Credentials, Interaction, HostControl, Paths],
    layer: Layer.mergeAll(
      Layer.succeed(Credentials, {
        read: (provider) => Effect.sync(() => credentials.get(provider)),
        list: Effect.sync(() => [...credentials].map(([provider, credential]) => ({ provider, type: credential.type }))),
        modify: (provider, update) =>
          Effect.flatMap(update(credentials.get(provider)), (next) =>
            Effect.sync(() => {
              if (next !== undefined) credentials.set(provider, next);
              return next;
            }),
          ),
        remove: (provider) => Effect.sync(() => void credentials.delete(provider)),
      }),
      Layer.succeed(Interaction, {
        confirm: (title, detail) => Effect.map(ask({ type: "confirm", title, detail }), Boolean),
        ask: (title, settings) => Effect.map(ask({ type: "ask", title, secret: settings?.secret }), String),
        select: (title, choices) => Effect.map(ask({ type: "select", title, options: choices }), (value) => value as never),
      }),
      Layer.succeed(HostControl, {
        plugins: Effect.succeed<readonly PluginInfo[]>([{ id: "mcp", source: "bundled", enabled: true, provides: [], requires: [], configScope: "user" }]),
        composition: Effect.succeed({ id: "c", plugins: [] }),
        restart: () => Effect.void,
        reload: Effect.die("unused"),
        configure: (plugins) =>
          Effect.sync(() => {
            configured.push({ ...plugins["mcp"]! });
            return {
              started: [],
              stopped: [],
              restarted: unchanged.value ? [] : ["mcp"],
              unchanged: unchanged.value ? ["mcp"] : [],
              failed: [],
              interrupted: 0,
              faults: [],
            };
          }),
        ui: Effect.succeed({ plugins: {}, enabledIn: {}, configIn: {}, files: [] }),
        configureUi: () => Effect.die("unused"),
      }),
      Layer.succeed(Paths, { home: os.tmpdir(), userConfig: "", projectConfig: "", auth: "", sessions: "", cwd: options.cwd ?? process.cwd() }),
    ),
  });
  return { fakes, credentials, configured, questions, unchanged };
};

/** Runs `body` against a core of the tools and mcp plugins with fakes for the rest; `answer` answers the person's questions. */
export const withHarness = <A>(
  config: Record<string, unknown>,
  body: (harness: Harness) => Effect.Effect<A, unknown, Scope.Scope | Hooks | Registries | Events>,
  options: HarnessOptions = {},
): Promise<A> => {
  const { fakes, credentials, configured, questions, unchanged } = makeFakes(options);
  const notices: NoticePayload[] = [];
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* makeCore([fakes, tools, mcp, ...(options.extra ?? [])], { configs: { mcp: config } });
        return yield* core.run(
          Effect.gen(function* () {
            const events = yield* Events;
            yield* Effect.forkScoped(Stream.runForEach(events.stream(Notice), (notice) => Effect.sync(() => notices.push(notice))));
            const [first] = yield* (yield* Registries).items(McpManagers);
            return yield* body({ manager: first!.item, tools: yield* Tools, credentials, configured, questions, notices, unchanged });
          }),
        );
      }),
    ),
  );
};

/** Polls `check` until it holds, failing after `ms`. */
export const until = <A>(check: Effect.Effect<A | undefined | false>, ms = 10_000, what = "the condition") =>
  Effect.gen(function* () {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = yield* check;
      if (value !== undefined && value !== false) return value;
      if (Date.now() > deadline) return yield* Effect.dieMessage(`Timed out waiting for ${what}`);
      yield* Effect.sleep("25 millis");
    }
  });

/** The server's info once it is `ready` (or another status). */
export const status = (manager: McpManager, id: string, wanted = "ready", ms?: number) =>
  until(
    Effect.map(manager.servers, (servers) => servers.find((server) => server.id === id && server.status === wanted)),
    ms,
    `${id} to be ${wanted}`,
  );
