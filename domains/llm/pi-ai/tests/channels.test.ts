import { describe, expect, it } from "vitest";
import { Duration, Effect, Schema, Stream } from "effect";
import { connect } from "@lemma/client";
import type { Host } from "@lemma/client";
import { Channels, defineChannel, HostError, serveChannel } from "@lemma/contracts";
import { asksAnswer, LlmChannels } from "@lemma/llm";
import type { LlmChange, SignIn, SignInStep } from "@lemma/llm";
import { readDiscovery } from "@lemma/contracts/discovery";
import { definePlugin, makeCore } from "@lemma/core";
import type { Core, CoreOptions, Plugin } from "@lemma/core";
import transport from "@lemma/transport-server";
import { settled } from "../../../../scripts/e2e.ts";
import { makeLlmPlugin } from "../src/index.ts";
import { envContext, fakeCredentials, fakeHost, offline } from "./helpers.ts";

/**
 * Runs `plugins` behind the transport and a fake host, which gives the
 * transport the runtime it needs, and hands `body` a way to connect clients,
 * which reach the llm plugin's channels as any client does.
 */
const served = (
  plugins: readonly Plugin[],
  body: (client: () => Promise<Host>, host: ReturnType<typeof fakeHost>, core: Core<any>) => Promise<void>,
  configs = {},
  deadlines?: CoreOptions["deadlines"],
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const host = fakeHost();
        const core = yield* makeCore([transport, host.plugin, ...plugins], {
          configs: { "transport.server": { port: 0 }, ...configs },
          ...(deadlines === undefined ? {} : { deadlines }),
        });
        const found = yield* readDiscovery(host.home);
        if (found === undefined) return yield* Effect.die(new Error("no discovery file"));
        const clients: Host[] = [];
        yield* Effect.addFinalizer(() => Effect.promise(() => Promise.all(clients.map((client) => client.close()))));
        const client = async () => {
          const opened = await connect({ url: found.url, token: found.token });
          clients.push(opened);
          return opened;
        };
        yield* Effect.promise(() => body(client, host, core));
      }),
    ).pipe(Effect.timeout("20 seconds")),
  );

const gateway = {
  providers: [
    { id: "gateway", name: "Gateway", api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1", apiKey: { env: "GATEWAY_KEY" }, models: [{ id: "m" }] },
  ],
};

/** The llm plugin with only `gateway`, offline. */
const gatewayLlm = () => {
  const credentials = fakeCredentials();
  const llm = makeLlmPlugin({ fetch: offline, providers: () => [], authContext: envContext() });
  return { credentials, plugins: [credentials.plugin, llm] };
};

/**
 * A client answering each sign-in step that asks, as the web app does: it opens `llm.sign-ins` and answers with
 * `llm.answer-sign-in` what `answer` gives (nothing: it leaves the step open). Every step asked is recorded, and every
 * list seen.
 */
const answering = (host: Host, answer: (step: SignInStep) => string | Promise<string> | undefined) => {
  const asked: SignInStep[] = [];
  const seen: (readonly SignIn[])[] = [];
  const handled = new Set<number>();
  const close = host.channel.open(LlmChannels.signIns, undefined, (list) => {
    seen.push(list);
    for (const signIn of list) {
      if (signIn.ended !== undefined || !asksAnswer(signIn.step) || handled.has(signIn.seq)) continue;
      handled.add(signIn.seq);
      asked.push(signIn.step);
      void Promise.resolve(answer(signIn.step))
        .then((value) => (value === undefined ? undefined : host.channel.call(LlmChannels.answerSignIn, { provider: signIn.provider, seq: signIn.seq, value })))
        .catch(() => undefined);
    }
  });
  /** How the provider's latest sign-in seen ended. */
  const ended = (provider: string) =>
    seen
      .flat()
      .filter((signIn) => signIn.provider === provider && signIn.ended !== undefined)
      .at(-1)?.ended;
  return { asked, seen, ended, close };
};

/** Waits until `done` holds, failing the test if it never does. */
const until = async (done: () => boolean) => expect(await settled(async () => done() || undefined)).toBe(true);

let probes = 0;
/** A stream that never ends, counting those open: one ended when the host has heard its client go. */
const probe = definePlugin({
  id: "probe",
  setup: function* (_, owner) {
    const opened = defineChannel({ kind: "stream", id: "probe.open", payload: Schema.Void, success: Schema.Number });
    yield* owner.add(
      Channels,
      serveChannel(opened, () =>
        Stream.concat(Stream.make(1), Stream.never).pipe(Stream.onStart(Effect.sync(() => probes++)), Stream.ensuring(Effect.sync(() => probes--))),
      ),
    );
  },
});

/** What `promise` rejects with, as the client gives it. */
const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => expect.fail("expected a rejection"),
    (error: unknown) => {
      expect(error).toBeInstanceOf(HostError);
      return error as HostError;
    },
  );

describe("llm's channels, through the transport", () => {
  it("lists every llm call and stream as the llm plugin's, and answers typed calls", () => {
    const { plugins } = gatewayLlm();
    return served(
      plugins,
      async (client) => {
        const host = await client();
        const listed = await host.channel.list();
        expect(listed.map((channel) => [channel.id, channel.kind, channel.source])).toEqual([
          ["llm.providers", "call", "llm.pi-ai"],
          ["llm.models", "call", "llm.pi-ai"],
          ["llm.login", "call", "llm.pi-ai"],
          ["llm.cancel-login", "call", "llm.pi-ai"],
          ["llm.sign-ins", "stream", "llm.pi-ai"],
          ["llm.answer-sign-in", "call", "llm.pi-ai"],
          ["llm.logout", "call", "llm.pi-ai"],
          ["llm.add-custom", "call", "llm.pi-ai"],
          ["llm.remove-custom", "call", "llm.pi-ai"],
          ["llm.set-logo", "call", "llm.pi-ai"],
          ["llm.changes", "stream", "llm.pi-ai"],
        ]);
        expect(listed.every((channel) => channel.title !== undefined && channel.description !== undefined)).toBe(true);
        expect(await host.channel.call(LlmChannels.providers, undefined)).toEqual([
          { id: "gateway", name: "Gateway", auth: [{ type: "api_key", name: "Gateway API key", interactive: true }], configured: false, custom: true },
        ]);
        expect((await host.channel.call(LlmChannels.models, {})).map((model) => model.ref)).toEqual(["gateway/m"]);
        expect(await host.channel.call(LlmChannels.models, { available: true })).toEqual([]);
      },
      { "llm.pi-ai": gateway },
    );
  }, 30_000);

  it("logs in, and fails with the error's reason as the code and its provider as the subject", () => {
    const { plugins, credentials } = gatewayLlm();
    return served(
      plugins,
      async (client) => {
        const host = await client();
        const answers = answering(host, () => "sk-test");
        await host.channel.call(LlmChannels.login, { provider: "gateway", type: "api_key" });
        expect(answers.asked).toEqual([{ type: "key", label: "Gateway API key" }]);
        await until(() => answers.ended("gateway") !== undefined);
        expect(answers.ended("gateway")).toEqual({ outcome: "signed-in" });
        expect(credentials.store.get("gateway")).toEqual({ type: "api_key", key: "sk-test" });
        expect((await host.channel.call(LlmChannels.providers, undefined))[0]).toMatchObject({ configured: true, source: "stored credential" });

        expect(await rejection(host.channel.call(LlmChannels.login, { provider: "nope", type: "api_key" }))).toMatchObject({
          code: "UnknownProvider",
          subject: "nope",
          message: "Unknown provider: nope",
        });
        expect(await rejection(host.channel.call(LlmChannels.login, { provider: "gateway", type: "oauth" }))).toMatchObject({
          code: "LoginFailed",
          subject: "gateway",
        });
        expect(await rejection(host.channel.call(LlmChannels.removeCustom, { provider: "elsewhere" }))).toMatchObject({
          code: "UnknownProvider",
          subject: "elsewhere",
        });
        // A payload its schema refuses names the channel.
        expect(await rejection(host.channel.call("llm.models", { available: "yes" }))).toMatchObject({ code: "InvalidPayload", subject: "llm.models" });

        await host.channel.call(LlmChannels.logout, { provider: "gateway" });
        expect(credentials.store.has("gateway")).toBe(false);
      },
      { "llm.pi-ai": gateway },
    );
  }, 30_000);

  it("lets any client cancel a running login: its sign-in ends cancelled, its step no longer answerable, and the call fails Cancelled", () => {
    const { plugins } = gatewayLlm();
    return served(
      plugins,
      async (client) => {
        const [starter, other] = [await client(), await client()];
        const answers = answering(other, () => undefined);
        expect(await other.channel.call(LlmChannels.cancelLogin, { provider: "gateway" })).toBe(false);
        const login = rejection(starter.channel.call(LlmChannels.login, { provider: "gateway", type: "api_key" }));
        await until(() => answers.asked.length === 1);
        const asking = answers.seen.flat().find((signIn) => signIn.step.type === "key")!;
        expect(await other.channel.call(LlmChannels.cancelLogin, { provider: "gateway" })).toBe(true);
        expect(await login).toMatchObject({ code: "Cancelled", subject: "gateway" });
        await until(() => answers.ended("gateway") !== undefined);
        expect(answers.ended("gateway")).toEqual({ outcome: "cancelled" });
        expect(await rejection(other.channel.call(LlmChannels.answerSignIn, { provider: "gateway", seq: asking.seq, value: "late" }))).toMatchObject({
          code: "NotAsked",
          subject: "gateway",
        });
        expect(await other.channel.call(LlmChannels.cancelLogin, { provider: "gateway" })).toBe(false);
      },
      { "llm.pi-ai": gateway },
    );
  }, 30_000);

  it("keeps a login running when its caller's connection drops; another client's call waits for it, and one of the other type is Busy", () => {
    const { plugins, credentials } = gatewayLlm();
    return served(
      [...plugins, probe],
      async (client) => {
        const [leaving, staying] = [await client(), await client()];
        leaving.channel.open("probe.open", undefined, () => {});
        await until(() => probes === 1);
        let answer!: (key: string) => void;
        const answers = answering(staying, () => new Promise<string>((resolve) => (answer = resolve)));
        void leaving.channel.call(LlmChannels.login, { provider: "gateway", type: "api_key" }).catch(() => undefined);
        await until(() => answers.asked.length === 1);
        await leaving.close();
        // The host has dropped the leaving client's requests: its login call among them.
        await until(() => probes === 0);
        // Its sign-in is still there, asking.
        expect(answers.seen.at(-1)).toMatchObject([{ provider: "gateway", step: { type: "key" } }]);
        const joined = staying.channel.call(LlmChannels.login, { provider: "gateway", type: "api_key" });
        expect(await rejection(staying.channel.call(LlmChannels.login, { provider: "gateway", type: "oauth" }))).toMatchObject({
          code: "Busy",
          subject: "gateway",
          message: 'A api_key login to "gateway" is in progress',
        });
        answer("sk-late");
        await joined;
        // One flow, one step asked: the second call waited for the first's.
        expect(answers.asked).toHaveLength(1);
        expect(credentials.store.get("gateway")).toEqual({ type: "api_key", key: "sk-late" });
      },
      { "llm.pi-ai": gateway },
    );
  }, 30_000);

  it("ends a login call waiting on its step Withdrawn at once when llm leaves, despite a long dispose deadline; called again, it logs in on the replacement", () => {
    const { plugins, credentials } = gatewayLlm();
    return served(
      plugins,
      async (client, _, core) => {
        const host = await client();
        // The first login's step is never answered: only llm stopping ends it.
        const first = answering(host, () => undefined);
        const login = rejection(host.channel.call(LlmChannels.login, { provider: "gateway", type: "api_key" }));
        await until(() => first.asked.length === 1);
        // The transport needs nothing llm provides, so the connection stays: llm alone restarts.
        const started = Date.now();
        await Effect.runPromise(core.restart("llm.pi-ai", { force: true }));
        expect(await login).toMatchObject({ code: "Withdrawn", subject: "llm.login" });
        expect(Date.now() - started).toBeLessThan(5_000);
        first.close();
        // The replacement's sign-ins, as a client reopening the stream sees them.
        const again = answering(host, () => "sk-again");
        await host.channel.call(LlmChannels.login, { provider: "gateway", type: "api_key" });
        expect(again.asked).toHaveLength(1);
        expect(credentials.store.get("gateway")).toEqual({ type: "api_key", key: "sk-again" });
      },
      { "llm.pi-ai": gateway },
      { dispose: Duration.seconds(30) },
    );
  }, 30_000);

  it("adds and removes providers of the user's, and sets their logos, in the llm plugin's config", () => {
    const { plugins } = gatewayLlm();
    return served(
      plugins,
      async (client, host) => {
        const user = await client();
        expect(
          await user.channel.call(LlmChannels.addCustom, {
            spec: { name: "Local", api: "openai-completions", baseUrl: "http://localhost:11434/v1", models: ["qwen3"] },
          }),
        ).toBe("local");
        await user.channel.call(LlmChannels.setLogo, { provider: "gateway", svg: "<svg>new</svg>" });
        await user.channel.call(LlmChannels.setLogo, { provider: "gateway" });
        await user.channel.call(LlmChannels.removeCustom, { provider: "gateway" });
        // Each one saved: the host's reload would list the change.
        const [added, logo, cleared, removed, ...rest] = host.saved;
        expect(added).toEqual({ "llm.pi-ai": { add: { providers: [expect.objectContaining({ id: "local", api: "openai-completions" })] } } });
        expect(logo).toEqual({
          "llm.pi-ai": { add: { providers: [expect.objectContaining({ id: "gateway", baseUrl: "http://127.0.0.1:9/v1", logo: "<svg>new</svg>" })] } },
        });
        expect(cleared?.["llm.pi-ai"]?.add?.providers).toEqual([expect.objectContaining({ id: "gateway", baseUrl: "http://127.0.0.1:9/v1" })]);
        expect(cleared?.["llm.pi-ai"]?.add?.providers?.[0]).not.toHaveProperty("logo");
        expect(removed).toEqual({ "llm.pi-ai": { remove: { providers: ["gateway"] } } });
        expect(rest).toEqual([]);
      },
      { "llm.pi-ai": { providers: [{ ...gateway.providers[0], logo: "<svg>old</svg>" }] } },
    );
  }, 30_000);

  it("says a stream of changes is live with its first element, then sends models-changed after any client's login or logout", () => {
    const { plugins } = gatewayLlm();
    return served(
      plugins,
      async (client) => {
        const [watching, other] = [await client(), await client()];
        answering(other, () => "sk-test");
        const changes: LlmChange[] = [];
        const close = watching.channel.open(LlmChannels.changes, undefined, (change) => changes.push(change));
        await until(() => changes.length === 1);
        expect(changes).toEqual([{ type: "subscribed" }]);
        const available = async () => (await watching.channel.call(LlmChannels.models, { available: true })).map((model) => model.ref);
        expect(await available()).toEqual([]);
        // Neither changes the models gateway lists, only whether they are available.
        await other.channel.call(LlmChannels.login, { provider: "gateway", type: "api_key" });
        await until(() => changes.length === 2);
        expect(changes[1]).toEqual({ type: "models-changed" });
        expect(await available()).toEqual(["gateway/m"]);
        await other.channel.call(LlmChannels.logout, { provider: "gateway" });
        await until(() => changes.length === 3);
        expect(changes[2]).toEqual({ type: "models-changed" });
        expect(await available()).toEqual([]);
        close();
      },
      { "llm.pi-ai": gateway },
    );
  }, 30_000);
});
