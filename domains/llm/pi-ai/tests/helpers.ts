import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Fiber, Layer, Semaphore, Stream } from "effect";
import type { AuthContext } from "@earendil-works/pi-ai";
import { PluginContext, awaitable, definePlugin, makeCore } from "@lemma/core";
import type { Events } from "@lemma/core";
import type { Plugin } from "@lemma/core";
import { HostControl, Notice, Paths } from "@lemma/contracts";
import { Credentials } from "@lemma/credentials";
import type { ConfigScope, NoticePayload, PluginChange } from "@lemma/contracts";
import type { Credential } from "@lemma/credentials";
import { asksAnswer, Llm as LlmService } from "@lemma/llm";
import type { Llm, SignIn, SignInStep } from "@lemma/llm";

export function fakeCredentials(initial: Record<string, Credential> = {}) {
  const store = new Map<string, Credential>(Object.entries(initial));
  const lock = Semaphore.makeUnsafe(1);
  const service: typeof Credentials.Service = {
    read: (provider) => Effect.sync(() => store.get(provider)),
    list: Effect.sync(() => [...store].map(([provider, credential]) => ({ provider, type: credential.type }))),
    modify: (provider, update) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const next = yield* awaitable(() => update(store.get(provider)));
          if (next !== undefined) store.set(provider, next);
          return store.get(provider);
        }),
      ),
    remove: (provider) => Effect.sync(() => void store.delete(provider)),
  };
  const plugin = definePlugin({ id: "credentials", provides: [Credentials], layer: Layer.succeed(Credentials, service) });
  return { store, service, plugin };
}

/**
 * Answers each sign-in step that asks with `answer`, as a client would, through `Llm.signIns` and `Llm.answerSignIn`:
 * every step asked is recorded, and every list seen. An answer still pending when its step goes (the flow withdrew it,
 * or the login ended) is interrupted, as a client closes the question.
 */
export function signInAnswers(answer: (step: SignInStep, signIn: SignIn) => Effect.Effect<string>) {
  const asked: SignInStep[] = [];
  const seen: (readonly SignIn[])[] = [];
  const plugin = definePlugin({
    id: "sign-in-answers",
    requires: { llm: LlmService },
    setup: function* ({ llm }, owner) {
      const answering = new Map<string, { readonly seq: number; readonly fiber: Fiber.Fiber<unknown, unknown> }>();
      yield* owner.background(
        "answer sign-ins",
        Stream.runForEach(llm.signIns, (list) =>
          Effect.gen(function* () {
            seen.push(list);
            for (const [provider, running] of answering) {
              const now = list.find((signIn) => signIn.provider === provider);
              if (now?.seq === running.seq && now.ended === undefined) continue;
              answering.delete(provider);
              yield* Fiber.interrupt(running.fiber);
            }
            for (const signIn of list) {
              if (signIn.ended !== undefined || !asksAnswer(signIn.step) || answering.get(signIn.provider)?.seq === signIn.seq) continue;
              asked.push(signIn.step);
              const fiber = yield* Effect.forkChild(
                answer(signIn.step, signIn).pipe(
                  Effect.flatMap((value) => llm.answerSignIn(signIn.provider, signIn.seq, value)),
                  Effect.ignore,
                ),
              );
              answering.set(signIn.provider, { seq: signIn.seq, fiber });
            }
          }),
        ),
      );
    },
  });
  return { asked, seen, plugin };
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

/**
 * A host that records the config changes plugins ask it to save; `configure` succeeds as a deferred change would.
 * Its composition is what a client's connect probe (`Host.Info`) reads.
 */
export function fakeHost(options: { readonly configScope?: ConfigScope } = {}) {
  const saved: Record<string, PluginChange>[] = [];
  const scopes: (ConfigScope | undefined)[] = [];
  const unused = () => Effect.die("not used by the llm plugin");
  const service = {
    runtime: [HostControl.key, Paths.key],
    process: { pid: process.pid, startedAt: 0 },
    plugins: Effect.succeed([{ id: "llm.pi-ai", ...(options.configScope === undefined ? {} : { configScope: options.configScope }) }]),
    composition: Effect.succeed({ id: "test", plugins: [] }),
    restart: unused,
    reload: unused(),
    configure: (plugins: Record<string, PluginChange>, configure?: { readonly scope?: ConfigScope }) =>
      Effect.sync(() => {
        saved.push(plugins);
        scopes.push(configure?.scope);
        return { started: [], restarted: [], stopped: [], unchanged: [], failed: [], interrupted: 0, faults: [], deferred: true };
      }),
    web: unused(),
  } as unknown as typeof HostControl.Service;
  // A home of its own, as the host's: the llm plugin keeps the installation's device ID there.
  const home = mkdtempSync(join(tmpdir(), "lemma-llm-home-"));
  const paths = {
    home,
    userConfig: join(home, "config.jsonc"),
    projectConfig: join(home, "project.jsonc"),
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
