import { describe, expect, it } from "vitest";
import { Effect, Layer, Schema, Stream } from "effect";
import { connect } from "@lemma/client";
import type { Host } from "@lemma/client";
import {
  Agent,
  Channels,
  Commands,
  defineChannel,
  HostError,
  llmAddCustom,
  llmCancelLogin,
  llmChanges,
  llmLogin,
  llmLogout,
  llmModels,
  llmProviders,
  llmRemoveCustom,
  llmSetLogo,
  serveChannel,
  Sessions,
  Workspace,
} from "@lemma/contracts";
import type { LlmChange } from "@lemma/contracts";
import { readDiscovery } from "@lemma/contracts/discovery";
import { definePlugin, makeCore } from "@lemma/core";
import type { Plugin } from "@lemma/core";
import transport from "@lemma/plugin-transport";
import { settled } from "../../../scripts/e2e.ts";
import { makeLlmPlugin } from "../src/index.ts";
import { envContext, fakeCredentials, fakeHost, fakeInteraction, offline } from "./helpers.ts";

/** What else the transport requires, which llm's channels never reach. */
const stubs = definePlugin({
  id: "stubs",
  provides: [Sessions, Agent, Workspace, Commands],
  layer: Layer.mergeAll(
    Layer.succeed(Sessions, {} as never),
    Layer.succeed(Agent, {} as never),
    Layer.succeed(Workspace, {} as never),
    Layer.succeed(Commands, {} as never),
  ),
});

/**
 * Runs `plugins` behind the transport and a fake host, and hands `body` a way
 * to connect clients, which reach the llm plugin's channels as any client does.
 */
const served = (plugins: readonly Plugin[], body: (client: () => Promise<Host>, host: ReturnType<typeof fakeHost>) => Promise<void>, configs = {}) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const host = fakeHost();
        yield* makeCore([transport, stubs, host.plugin, ...plugins], { configs: { transport: { port: 0 }, ...configs } });
        const found = yield* readDiscovery(host.home);
        if (found === undefined) return yield* Effect.die(new Error("no discovery file"));
        const clients: Host[] = [];
        yield* Effect.addFinalizer(() => Effect.promise(() => Promise.all(clients.map((client) => client.close()))));
        const client = async () => {
          const opened = await connect({ url: found.url, token: found.token });
          clients.push(opened);
          return opened;
        };
        yield* Effect.promise(() => body(client, host));
      }),
    ).pipe(Effect.timeout("20 seconds")),
  );

const gateway = {
  providers: [
    { id: "gateway", name: "Gateway", api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1", apiKey: { env: "GATEWAY_KEY" }, models: [{ id: "m" }] },
  ],
};

/** The llm plugin with only `gateway`, offline, asking its questions of `answer`. */
const gatewayLlm = (answer: Parameters<typeof fakeInteraction>[0]) => {
  const credentials = fakeCredentials();
  const interaction = fakeInteraction(answer);
  const llm = makeLlmPlugin({ fetch: offline, providers: () => [], authContext: envContext() });
  return { credentials, interaction, plugins: [credentials.plugin, interaction.plugin, llm] };
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
    const { plugins } = gatewayLlm(() => Effect.succeed("unused"));
    return served(
      plugins,
      async (client) => {
        const host = await client();
        const listed = await host.channel.list();
        expect(listed.map((channel) => [channel.id, channel.kind, channel.source])).toEqual([
          ["llm.providers", "call", "llm"],
          ["llm.models", "call", "llm"],
          ["llm.login", "call", "llm"],
          ["llm.cancel-login", "call", "llm"],
          ["llm.logout", "call", "llm"],
          ["llm.add-custom", "call", "llm"],
          ["llm.remove-custom", "call", "llm"],
          ["llm.set-logo", "call", "llm"],
          ["llm.changes", "stream", "llm"],
        ]);
        expect(listed.every((channel) => channel.title !== undefined && channel.description !== undefined)).toBe(true);
        expect(await host.channel.call(llmProviders, undefined)).toEqual([
          { id: "gateway", name: "Gateway", auth: [{ type: "api_key", name: "Gateway API key", interactive: true }], configured: false, custom: true },
        ]);
        expect((await host.channel.call(llmModels, {})).map((model) => model.ref)).toEqual(["gateway/m"]);
        expect(await host.channel.call(llmModels, { available: true })).toEqual([]);
      },
      { llm: gateway },
    );
  }, 30_000);

  it("logs in, and fails with the error's reason as the code and its provider as the subject", () => {
    const { plugins, credentials, interaction } = gatewayLlm(() => Effect.succeed("sk-test"));
    return served(
      plugins,
      async (client) => {
        const host = await client();
        await host.channel.call(llmLogin, { provider: "gateway", type: "api_key" });
        expect(interaction.origins).toEqual(["login:gateway"]);
        expect(credentials.store.get("gateway")).toEqual({ type: "api_key", key: "sk-test" });
        expect((await host.channel.call(llmProviders, undefined))[0]).toMatchObject({ configured: true, source: "stored credential" });

        expect(await rejection(host.channel.call(llmLogin, { provider: "nope", type: "api_key" }))).toMatchObject({
          code: "UnknownProvider",
          subject: "nope",
          message: "Unknown provider: nope",
        });
        expect(await rejection(host.channel.call(llmLogin, { provider: "gateway", type: "oauth" }))).toMatchObject({
          code: "LoginFailed",
          subject: "gateway",
        });
        expect(await rejection(host.channel.call(llmRemoveCustom, { provider: "elsewhere" }))).toMatchObject({ code: "UnknownProvider", subject: "elsewhere" });
        // A payload its schema refuses names the channel.
        expect(await rejection(host.channel.call("llm.models", { available: "yes" }))).toMatchObject({ code: "InvalidPayload", subject: "llm.models" });

        await host.channel.call(llmLogout, { provider: "gateway" });
        expect(credentials.store.has("gateway")).toBe(false);
      },
      { llm: gateway },
    );
  }, 30_000);

  it("lets any client cancel a running login: its question is withdrawn and the call fails Cancelled", () => {
    let withdrawn = false;
    const { plugins, interaction } = gatewayLlm(() => Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => (withdrawn = true)))));
    return served(
      plugins,
      async (client) => {
        const [starter, other] = [await client(), await client()];
        expect(await other.channel.call(llmCancelLogin, { provider: "gateway" })).toBe(false);
        const login = rejection(starter.channel.call(llmLogin, { provider: "gateway", type: "api_key" }));
        await until(() => interaction.asked.length === 1);
        expect(await other.channel.call(llmCancelLogin, { provider: "gateway" })).toBe(true);
        expect(await login).toMatchObject({ code: "Cancelled", subject: "gateway" });
        expect(withdrawn).toBe(true);
        expect(await other.channel.call(llmCancelLogin, { provider: "gateway" })).toBe(false);
      },
      { llm: gateway },
    );
  }, 30_000);

  it("keeps a login running when its caller's connection drops; another client's call waits for it, and one of the other type is Busy", () => {
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => (answer = resolve));
    let withdrawn = false;
    const { plugins, interaction, credentials } = gatewayLlm(() =>
      Effect.promise(() => answered).pipe(
        Effect.as("sk-late"),
        Effect.onInterrupt(() => Effect.sync(() => (withdrawn = true))),
      ),
    );
    return served(
      [...plugins, probe],
      async (client) => {
        const [leaving, staying] = [await client(), await client()];
        leaving.channel.open("probe.open", undefined, () => {});
        await until(() => probes === 1);
        void leaving.channel.call(llmLogin, { provider: "gateway", type: "api_key" }).catch(() => undefined);
        await until(() => interaction.asked.length === 1);
        await leaving.close();
        // The host has dropped the leaving client's requests: its login call among them.
        await until(() => probes === 0);
        expect(withdrawn).toBe(false);
        const joined = staying.channel.call(llmLogin, { provider: "gateway", type: "api_key" });
        expect(await rejection(staying.channel.call(llmLogin, { provider: "gateway", type: "oauth" }))).toMatchObject({
          code: "Busy",
          subject: "gateway",
          message: 'A api_key login to "gateway" is in progress',
        });
        answer();
        await joined;
        // One flow, one question: the second call waited for the first's.
        expect(interaction.asked).toHaveLength(1);
        expect(credentials.store.get("gateway")).toEqual({ type: "api_key", key: "sk-late" });
      },
      { llm: gateway },
    );
  }, 30_000);

  it("adds and removes providers of the user's, and sets their logos, in the llm plugin's config", () => {
    const { plugins } = gatewayLlm(() => Effect.succeed("unused"));
    return served(
      plugins,
      async (client, host) => {
        const user = await client();
        expect(
          await user.channel.call(llmAddCustom, {
            spec: { name: "Local", api: "openai-completions", baseUrl: "http://localhost:11434/v1", models: ["qwen3"] },
          }),
        ).toBe("local");
        await user.channel.call(llmSetLogo, { provider: "gateway", svg: "<svg>new</svg>" });
        await user.channel.call(llmSetLogo, { provider: "gateway" });
        await user.channel.call(llmRemoveCustom, { provider: "gateway" });
        // Each one saved: the host's reload would list the change.
        const [added, logo, cleared, removed, ...rest] = host.saved;
        expect(added).toEqual({ llm: { add: { providers: [expect.objectContaining({ id: "local", api: "openai-completions" })] } } });
        expect(logo).toEqual({
          llm: { add: { providers: [expect.objectContaining({ id: "gateway", baseUrl: "http://127.0.0.1:9/v1", logo: "<svg>new</svg>" })] } },
        });
        expect(cleared?.llm?.add?.providers).toEqual([expect.objectContaining({ id: "gateway", baseUrl: "http://127.0.0.1:9/v1" })]);
        expect(cleared?.llm?.add?.providers?.[0]).not.toHaveProperty("logo");
        expect(removed).toEqual({ llm: { remove: { providers: ["gateway"] } } });
        expect(rest).toEqual([]);
      },
      { llm: { providers: [{ ...gateway.providers[0], logo: "<svg>old</svg>" }] } },
    );
  }, 30_000);

  it("says a stream of changes is live with its first element, then sends models-changed after any client's login or logout", () => {
    const { plugins } = gatewayLlm(() => Effect.succeed("sk-test"));
    return served(
      plugins,
      async (client) => {
        const [watching, other] = [await client(), await client()];
        const changes: LlmChange[] = [];
        const close = watching.channel.open(llmChanges, undefined, (change) => changes.push(change));
        await until(() => changes.length === 1);
        expect(changes).toEqual([{ type: "subscribed" }]);
        const available = async () => (await watching.channel.call(llmModels, { available: true })).map((model) => model.ref);
        expect(await available()).toEqual([]);
        // Neither changes the models gateway lists, only whether they are available.
        await other.channel.call(llmLogin, { provider: "gateway", type: "api_key" });
        await until(() => changes.length === 2);
        expect(changes[1]).toEqual({ type: "models-changed" });
        expect(await available()).toEqual(["gateway/m"]);
        await other.channel.call(llmLogout, { provider: "gateway" });
        await until(() => changes.length === 3);
        expect(changes[2]).toEqual({ type: "models-changed" });
        expect(await available()).toEqual([]);
        close();
      },
      { llm: gateway },
    );
  }, 30_000);
});
