import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { arch, platform, release, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Chunk, Effect, Fiber, Layer, Schema, Stream } from "effect";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import type { FauxProviderHandle, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { Events, PluginContext, definePlugin } from "@lemma/core";
import { CredentialError, Credentials, InteractionError, Llm, LlmError, LlmRequest, LlmRequestHook, ModelsChanged, StreamEvent } from "@lemma/contracts";
import type { Credential } from "@lemma/contracts";
import { deviceId } from "../src/device.ts";
import { fixedCatalog, makeEventMapper, makeLlmPlugin } from "../src/index.ts";
import type { LlmProvider, OAuthMethod, ProviderAuth } from "../src/index.ts";
import { envOf, fakeCredentials, fakeHost, fakeInteraction, noticeRecorder, offline, runWith } from "./helpers.ts";

const decodeEvent = Schema.decodeUnknownSync(StreamEvent, { onExcessProperty: "error" });

const user = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }], timestamp: 1 });

/** pi-ai's faux provider as a Lemma provider: its models, sent through its own stream; keyless unless `auth` says otherwise. */
const fauxLlm = (
  faux: FauxProviderHandle,
  auth: ProviderAuth = { key: { token: "faux-key", source: "test" } },
  extra: Partial<LlmProvider> = {},
): LlmProvider => ({
  id: faux.provider.id,
  name: faux.provider.name,
  auth,
  catalog: fixedCatalog(faux.provider.getModels()),
  stream: faux.provider.streamSimple,
  ...extra,
});

function setup(options: { providers?: () => readonly LlmProvider[]; env?: Record<string, string>; credentials?: Record<string, Credential> } = {}) {
  const faux = fauxProvider({
    provider: "faux",
    models: [
      { id: "plain", reasoning: false },
      { id: "thinker", reasoning: true },
    ],
  });
  const credentials = fakeCredentials(options.credentials);
  const interaction = fakeInteraction(() => Effect.succeed("sk-test"));
  const llm = makeLlmPlugin({ fetch: offline, providers: options.providers ?? (() => [fauxLlm(faux)]), env: envOf(options.env) });
  return { faux, credentials, interaction, plugins: [credentials.plugin, interaction.plugin, llm] as const };
}

const collect = (request: LlmRequest) => Effect.flatMap(Llm, (llm) => Stream.runCollect(llm.stream(request))).pipe(Effect.map(Chunk.toArray));

describe("stream", () => {
  it("maps text and tool calls to schema-conformant events", async () => {
    const { faux, plugins } = setup();
    faux.setResponses([fauxAssistantMessage([fauxText("Hello there"), fauxToolCall("echo", { text: "x" }, { id: "call-1" })], { stopReason: "toolUse" })]);
    const events = await runWith(
      plugins,
      collect(
        new LlmRequest({
          model: "faux/plain",
          system: "Be brief",
          messages: [user("hi")],
          tools: [{ name: "echo", description: "Echo", parameters: { type: "object", properties: { text: { type: "string" } } } }],
        }),
      ),
    );

    events.forEach((event) => decodeEvent(event));
    expect(events[0]).toEqual({ type: "start" });
    expect(
      events
        .filter((e) => e.type === "text-delta")
        .map((e) => e.delta)
        .join(""),
    ).toBe("Hello there");
    expect(events.find((e) => e.type === "toolcall-start")).toMatchObject({ index: 1, id: "call-1", name: "echo" });
    expect(events.find((e) => e.type === "toolcall-end")).toMatchObject({
      toolCall: { type: "toolCall", id: "call-1", name: "echo", arguments: { text: "x" } },
    });
    const last = events.at(-1)!;
    expect(last.type).toBe("done");
    expect(events.filter((e) => e.type === "done" || e.type === "error")).toHaveLength(1);
    if (last.type === "done") {
      expect(last.message).toMatchObject({ role: "assistant", provider: "faux", model: "plain", stopReason: "toolUse" });
      expect(last.message.content).toHaveLength(2);
    }
  });

  it("streams thinking and passes the reasoning level", async () => {
    const { faux, plugins } = setup();
    const seen: (SimpleStreamOptions | undefined)[] = [];
    const reply = (_: unknown, options: SimpleStreamOptions | undefined) => {
      seen.push(options);
      return fauxAssistantMessage([fauxThinking("Let me think"), fauxText("42")]);
    };
    faux.setResponses([reply, reply]);
    const events = await runWith(
      plugins,
      collect(
        new LlmRequest({
          model: "faux/thinker",
          messages: [user("q")],
          thinking: "high",
          sessionId: "s1",
        }),
      ),
    );
    await runWith(plugins, collect(new LlmRequest({ model: "faux/thinker", messages: [user("q")], thinking: "off" })));

    expect(
      events
        .filter((e) => e.type === "thinking-delta")
        .map((e) => e.delta)
        .join(""),
    ).toBe("Let me think");
    expect(seen[0]).toMatchObject({ reasoning: "high", sessionId: "s1" });
    expect(seen[1]?.reasoning).toBeUndefined();
  });

  it("aborts the provider request when the consumer stops", async () => {
    const faux = fauxProvider({ provider: "slow", tokensPerSecond: 20 });
    const { plugins } = setup({ providers: () => [fauxLlm(faux)] });
    let signal: AbortSignal | undefined;
    faux.setResponses([
      (_, options) => {
        signal = options?.signal;
        return fauxAssistantMessage("a long answer ".repeat(50));
      },
    ]);
    const events = await runWith(
      plugins,
      Effect.flatMap(Llm, (llm) =>
        Stream.runCollect(llm.stream(new LlmRequest({ model: `slow/${faux.getModel().id}`, messages: [user("go")] })).pipe(Stream.take(2))),
      ),
    );

    expect(Chunk.size(events)).toBe(2);
    expect(signal?.aborted).toBe(true);
  });

  it("ends an aborted provider response with an error event", async () => {
    const { faux, plugins } = setup();
    faux.setResponses([fauxAssistantMessage([fauxText("partial")], { stopReason: "aborted", errorMessage: "Request was aborted" })]);
    const events = await runWith(plugins, collect(new LlmRequest({ model: "faux/plain", messages: [user("hi")] })));
    const last = events.at(-1)!;
    expect(last.type).toBe("error");
    if (last.type === "error") expect(last.message).toMatchObject({ stopReason: "aborted", errorMessage: "Request was aborted" });
  });

  it("fails with UnknownModel before starting", async () => {
    const { plugins } = setup();
    const error = await runWith(plugins, Effect.flip(collect(new LlmRequest({ model: "faux/missing", messages: [] }))));
    expect(error).toBeInstanceOf(LlmError);
    expect(error.reason).toBe("UnknownModel");
    const byRef = await runWith(plugins, Effect.flip(Effect.flatMap(Llm, (llm) => llm.model("nonsense"))));
    expect(byRef.reason).toBe("UnknownModel");
  });

  it("runs LlmRequestHook around the provider", async () => {
    const { faux, plugins } = setup();
    const router = definePlugin({
      id: "router",
      layer: Layer.effectDiscard(
        Effect.gen(function* () {
          const context = yield* PluginContext;
          yield* context.on(LlmRequestHook, (request, next) =>
            request.model === "alias/default" ? next(new LlmRequest({ ...request, model: "faux/plain" })) : next(request),
          );
        }),
      ),
    });
    faux.setResponses([fauxAssistantMessage("routed")]);
    const events = await runWith([...plugins, router], collect(new LlmRequest({ model: "alias/default", messages: [user("hi")] })));
    const last = events.at(-1)!;
    expect(last.type === "done" && last.message.content).toEqual([{ type: "text", text: "routed" }]);
  });

  it("tells the user to log in when a provider has no credentials", async () => {
    const { plugins } = setup({ providers: () => [] });
    const config = {
      providers: [{ id: "gateway", api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1", apiKey: { env: "GATEWAY_KEY" }, models: [{ id: "m" }] }],
    };
    const events = await runWith(plugins, collect(new LlmRequest({ model: "gateway/m", messages: [user("hi")] })), { llm: config });
    events.forEach((event) => decodeEvent(event));
    expect(events.map((e) => e.type)).toEqual(["start", "error"]);
    const last = events[1]!;
    expect(last.type === "error" && last.message.errorMessage).toContain("/login gateway");
  });

  it("treats a stored entry without a key as none, falling back to the environment", async () => {
    const { plugins } = setup({
      providers: () => [fauxLlm(fauxProvider({ provider: "zen" }), { apiKey: "Zen key", env: ["ZEN_KEY"] })],
      env: { ZEN_KEY: "from-env" },
      credentials: { zen: { type: "api_key", key: "" } },
    });
    const [zen] = await runWith(
      plugins,
      Effect.flatMap(Llm, (l) => l.providers),
    );
    expect(zen).toMatchObject({ configured: true, source: "ZEN_KEY" });
  });

  it("sends a stored key over the environment's, with the provider's session headers", async () => {
    const faux = fauxProvider({ provider: "zen" });
    const seen: (SimpleStreamOptions | undefined)[] = [];
    const reply = (_: unknown, options: SimpleStreamOptions | undefined) => {
      seen.push(options);
      return fauxAssistantMessage("ok");
    };
    faux.setResponses([reply, reply]);
    const zen = fauxLlm(
      faux,
      { apiKey: "Zen key", env: ["ZEN_KEY"] },
      { headers: (sessionId) => (sessionId === undefined ? undefined : { "x-session": sessionId }) },
    );
    const request = new LlmRequest({ model: `zen/${faux.getModel().id}`, messages: [user("hi")], sessionId: "s1" });
    await runWith(setup({ providers: () => [zen], env: { ZEN_KEY: "from-env" } }).plugins, collect(request));
    await runWith(
      setup({ providers: () => [zen], env: { ZEN_KEY: "from-env" }, credentials: { zen: { type: "api_key", key: "stored" } } }).plugins,
      collect(request),
    );

    expect(seen.map((options) => options?.apiKey)).toEqual(["from-env", "stored"]);
    expect(seen[0]?.headers).toMatchObject({ "x-session": "s1", "User-Agent": expect.stringMatching(/^lemma \(/) });
  });
});

describe("event mapper", () => {
  const model = fauxProvider().getModel();

  it("synthesizes start and a terminal when pi-ai omits them", () => {
    const mapper = makeEventMapper(model);
    expect(mapper.end().map((e) => e.type)).toEqual(["start", "error"]);
    expect(mapper.end()).toEqual([]);
  });

  it("maps a pending stop reason to an error", () => {
    const mapper = makeEventMapper(model);
    const message = fauxAssistantMessage("x", { stopReason: "pending" });
    const [start, terminal] = mapper.push({ type: "done", reason: "stop", message });
    expect(start).toEqual({ type: "start" });
    expect(terminal).toMatchObject({ type: "error", message: { stopReason: "error" } });
    expect(mapper.finished).toBe(true);
  });
});

describe("catalog", () => {
  it("lists configured OpenAI-compatible providers, keyless ones as available", async () => {
    const { plugins } = setup({ providers: () => [] });
    const config = {
      providers: [
        {
          id: "ollama",
          name: "Ollama",
          api: "openai-completions",
          baseUrl: "http://localhost:11434/v1",
          compat: { supportsDeveloperRole: false },
          models: [{ id: "qwen3:8b", reasoning: true }],
        },
        {
          id: "keyed",
          api: "openai-responses",
          baseUrl: "https://example.test/v1",
          apiKey: { env: "KEYED_KEY" },
          models: [{ id: "big", contextWindow: 200000 }],
        },
      ],
    };
    const result = await runWith(
      plugins,
      Effect.flatMap(Llm, (llm) => Effect.all({ all: llm.models(), available: llm.models({ available: true }), providers: llm.providers })),
      { llm: config },
    );

    expect(result.all.map((m) => m.ref)).toEqual(["ollama/qwen3:8b", "keyed/big"]);
    expect(result.all[0]).toMatchObject({
      name: "qwen3:8b",
      api: "openai-completions",
      reasoning: true,
      input: ["text"],
      contextWindow: 128000,
      maxTokens: 16384,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    expect(result.all[0]!.thinkingLevels).toContain("high");
    expect(result.available.map((m) => m.ref)).toEqual(["ollama/qwen3:8b"]);
    expect(result.providers).toEqual([
      {
        id: "ollama",
        name: "Ollama",
        auth: [{ type: "api_key", name: "Ollama API key", interactive: true }],
        configured: true,
        source: "no key required",
        custom: true,
      },
      { id: "keyed", name: "keyed", auth: [{ type: "api_key", name: "keyed API key", interactive: true }], configured: false, custom: true },
    ]);
  });

  it("offers OpenAI, OpenCode Zen, and OpenCode Go, one OpenCode key serving both", async () => {
    // Default built-ins: the plugin's real provider list.
    const llm = makeLlmPlugin({ fetch: offline, env: envOf({ OPENCODE_API_KEY: "sk-oc" }) });
    const plugins = [fakeCredentials().plugin, fakeInteraction(() => Effect.succeed("")).plugin, llm];
    const providers = await runWith(
      plugins,
      Effect.flatMap(Llm, (l) => l.providers),
    );
    expect(providers.map((p) => [p.id, p.name, p.configured, p.source])).toEqual([
      ["openai", "OpenAI", false, undefined],
      ["opencode", "OpenCode Zen", true, "OPENCODE_API_KEY"],
      ["opencode-go", "OpenCode Go", true, "OPENCODE_API_KEY"],
    ]);
    expect(providers[0]!.auth).toEqual([
      { type: "api_key", name: "OpenAI API key", interactive: true },
      { type: "oauth", name: "Sign in with ChatGPT", interactive: true },
    ]);
  });

  it("filters built-ins with include and exclude, and lets the user's provider replace one", async () => {
    const { plugins } = setup({ providers: () => [fauxLlm(fauxProvider({ provider: "a" })), fauxLlm(fauxProvider({ provider: "b" }))] });
    const listed = await runWith(
      plugins,
      Effect.flatMap(Llm, (l) => l.providers),
      {
        llm: {
          include: ["a", "b"],
          exclude: ["b"],
          providers: [{ id: "a", name: "Mine", api: "openai-completions", baseUrl: "http://localhost:1/v1", models: [{ id: "m" }] }],
        },
      },
    );
    expect(listed.map((p) => [p.id, p.name, p.custom])).toEqual([["a", "Mine", true]]);
  });
});

describe("model catalogs", () => {
  it("leaves a catalog as it is when its provider's sign-in cannot be renewed just now", async () => {
    const refreshed: ("signed-in" | "signed-out")[] = [];
    const sso: OAuthMethod = {
      name: "SSO",
      login: () => Effect.die("not used"),
      refresh: () => Effect.fail(new LlmError({ reason: "LoginFailed", message: "offline" })),
    };
    const faux = fauxProvider({ provider: "sso" });
    const provider = fauxLlm(
      faux,
      { oauth: sso },
      {
        catalog: { models: () => faux.provider.getModels(), refresh: async ({ auth }) => void refreshed.push(auth === undefined ? "signed-out" : "signed-in") },
      },
    );
    const { plugins } = setup({ providers: () => [provider], credentials: { sso: { type: "oauth", access: "a", refresh: "r", expires: Date.now() - 1 } } });
    await runWith(plugins, Effect.sleep("50 millis"));
    // Refreshing it as signed out would replace a ChatGPT plan's list with the API's.
    expect(refreshed).toEqual([]);
  });

  it("tells clients when a refresh changed the models, and not when it did not", async () => {
    // A provider whose list grows on every refresh after the first (at startup).
    let refreshes = 0;
    const faux = fauxProvider({ provider: "grow", models: [{ id: "a" }] });
    const models = [...faux.provider.getModels()];
    const provider = fauxLlm(faux, undefined, {
      catalog: {
        models: () => models,
        refresh: async () => {
          if (refreshes++ === 0) return;
          models.push({ ...models[0]!, id: `m${refreshes}` });
        },
      },
    });
    const { plugins } = setup({ providers: () => [provider] });
    const changes = await runWith(
      plugins,
      Effect.gen(function* () {
        const events = yield* Events;
        const llm = yield* Llm;
        yield* Effect.sleep("50 millis");
        const heard = yield* Effect.fork(Stream.runCollect(Stream.take(events.stream(ModelsChanged), 1)));
        yield* Effect.yieldNow();
        // Logging out refreshes the provider's catalog, which grows this time.
        yield* llm.logout("grow");
        yield* Fiber.join(heard);
        return (yield* llm.models()).map((model) => model.ref);
      }),
    );
    expect(changes).toEqual(["grow/a", "grow/m2"]);
  });
});

describe("login", () => {
  const gateway = {
    providers: [
      { id: "gateway", name: "Gateway", api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1", apiKey: { env: "GATEWAY_KEY" }, models: [{ id: "m" }] },
    ],
  };

  it("asks for an API key through Interaction and stores it", async () => {
    const { plugins, credentials, interaction } = setup({ providers: () => [] });
    const after = await runWith(
      plugins,
      Effect.gen(function* () {
        const llm = yield* Llm;
        yield* llm.login("gateway", "api_key");
        return yield* llm.providers;
      }),
      { llm: gateway },
    );

    expect(interaction.asked).toEqual([{ type: "ask", title: "Enter the Gateway API key", secret: true }]);
    expect(credentials.store.get("gateway")).toEqual({ type: "api_key", key: "sk-test" });
    expect(after[0]).toMatchObject({ configured: true, source: "stored credential" });

    await runWith(
      plugins,
      Effect.flatMap(Llm, (l) => l.logout("gateway")),
      { llm: gateway },
    );
    expect(credentials.store.has("gateway")).toBe(false);
  });

  it("reports a dismissed prompt as Cancelled and unknown providers as UnknownProvider", async () => {
    const credentials = fakeCredentials();
    const interaction = fakeInteraction(() => Effect.fail(new InteractionError({ reason: "Dismissed", message: "closed" })));
    const plugins = [credentials.plugin, interaction.plugin, makeLlmPlugin({ fetch: offline, providers: () => [], env: envOf() })];
    const cancelled = await runWith(plugins, Effect.flip(Effect.flatMap(Llm, (l) => l.login("gateway", "api_key"))), { llm: gateway });
    expect(cancelled.reason).toBe("Cancelled");
    const unknown = await runWith(plugins, Effect.flip(Effect.flatMap(Llm, (l) => l.login("nope", "api_key"))), { llm: gateway });
    expect(unknown.reason).toBe("UnknownProvider");
    const unsupported = await runWith(plugins, Effect.flip(Effect.flatMap(Llm, (l) => l.login("gateway", "oauth"))), { llm: gateway });
    expect(unsupported.reason).toBe("LoginFailed");
  });

  it("signs in through the provider's flow, telling every client, and withdraws the prompt the flow abandons", async () => {
    let withdrawn = false;
    const credentials = fakeCredentials();
    const interaction = fakeInteraction((question) =>
      question.title === "Paste the code"
        ? Effect.never.pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                withdrawn = true;
              }),
            ),
          )
        : Effect.succeed("unused"),
    );
    const recorder = noticeRecorder();
    const sso: OAuthMethod = {
      name: "SSO account",
      login: (ui) =>
        Effect.gen(function* () {
          yield* ui.notify({ level: "info", source: "llm", message: "Open the link", links: [{ url: "https://sso.test/authorize" }] });
          // A paste prompt raced by a browser callback that arrives first.
          yield* Effect.raceFirst(ui.ask("Paste the code"), Effect.as(Effect.sleep("10 millis"), "callback"));
          return { type: "oauth" as const, access: "token", refresh: "refresh", expires: Date.now() + 3_600_000, accountId: "acct" };
        }),
      refresh: (credential) => Effect.succeed(credential),
    };
    const plugins = [
      credentials.plugin,
      interaction.plugin,
      recorder.plugin,
      makeLlmPlugin({ fetch: offline, providers: () => [fauxLlm(fauxProvider({ provider: "sso" }), { oauth: sso }, { name: "SSO" })], env: envOf() }),
    ];
    const info = await runWith(
      plugins,
      Effect.gen(function* () {
        const llm = yield* Llm;
        yield* llm.login("sso", "oauth");
        yield* Effect.sleep("20 millis");
        return yield* llm.providers;
      }),
    );

    expect(withdrawn).toBe(true);
    expect(credentials.store.get("sso")).toMatchObject({ type: "oauth", access: "token", accountId: "acct" });
    expect(info[0]).toMatchObject({ auth: [{ type: "oauth", name: "SSO account", interactive: true }], configured: true, source: "OAuth" });
    expect(recorder.notices).toEqual([
      { level: "info", source: "llm", message: "Open the link", links: [{ url: "https://sso.test/authorize" }] },
      // Success is announced to every client after the flow's own notices.
      { level: "info", source: "llm", message: "Logged in to SSO" },
    ]);
  });

  it("renews a sign-in about to expire once, for requests that need it at the same time", async () => {
    const faux = fauxProvider({ provider: "sso" });
    const sent: (string | undefined)[] = [];
    const reply = (_: unknown, options: SimpleStreamOptions | undefined) => {
      sent.push(options?.apiKey);
      return fauxAssistantMessage("ok");
    };
    faux.setResponses([reply, reply]);
    let renewals = 0;
    const sso: OAuthMethod = {
      name: "SSO",
      login: () => Effect.die("not used"),
      refresh: (credential) =>
        Effect.sync(() => ({ ...credential, access: `renewed-${++renewals}`, expires: Date.now() + 3_600_000 })).pipe(Effect.delay("10 millis")),
    };
    const { plugins, credentials } = setup({
      providers: () => [fauxLlm(faux, { oauth: sso })],
      credentials: { sso: { type: "oauth", access: "old", refresh: "r", expires: Date.now() + 60_000, clientId: "kept" } },
    });
    const request = new LlmRequest({ model: `sso/${faux.getModel().id}`, messages: [user("hi")] });
    await runWith(plugins, Effect.all([collect(request), collect(request)], { concurrency: 2 }));

    expect(renewals).toBe(1);
    expect(sent).toEqual(["renewed-1", "renewed-1"]);
    expect(credentials.store.get("sso")).toMatchObject({ access: "renewed-1", clientId: "kept" });
  });

  it("sends a token that has not expired when renewing it fails, or when the provider asks not to renew it yet", async () => {
    const faux = fauxProvider({ provider: "sso" });
    const sent: (string | undefined)[] = [];
    const reply = (_: unknown, options: SimpleStreamOptions | undefined) => {
      sent.push(options?.apiKey);
      return fauxAssistantMessage("ok");
    };
    faux.setResponses([reply, reply]);
    let renewals = 0;
    const sso: OAuthMethod = {
      name: "SSO",
      login: () => Effect.die("not used"),
      refresh: () => Effect.suspend(() => (renewals++, Effect.fail(new LlmError({ reason: "LoginFailed", message: "offline" })))),
    };
    const request = new LlmRequest({ model: `sso/${faux.getModel().id}`, messages: [user("hi")] });
    const due: Credential = { type: "oauth", access: "still-good", refresh: "r", expires: Date.now() + 60_000 };
    await runWith(setup({ providers: () => [fauxLlm(faux, { oauth: sso })], credentials: { sso: due } }).plugins, collect(request));
    expect(renewals).toBeGreaterThan(0);
    const tried = renewals;
    const later: Credential = { ...due, access: "not-yet", earliestRefreshAt: Date.now() + 30_000 };
    await runWith(setup({ providers: () => [fauxLlm(faux, { oauth: sso })], credentials: { sso: later } }).plugins, collect(request));

    expect(sent).toEqual(["still-good", "not-yet"]);
    expect(renewals).toBe(tried);
  });

  it("ends the request with the renewal's failure, keeping the sign-in", async () => {
    const sso: OAuthMethod = {
      name: "SSO",
      login: () => Effect.die("not used"),
      refresh: () => Effect.fail(new LlmError({ reason: "NotConfigured", message: "The sign-in expired. Run /login sso to sign in again." })),
    };
    const faux = fauxProvider({ provider: "sso" });
    const stored: Credential = { type: "oauth", access: "old", refresh: "r", expires: Date.now() - 1 };
    const { plugins, credentials } = setup({ providers: () => [fauxLlm(faux, { oauth: sso })], credentials: { sso: stored } });
    const events = await runWith(plugins, collect(new LlmRequest({ model: `sso/${faux.getModel().id}`, messages: [user("hi")] })));

    expect(events.map((e) => e.type)).toEqual(["start", "error"]);
    // The flow's own message, which says what to do.
    expect(events[1]!.type === "error" && events[1]!.message.errorMessage).toBe("The sign-in expired. Run /login sso to sign in again.");
    expect(credentials.store.get("sso")).toEqual(stored);
  });

  it("ends the session stored under the lock at logout, and forgets an entry it cannot read", async () => {
    const revoked: string[] = [];
    const sso: OAuthMethod = {
      name: "SSO",
      login: () => Effect.die("not used"),
      refresh: (credential) => Effect.succeed(credential),
      revoke: (credential) => Effect.sync(() => void revoked.push(credential.refresh)),
    };
    // A read sees the token a renewal has since replaced; the lock holder sees the current one.
    const store = (entry: (provider: string) => Effect.Effect<Credential | undefined, CredentialError>) => {
      const removed: string[] = [];
      const service: typeof Credentials.Service = {
        read: () => Effect.succeed({ type: "oauth", access: "a", refresh: "stale", expires: Date.now() + 3_600_000 }),
        list: Effect.succeed([]),
        modify: (provider, update) => Effect.flatMap(entry(provider), (current) => Effect.as(update(current), current)),
        remove: (provider) => Effect.sync(() => void removed.push(provider)),
      };
      return { removed, plugin: definePlugin({ id: "credentials", provides: [Credentials], layer: Layer.succeed(Credentials, service) }) };
    };
    const llm = makeLlmPlugin({ fetch: offline, providers: () => [fauxLlm(fauxProvider({ provider: "sso" }), { oauth: sso })], env: envOf() });
    const interaction = fakeInteraction(() => Effect.succeed("")).plugin;

    const current = store(() => Effect.succeed({ type: "oauth", access: "a", refresh: "current", expires: Date.now() + 3_600_000 }));
    await runWith(
      [current.plugin, interaction, llm],
      Effect.flatMap(Llm, (l) => l.logout("sso")),
    );
    expect(revoked).toEqual(["current"]);
    expect(current.removed).toEqual(["sso"]);

    const recorder = noticeRecorder();
    const corrupt = store(() => Effect.fail(new CredentialError({ reason: "Corrupt", message: "invalid credential" })));
    await runWith(
      [corrupt.plugin, interaction, recorder.plugin, llm],
      Effect.flatMap(Llm, (l) => l.logout("sso")),
    );
    expect(corrupt.removed).toEqual(["sso"]);
    expect(recorder.notices.map((notice) => notice.level)).toEqual(["warning"]);
  });

  it("ends a sign-in's session at logout, and forgets it locally even when that fails", async () => {
    const revoked: string[] = [];
    const sso = (works: boolean): OAuthMethod => ({
      name: "SSO",
      login: () => Effect.die("not used"),
      refresh: (credential) => Effect.succeed(credential),
      revoke: (credential) =>
        works ? Effect.sync(() => void revoked.push(credential.refresh)) : Effect.fail(new LlmError({ reason: "LoginFailed", message: "offline" })),
    });
    const stored: Credential = { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3_600_000 };
    for (const works of [true, false]) {
      const recorder = noticeRecorder();
      const { plugins, credentials } = setup({
        providers: () => [fauxLlm(fauxProvider({ provider: "sso" }), { oauth: sso(works) })],
        credentials: { sso: stored },
      });
      await runWith(
        [...plugins, recorder.plugin],
        Effect.flatMap(Llm, (llm) => llm.logout("sso")),
      );
      expect(credentials.store.has("sso")).toBe(false);
      expect(recorder.notices.map((notice) => notice.level)).toEqual(works ? [] : ["warning"]);
    }
    expect(revoked).toEqual(["r"]);
  });
});

describe("custom providers", () => {
  it("adds, relabels, and removes the user's providers through its own config", async () => {
    const host = fakeHost();
    const { plugins } = setup({ providers: () => [] });
    const gateway = { providers: [{ id: "my-gateway", name: "My Gateway", api: "openai-completions", baseUrl: "http://localhost:1", models: [{ id: "m" }] }] };
    const [added, bad, missing] = await runWith(
      [...plugins, host.plugin],
      Effect.gen(function* () {
        const llm = yield* Llm;
        const added = yield* llm.addCustom({
          name: "My Gateway",
          api: "openai-completions",
          baseUrl: "http://example.test/v1/",
          models: ["a", "b", "a"],
          key: true,
        });
        const bad = yield* Effect.flip(llm.addCustom({ name: "X", api: "carrier-pigeon", baseUrl: "http://x", models: ["m"] }));
        // Only the table's own keys are wire APIs.
        const inherited = yield* Effect.flip(llm.addCustom({ name: "X", api: "toString", baseUrl: "http://x", models: ["m"] }));
        expect(inherited).toMatchObject({ reason: "InvalidProvider" });
        yield* llm.setLogo("my-gateway", "<svg/>");
        yield* llm.removeCustom("my-gateway");
        const missing = yield* Effect.flip(llm.removeCustom("never-added"));
        return [added, bad, missing] as const;
      }),
      { llm: gateway },
    );
    // Its id avoids the one already taken; the key is asked for at login or read from the environment.
    expect(added).toBe("my-gateway-2");
    expect(bad).toMatchObject({ reason: "InvalidProvider" });
    expect(missing).toMatchObject({ reason: "UnknownProvider" });
    expect(host.saved).toEqual([
      {
        llm: {
          add: {
            providers: [
              {
                id: "my-gateway-2",
                name: "My Gateway",
                api: "openai-completions",
                baseUrl: "http://example.test/v1",
                models: [{ id: "a" }, { id: "b" }],
                apiKey: { env: "MY_GATEWAY_2_API_KEY" },
              },
            ],
          },
        },
      },
      { llm: { add: { providers: [{ ...gateway.providers[0], logo: "<svg/>" }] } } },
      { llm: { remove: { providers: ["my-gateway"] } } },
    ]);
    // A saved logo is how clients show the provider.
    const listed = await runWith(
      [...plugins, host.plugin],
      Effect.flatMap(Llm, (llm) => llm.providers),
      { llm: { providers: [{ ...gateway.providers[0], logo: "<svg/>" }] } },
    );
    expect(listed.find((provider) => provider.id === "my-gateway")).toMatchObject({ custom: true, logo: "<svg/>" });
    expect(host.scopes).toEqual([undefined, undefined, undefined]);
  });

  it("saves the user's providers in the config file its config comes from", async () => {
    const host = fakeHost({ configScope: "project" });
    const { plugins } = setup({ providers: () => [] });
    await runWith(
      [...plugins, host.plugin],
      Effect.flatMap(Llm, (llm) => llm.addCustom({ name: "Local", api: "openai-completions", baseUrl: "http://localhost:1", models: ["m"] })),
    );
    expect(host.scopes).toEqual(["project"]);
  });
});

describe("deviceId", () => {
  it("makes the installation's ID once and keeps it, replacing a file that holds no ID", () => {
    const home = mkdtempSync(join(tmpdir(), "lemma-device-"));
    const id = deviceId(home);
    expect(deviceId(home)).toBe(id);
    writeFileSync(join(home, "device-id"), "not an id\n");
    const replaced = deviceId(home);
    expect(replaced).not.toBe(id);
    expect(deviceId(home)).toBe(replaced);
  });
});

describe("identity", () => {
  it("names Lemma, not pi, on every wire API, unless a model sends its own User-Agent, and sends the model's headers", async () => {
    const agents: Record<string, string | undefined> = {};
    const gateway: Record<string, string | undefined> = {};
    const server = createServer((request, response) => {
      const path = new URL(request.url ?? "", "http://x").pathname;
      agents[path] = request.headers["user-agent"];
      gateway[path.split("/")[1]!] = request.headers["x-gateway-key"] as string | undefined;
      response.writeHead(400, { "content-type": "application/json" }).end('{"error":{"message":"recorded"}}');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const provider = (id: string, api: string, headers?: Record<string, string>) => ({
      id,
      api,
      baseUrl: `http://127.0.0.1:${port}/${id}`,
      apiKey: { value: "sk-test" },
      ...(headers === undefined ? {} : { headers }),
      models: [{ id: "m" }],
    });
    const providers = [
      provider("completions", "openai-completions"),
      provider("responses", "openai-responses"),
      provider("anthropic", "anthropic-messages"),
      provider("copilot", "openai-completions", { "User-Agent": "GitHubCopilotChat/0.35.0" }),
      // pi-ai's pi-messages wire sends only the request's headers, not the model's.
      provider("messages", "pi-messages", { "x-gateway-key": "gk" }),
      provider("keyed", "openai-completions", { "x-gateway-key": "gk" }),
    ];
    const { plugins } = setup({ providers: () => [] });
    try {
      await runWith(
        plugins,
        Effect.forEach(providers, ({ id }) => collect(new LlmRequest({ model: `${id}/m`, messages: [user("hi")] }))),
        { llm: { providers } },
      );
    } finally {
      server.close();
    }

    const lemma = `lemma (${platform()} ${release()}; ${arch()})`;
    expect(agents).toMatchObject({
      "/completions/chat/completions": lemma,
      "/responses/responses": lemma,
      "/anthropic/v1/messages": lemma,
      "/copilot/chat/completions": "GitHubCopilotChat/0.35.0",
      "/keyed/chat/completions": lemma,
    });
    expect(Object.entries(agents).find(([path]) => path.startsWith("/messages/"))?.[1]).toBe(lemma);
    expect(gateway).toMatchObject({ messages: "gk", keyed: "gk" });
  });
});
