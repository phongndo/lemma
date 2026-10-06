import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Semaphore } from "effect";
import type { AuthContext } from "@earendil-works/pi-ai";
import { PluginContext, definePlugin, makeCore } from "@lemma/core";
import type { Events } from "@lemma/core";
import type { Plugin } from "@lemma/core";
import { Credentials, HostControl, Interaction, Notice, Paths } from "@lemma/contracts";
import type { ConfigScope, Credential, InteractionError, Llm, NoticePayload, PluginChange } from "@lemma/contracts";

export function fakeCredentials(initial: Record<string, Credential> = {}) {
  const store = new Map<string, Credential>(Object.entries(initial));
  const lock = Semaphore.makeUnsafe(1);
  const service: typeof Credentials.Service = {
    read: (provider) => Effect.sync(() => store.get(provider)),
    list: Effect.sync(() => [...store].map(([provider, credential]) => ({ provider, type: credential.type }))),
    modify: (provider, update) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const next = yield* update(store.get(provider));
          if (next !== undefined) store.set(provider, next);
          return store.get(provider);
        }),
      ),
    remove: (provider) => Effect.sync(() => void store.delete(provider)),
  };
  const plugin = definePlugin({ id: "credentials", provides: [Credentials], layer: Layer.succeed(Credentials, service) });
  return { store, service, plugin };
}

type Question =
  | { readonly type: "ask"; readonly title: string; readonly secret?: boolean; readonly placeholder?: string }
  | { readonly type: "select"; readonly title: string; readonly options: readonly string[] };

/** Answers questions with `answer`; every question is recorded. */
export function fakeInteraction(answer: (question: Question) => Effect.Effect<string, InteractionError>) {
  const asked: Question[] = [];
  const respond = (question: Question) =>
    Effect.suspend(() => {
      asked.push(question);
      return answer(question);
    });
  const service: typeof Interaction.Service = {
    confirm: () => Effect.succeed(true),
    ask: (title, options) => respond({ type: "ask", title, ...options }),
    select: (title, options) => respond({ type: "select", title, options: options.map((option) => option.value) }) as Effect.Effect<never, InteractionError>,
  };
  const plugin = definePlugin({ id: "interaction", provides: [Interaction], layer: Layer.succeed(Interaction, service) });
  return { asked, plugin };
}

/** Records every `Notice` through a plugin observer, so no publish races a late subscriber. */
export function noticeRecorder() {
  const notices: NoticePayload[] = [];
  const plugin = definePlugin({
    id: "notices",
    layer: Layer.effectDiscard(
      Effect.gen(function* () {
        const context = yield* PluginContext;
        yield* context.observe(Notice, (notice) => Effect.sync(() => void notices.push(notice)), { overflow: "suspend" });
      }),
    ),
  });
  return { notices, plugin };
}

export const envContext = (env: Record<string, string> = {}): AuthContext => ({
  env: async (name) => env[name],
  fileExists: async () => false,
});

/** A host that records the config changes plugins ask it to save; `configure` succeeds as a deferred change would. */
export function fakeHost(options: { readonly configScope?: ConfigScope } = {}) {
  const saved: Record<string, PluginChange>[] = [];
  const scopes: (ConfigScope | undefined)[] = [];
  const unused = () => Effect.die("not used by the llm plugin");
  const service = {
    plugins: Effect.succeed([{ id: "llm", ...(options.configScope === undefined ? {} : { configScope: options.configScope }) }]),
    composition: unused(),
    restart: unused,
    reload: unused(),
    configure: (plugins: Record<string, PluginChange>, configure?: { readonly scope?: ConfigScope }) =>
      Effect.sync(() => {
        saved.push(plugins);
        scopes.push(configure?.scope);
        return { started: [], restarted: [], stopped: [], unchanged: [], failed: [], interrupted: 0, faults: [], deferred: true };
      }),
    ui: unused(),
    configureUi: unused,
  } as unknown as typeof HostControl.Service;
  // A home of its own, as the host's: the llm plugin keeps the installation's device ID there.
  const home = mkdtempSync(join(tmpdir(), "lemma-llm-home-"));
  const paths = {
    home,
    userConfig: join(home, "config.jsonc"),
    projectConfig: join(home, "project.jsonc"),
    auth: join(home, "auth.json"),
    sessions: join(home, "sessions"),
    cwd: home,
  };
  const plugin = definePlugin({
    id: "host",
    provides: [HostControl, Paths],
    layer: Layer.merge(Layer.succeed(HostControl, service), Layer.succeed(Paths, paths)),
  });
  return { saved, scopes, home, plugin };
}

/** Runs `body` against `plugins`, adding a `fakeHost` when none of them provides `HostControl`. */
export const runWith = <A, E>(plugins: readonly Plugin[], body: Effect.Effect<A, E, Llm | Events>, configs: Record<string, unknown> = {}): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const hosted = plugins.some((plugin) => plugin.provides.some((tag) => tag.key === HostControl.key));
        const core = yield* makeCore(hosted ? plugins : [...plugins, fakeHost().plugin], { configs });
        return yield* core.run(body) as Effect.Effect<A, E | unknown>;
      }),
    ) as Effect.Effect<A>,
  );

/** Keeps live catalogs off the network: every fetch fails, so providers keep pi-ai's lists. */
export const offline: typeof fetch = () => Promise.reject(new Error("offline in tests"));
