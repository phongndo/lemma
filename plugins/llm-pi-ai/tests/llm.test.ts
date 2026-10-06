import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { arch, platform, release, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Context, Effect, Fiber, Layer, Schema, Stream } from "effect";
import { createProvider, fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { Provider, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { Events, PluginContext, definePlugin } from "@lemma/core";
import { InteractionError, InteractionOrigin, Llm, LlmError, LlmRequest, LlmRequestHook, ModelsChanged, StreamEvent } from "@lemma/contracts";
import type { Credential } from "@lemma/contracts";
import { deviceId } from "../src/device.ts";
import { credentialStore, makeEventMapper, makeLlmPlugin, runner } from "../src/index.ts";
import { envContext, fakeCredentials, fakeHost, fakeInteraction, noticeRecorder, offline, runWith } from "./helpers.ts";

const decodeEvent = Schema.decodeUnknownSync(StreamEvent, { onExcessProperty: "error" });

const user = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }], timestamp: 1 });

function setup(options: { providers?: () => readonly Provider[]; env?: Record<string, string> } = {}) {
  const faux = fauxProvider({
    provider: "faux",
    models: [
      { id: "plain", reasoning: false },
      { id: "thinker", reasoning: true },
    ],
  });
  const credentials = fakeCredentials();
  const interaction = fakeInteraction(() => Effect.succeed("sk-test"));
  const llm = makeLlmPlugin({ fetch: offline, providers: options.providers ?? (() => [faux.provider]), authContext: envContext(options.env) });
  return { faux, credentials, interaction, plugins: [credentials.plugin, interaction.plugin, llm] as const };
}

const collect = (request: LlmRequest) => Effect.flatMap(Llm, (llm) => Stream.runCollect(llm.stream(request)));

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
    const { plugins } = setup({ providers: () => [faux.provider] });
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

    expect(events).toHaveLength(2);
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

  it("ends a response that sends nothing for streamTimeout as a transient failure, and aborts the request", async () => {
    const { faux, plugins } = setup();
    let aborted = false;
    faux.setResponses([
      (_, options) =>
        new Promise((_, reject) =>
          options?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          }),
        ),
    ]);
    const events = await runWith(plugins, collect(new LlmRequest({ model: "faux/plain", messages: [user("hi")] })), { llm: { streamTimeout: 0.1 } });
    events.forEach((event) => decodeEvent(event));
    const last = events.at(-1)!;
    expect(last).toMatchObject({ type: "error", failure: { kind: "transient" }, message: { stopReason: "error" } });
    expect(last.type === "error" ? last.message.errorMessage : "").toContain("stalled");
    expect(events.filter((e) => e.type === "done" || e.type === "error")).toHaveLength(1);
    expect(aborted).toBe(true);
  });

  it("asks providers to keep the prompt cache as long as configured", async () => {
    const { faux, plugins } = setup();
    const seen: (SimpleStreamOptions | undefined)[] = [];
    faux.setResponses([
      (_, options) => {
        seen.push(options);
        return fauxAssistantMessage("ok");
      },
    ]);
    await runWith(plugins, collect(new LlmRequest({ model: "faux/plain", messages: [user("hi")] })), { llm: { cacheRetention: "long" } });
    expect(seen[0]?.cacheRetention).toBe("long");
  });

  it("has pi-ai ask a failing provider again itself, before a response starts, waiting the delay it names", async () => {
    const { faux, plugins } = setup();
    const seen: (SimpleStreamOptions | undefined)[] = [];
    faux.setResponses([
      (_, options) => {
        seen.push(options);
        return fauxAssistantMessage("ok");
      },
    ]);
    await runWith(plugins, collect(new LlmRequest({ model: "faux/plain", messages: [user("hi")] })));
    // pi-ai makes none unless asked, and reads no Retry-After without them.
    expect(seen[0]?.maxRetries).toBeGreaterThan(0);
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
});

describe("event mapper", () => {
  const model = fauxProvider().getModel();
  const provider = { id: "faux", name: "Faux" };

  it("synthesizes start and a terminal when pi-ai omits them", () => {
    const mapper = makeEventMapper(model, provider);
    expect(mapper.end().map((e) => e.type)).toEqual(["start", "error"]);
    expect(mapper.end()).toEqual([]);
  });

  it("classifies a failure, so a caller knows whether asking again can help", () => {
    const failure = (errorMessage: string, reason: "error" | "aborted" = "error") => {
      const mapper = makeEventMapper(model, provider);
      const last = mapper.push({ type: "error", reason, error: fauxAssistantMessage([], { stopReason: reason, errorMessage }) }).at(-1);
      return last?.type === "error" ? last.failure : "no error event";
    };
    expect(failure('529 {"type":"error","error":{"type":"overloaded_error"}}')).toEqual({ kind: "transient" });
    expect(failure("fetch failed")).toEqual({ kind: "transient" });
    expect(failure("429 Too Many Requests")).toEqual({ kind: "rate-limit" });
    expect(failure("Server requested 120s retry delay (max: 60s). Rate limit reached")).toEqual({ kind: "rate-limit", retryAfterMs: 120_000 });
    expect(failure("prompt is too long: 210000 tokens > 200000 maximum")).toEqual({ kind: "overflow" });
    expect(failure("401 Invalid API key")).toEqual({ kind: "fatal" });
    expect(failure("429 insufficient_quota: You exceeded your current quota")).toEqual({ kind: "fatal" });
    expect(failure("Request was aborted", "aborted")).toBeUndefined();
    // A status pi-ai would find in the text, but the request's own fault, and one that can never pass.
    expect(failure("400 invalid_request_error: request body of 5500123 bytes is too large")).toEqual({ kind: "fatal" });
    expect(failure("429 Request too large for gpt-4o on tokens per min (TPM): Limit 30000, Requested 45000")).toEqual({ kind: "fatal" });
    // A connection that failed, which pi-ai does not recognize.
    expect(failure("read ECONNRESET")).toEqual({ kind: "transient" });
    expect(failure("connect ETIMEDOUT 10.0.0.1:443")).toEqual({ kind: "transient" });
  });

  it("fails a response cut off at its limit having said nothing, its input filling the context window, as an overflow", () => {
    const usage = (input: number, output: number) => ({ ...fauxAssistantMessage([]).usage, input, output });
    const settle = (message: ReturnType<typeof fauxAssistantMessage>) =>
      makeEventMapper(model, provider).push({ type: "done", reason: "length", message }).at(-1);
    const silent = { ...fauxAssistantMessage([], { stopReason: "length" }), usage: usage(model.contextWindow, 0) };
    expect(settle(silent)).toMatchObject({ type: "error", message: { stopReason: "error" }, failure: { kind: "overflow" } });
    // An answer cut off at its output limit is still an answer.
    const cut = { ...fauxAssistantMessage("half an answer", { stopReason: "length" }), usage: usage(1000, 4096) };
    expect(settle(cut)).toMatchObject({ type: "done", message: { stopReason: "length" } });
  });

  it("maps a pending stop reason to an error", () => {
    const mapper = makeEventMapper(model, provider);
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

  it("keeps Anthropic API keys but not its subscription OAuth", async () => {
    // Default built-ins: the plugin's real provider list.
    const llm = makeLlmPlugin({ fetch: offline, authContext: envContext({ ANTHROPIC_API_KEY: "sk-ant" }) });
    const plugins = [fakeCredentials().plugin, fakeInteraction(() => Effect.succeed("")).plugin, llm];
    const providers = await runWith(
      plugins,
      Effect.flatMap(Llm, (l) => l.providers),
    );
    const anthropic = providers.find((p) => p.id === "anthropic")!;
    expect(anthropic.auth.map((a) => a.type)).toEqual(["api_key"]);
    expect(anthropic).toMatchObject({ configured: true, source: "ANTHROPIC_API_KEY" });
    // OpenAI signs in with ChatGPT itself; the legacy Codex provider is left out unless `exclude` says otherwise.
    expect(providers.find((p) => p.id === "openai")?.auth.map((a) => a.type)).toEqual(["api_key", "oauth"]);
    expect(providers.some((p) => p.id === "openai-codex")).toBe(false);
    expect(providers.find((p) => p.id === "github-copilot")?.auth.map((a) => a.type)).toContain("oauth");
  });

  it("filters built-ins with include and exclude", async () => {
    const { plugins } = setup({ providers: () => [anthropicProvider(), fauxProvider({ provider: "faux" }).provider] });
    const ids = await runWith(
      plugins,
      Effect.map(
        Effect.flatMap(Llm, (l) => l.providers),
        (ps) => ps.map((p) => p.id),
      ),
      {
        llm: { include: ["anthropic", "faux"], exclude: ["faux"] },
      },
    );
    expect(ids).toEqual(["anthropic"]);
  });
});

describe("model catalogs", () => {
  it("tells clients when a refresh changed the models, and not when it did not", async () => {
    // A provider whose list grows on every refresh after the first (at startup).
    let refreshes = 0;
    const models = [{ id: "a" }];
    const growing = createProvider({
      id: "grow",
      name: "Grow",
      auth: {},
      models: [],
      api: openAICompletionsApi(),
    });
    const provider: Provider = {
      ...growing,
      getModels: () => models.map((entry) => ({ ...fauxProvider({ provider: "grow" }).provider.getModels()[0]!, ...entry, provider: "grow" })),
      refreshModels: async (context) => {
        if (refreshes++ === 0) return;
        await context.publish({ update: () => models.push({ id: `m${refreshes}` }) });
      },
    };
    const { plugins } = setup({ providers: () => [provider] });
    const changes = await runWith(
      plugins,
      Effect.gen(function* () {
        const events = yield* Events;
        const llm = yield* Llm;
        yield* Effect.sleep("50 millis");
        const heard = yield* Effect.forkChild(Stream.runCollect(Stream.take(events.stream(ModelsChanged), 1)));
        yield* Effect.yieldNow;
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
    const plugins = [credentials.plugin, interaction.plugin, makeLlmPlugin({ fetch: offline, providers: () => [], authContext: envContext() })];
    const cancelled = await runWith(plugins, Effect.flip(Effect.flatMap(Llm, (l) => l.login("gateway", "api_key"))), { llm: gateway });
    expect(cancelled.reason).toBe("Cancelled");
    const unknown = await runWith(plugins, Effect.flip(Effect.flatMap(Llm, (l) => l.login("nope", "api_key"))), { llm: gateway });
    expect(unknown.reason).toBe("UnknownProvider");
    const unsupported = await runWith(plugins, Effect.flip(Effect.flatMap(Llm, (l) => l.login("gateway", "oauth"))), { llm: gateway });
    expect(unsupported.reason).toBe("LoginFailed");
  });

  it("publishes auth events as notices under the login's origin and withdraws prompts the flow abandons", async () => {
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
    const devices: (string | undefined)[] = [];
    const host = fakeHost();
    const oauthProvider = createProvider({
      id: "sso",
      name: "SSO",
      auth: {
        oauth: {
          name: "SSO account",
          login: async (flow, options) => {
            devices.push(options?.getDeviceId?.(), options?.getDeviceId?.());
            flow.notify({ type: "auth_url", url: "https://sso.test/authorize" });
            flow.notify({ type: "device_code", userCode: "ABCD-1234", verificationUri: "https://sso.test/device" });
            flow.notify({ type: "progress", message: "Waiting for the browser" });
            // Races a paste prompt against a callback that arrives first.
            const callback = new AbortController();
            const pasted = flow.prompt({ type: "manual_code", message: "Paste the code", signal: callback.signal });
            setTimeout(() => callback.abort(), 10);
            await pasted.catch(() => undefined);
            return { type: "oauth", access: "token", refresh: "refresh", expires: Date.now() + 3_600_000, accountId: "acct" };
          },
          refresh: async (credential) => credential,
          toAuth: async (credential) => ({ apiKey: credential.access }),
        },
      },
      models: [],
      api: openAICompletionsApi(),
    });
    const plugins = [
      credentials.plugin,
      interaction.plugin,
      recorder.plugin,
      host.plugin,
      makeLlmPlugin({ fetch: offline, providers: () => [oauthProvider], authContext: envContext() }),
    ];
    const info = await runWith(
      plugins,
      Effect.gen(function* () {
        const llm = yield* Llm;
        yield* Effect.provideService(llm.login("sso", "oauth"), InteractionOrigin, "login:sso");
        yield* Effect.sleep("20 millis");
        return yield* llm.providers;
      }),
    );

    expect(withdrawn).toBe(true);
    // pi-ai prompts from outside the login's fiber; its question still names the login, and says it is the paste fallback.
    expect(interaction.origins).toEqual(["login:sso"]);
    expect(interaction.asked).toEqual([{ type: "ask", title: "Paste the code", kind: "sign-in-code" }]);
    // The installation's one device ID (OpenAI's ChatGPT sign-in requires it), kept in the host's home.
    expect(devices[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(devices[1]).toBe(devices[0]);
    expect(readFileSync(join(host.home, "device-id"), "utf8").trim()).toBe(devices[0]);
    expect(credentials.store.get("sso")).toMatchObject({ type: "oauth", access: "token", accountId: "acct" });
    expect(info[0]).toMatchObject({ auth: [{ type: "oauth", name: "SSO account", interactive: true }], configured: true, source: "OAuth" });
    expect(recorder.notices).toEqual([
      {
        level: "info",
        source: "llm",
        message: "Open the link to sign in to SSO.",
        links: [{ url: "https://sso.test/authorize", label: "Sign in to SSO" }],
        origin: "login:sso",
        kind: "sign-in",
      },
      {
        level: "info",
        source: "llm",
        message: "Enter code ABCD-1234 at https://sso.test/device to sign in to SSO.",
        code: "ABCD-1234",
        links: [{ url: "https://sso.test/device", label: "Enter code" }],
        origin: "login:sso",
        kind: "device-code",
      },
      { level: "info", source: "llm", message: "Waiting for the browser", origin: "login:sso", kind: "progress" },
      // Success is announced to every client after the flow's own notices.
      { level: "info", source: "llm", message: "Logged in to SSO", origin: "login:sso", kind: "signed-in" },
    ]);
  });
});

describe("login's end", () => {
  const ssoProvider = (login: () => Promise<Credential>) =>
    createProvider({
      id: "sso",
      name: "SSO",
      auth: {
        oauth: {
          name: "SSO account",
          login: async () => (await login()) as never,
          refresh: async (credential) => credential,
          toAuth: async (credential) => ({ apiKey: credential.access }),
        },
      },
      models: [],
      api: openAICompletionsApi(),
    });

  it("announces a failed or cancelled login as ended, under its origin", async () => {
    const credentials = fakeCredentials();
    const recorder = noticeRecorder();
    const plugins = [
      credentials.plugin,
      fakeInteraction(() => Effect.succeed("unused")).plugin,
      recorder.plugin,
      fakeHost().plugin,
      makeLlmPlugin({ fetch: offline, providers: () => [ssoProvider(() => Promise.reject(new Error("denied")))], authContext: envContext() }),
    ];
    const failure = await runWith(
      plugins,
      Effect.flip(Effect.flatMap(Llm, (llm) => Effect.provideService(llm.login("sso", "oauth"), InteractionOrigin, "login:sso"))),
    );
    expect(failure.reason).toBe("LoginFailed");
    expect(recorder.notices).toEqual([{ level: "info", source: "llm", kind: "ended", message: "SSO login failed", origin: "login:sso" }]);
  });

  it("returns once the credential is stored, without waiting on the catalog refresh a cancel could interrupt", async () => {
    const credentials = fakeCredentials();
    // models.dev never answers: the refresh after the login waits on it.
    const hanging = (() => new Promise<Response>(() => {})) as typeof fetch;
    const plugins = [
      credentials.plugin,
      fakeInteraction(() => Effect.succeed("unused")).plugin,
      fakeHost().plugin,
      makeLlmPlugin({
        fetch: hanging,
        providers: () => [ssoProvider(async () => ({ type: "oauth", access: "token", refresh: "r", expires: Date.now() + 3_600_000 }))],
        authContext: envContext(),
      }),
    ];
    await runWith(
      plugins,
      Effect.flatMap(Llm, (llm) => llm.login("sso", "oauth").pipe(Effect.timeout("2 seconds"))),
    );
    expect(credentials.store.get("sso")).toMatchObject({ type: "oauth", access: "token" });
  });
});

describe("credential store adapter", () => {
  it("round-trips through the Credentials capability", async () => {
    const { service, store } = fakeCredentials();
    const adapter = credentialStore(service, runner(Context.empty()));
    const oauth: Credential = { type: "oauth", access: "a", refresh: "r", expires: 1, extra: "kept" };

    expect(await adapter.modify("x", async (current) => (current === undefined ? { ...oauth } : undefined) as never)).toEqual(oauth);
    expect(await adapter.modify("x", async () => undefined)).toEqual(oauth);
    expect(await adapter.read("x")).toEqual(oauth);
    expect(await adapter.list()).toEqual([{ providerId: "x", type: "oauth" }]);
    const failure = new Error("refresh failed");
    await expect(
      adapter.modify("x", async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(store.get("x")).toEqual(oauth);
    await adapter.delete("x");
    expect(await adapter.read("x")).toBeUndefined();
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
  it("names Lemma, not pi, on every wire API, unless a model sends its own User-Agent", async () => {
    const agents: Record<string, string | undefined> = {};
    const server = createServer((request, response) => {
      agents[new URL(request.url ?? "", "http://x").pathname] = request.headers["user-agent"];
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
    expect(agents).toEqual({
      "/completions/chat/completions": lemma,
      "/responses/responses": lemma,
      "/anthropic/v1/messages": lemma,
      "/copilot/chat/completions": "GitHubCopilotChat/0.35.0",
    });
  });
});
