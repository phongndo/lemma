import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { arch, platform, release, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Context, Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect";
import { Events, PluginContext, definePlugin, makeCore } from "@lemma/core";
import { InteractionError, InteractionOrigin } from "@lemma/contracts";
import { Llm, LlmError, LlmProviderHeadersHook, LlmProviderResponse, LlmRequest, LlmRequestHook, ModelsChanged, Providers, StreamEvent } from "@lemma/llm";
import { llmConformance } from "@lemma/testing";
import { deviceId } from "../src/device.ts";
import { makeLlmPlugin } from "../src/index.ts";
import type { OAuthMethod } from "../src/index.ts";
import {
  catalogModel,
  chunk,
  completion,
  faux,
  fakeCredentials,
  fakeHost,
  fakeInteraction,
  noticeRecorder,
  offline,
  runWith,
  scriptedFetch,
  setup,
  sseBody,
  sseResponse,
} from "./helpers.ts";

const decodeEvent = Schema.decodeUnknownSync(StreamEvent, { onExcessProperty: "error" });

const user = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }], timestamp: 1 });

const collect = (request: LlmRequest) => Effect.flatMap(Llm, (llm) => Stream.runCollect(llm.stream(request)));

/** A body that sends `first`, then nothing until its request is aborted. */
const hanging = (first: string, signal: AbortSignal | undefined) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(first));
      signal?.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")));
    },
  });

llmConformance("http", (scenario) => {
  let signal: AbortSignal | undefined;
  const { fetch } = scriptedFetch((sent) => {
    signal = sent.signal;
    if (scenario === "reply") return sseResponse(completion("Hello there", [{ id: "call-1", name: "echo", arguments: { text: "x" } }]));
    if (scenario === "failure") return sseResponse(sseBody([chunk({ content: "partial" }), { error: { message: "Invalid request" } }]));
    return new Response(hanging(sseBody([chunk({ content: "a long " }), chunk({ content: "answer " })]), sent.signal), {
      headers: { "content-type": "text/event-stream" },
    });
  });
  const { plugins } = setup({ fetch });
  return { plugins: [...plugins, fakeHost().plugin], model: "faux/plain", aborted: () => signal?.aborted ?? false };
});

describe("stream", () => {
  it("maps text and tool calls to schema-conformant events, sending the request as Chat Completions does", async () => {
    const { fetch, sent } = scriptedFetch(() => sseResponse(completion("Hello there", [{ id: "call-1", name: "echo", arguments: { text: "x" } }])));
    const { plugins } = setup({ fetch });
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
    expect(events.filter((e) => e.type === "done" || e.type === "error")).toHaveLength(1);
    expect(last).toMatchObject({
      type: "done",
      message: {
        role: "assistant",
        provider: "faux",
        model: "plain",
        api: "openai-completions",
        stopReason: "toolUse",
        usage: { input: 10, output: 5, totalTokens: 15 },
      },
    });
    expect(sent[0]).toMatchObject({ url: "https://faux.test/v1/chat/completions" });
    expect(sent[0]!.headers.get("authorization")).toBe("Bearer sk-faux");
    expect(sent[0]!.body).toMatchObject({
      model: "plain",
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: "system", content: "Be brief" },
        { role: "user", content: "hi" },
      ],
      tools: [{ type: "function", function: { name: "echo", description: "Echo" } }],
    });
  });

  it("streams thinking, asking at the level wanted, clamped to the model's, and sends off as the model names it", async () => {
    const { fetch, sent } = scriptedFetch(() =>
      sseResponse(sseBody([chunk({ reasoning_content: "Let me think" }), chunk({ content: "42" }), chunk({}, "stop"), "[DONE]"])),
    );
    const { plugins } = setup({ fetch });
    const events = await runWith(plugins, collect(new LlmRequest({ model: "faux/thinker", messages: [user("q")], thinking: "max", sessionId: "s1" })));
    await runWith(plugins, collect(new LlmRequest({ model: "faux/thinker", messages: [user("q")], thinking: "off" })));
    await runWith(plugins, collect(new LlmRequest({ model: "faux/thinker", messages: [user("q")], thinking: "minimal" })));

    expect(
      events
        .filter((e) => e.type === "thinking-delta")
        .map((e) => e.delta)
        .join(""),
    ).toBe("Let me think");
    expect(events.at(-1)).toMatchObject({
      message: {
        content: [
          { type: "thinking", thinking: "Let me think", thinkingSignature: "reasoning_content" },
          { type: "text", text: "42" },
        ],
      },
    });
    expect(sent.map((request) => request.body.reasoning_effort)).toEqual(["high", "none", "low"]);
  });

  it("aborts the provider request when the consumer stops", async () => {
    let signal: AbortSignal | undefined;
    const { fetch } = scriptedFetch((sent) => {
      signal = sent.signal;
      return new Response(hanging(sseBody([chunk({ content: "a " }), chunk({ content: "b " })]), sent.signal));
    });
    const { plugins } = setup({ fetch });
    const events = await runWith(
      plugins,
      Effect.flatMap(Llm, (llm) => Stream.runCollect(llm.stream(new LlmRequest({ model: "faux/plain", messages: [user("go")] })).pipe(Stream.take(2)))),
    );
    expect(events).toHaveLength(2);
    expect(signal?.aborted).toBe(true);
  });

  it("ends a response that sends nothing for streamTimeout as a transient failure, and aborts the request", async () => {
    let signal: AbortSignal | undefined;
    const { fetch } = scriptedFetch(
      (sent) =>
        new Promise<Response>((_, reject) => {
          signal = sent.signal;
          sent.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        }),
    );
    const { plugins } = setup({ fetch });
    const events = await runWith(plugins, collect(new LlmRequest({ model: "faux/plain", messages: [user("hi")] })), { "llm.http": { streamTimeout: 0.1 } });
    events.forEach((event) => decodeEvent(event));
    const last = events.at(-1)!;
    expect(last).toMatchObject({ type: "error", failure: { kind: "transient" }, message: { stopReason: "error" } });
    expect(last.type === "error" ? last.message.errorMessage : "").toContain("stalled");
    expect(events.filter((e) => e.type === "done" || e.type === "error")).toHaveLength(1);
    expect(signal?.aborted).toBe(true);
  });

  it("counts whatever the provider sends as the connection alive, its keep-alives as much as model output", async () => {
    // Keep-alives for longer than the stream timeout, then the answer.
    const pinging = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          let pings = 0;
          const tick = () => {
            if (pings++ < 5) {
              controller.enqueue(encoder.encode(": keep-alive\n\n"));
              setTimeout(tick, 40);
            } else {
              controller.enqueue(encoder.encode(completion("late but alive")));
              controller.close();
            }
          };
          tick();
        },
      });
    const { fetch } = scriptedFetch(() => new Response(pinging(), { headers: { "content-type": "text/event-stream" } }));
    const { plugins } = setup({ fetch });
    const events = await runWith(plugins, collect(new LlmRequest({ model: "faux/plain", messages: [user("hi")] })), { "llm.http": { streamTimeout: 0.1 } });
    expect(events.at(-1)).toMatchObject({ type: "done", message: { content: [{ type: "text", text: "late but alive" }] } });
  });

  it("asks a failing provider again itself, before a response starts, waiting the delay it names", async () => {
    let calls = 0;
    const { fetch } = scriptedFetch(() =>
      ++calls === 1 ? new Response('{"error":{"message":"busy"}}', { status: 503, headers: { "retry-after-ms": "1" } }) : sseResponse(completion("ok")),
    );
    const { plugins } = setup({ fetch });
    const events = await runWith(plugins, collect(new LlmRequest({ model: "faux/plain", messages: [user("hi")] })));
    expect(events.at(-1)).toMatchObject({ type: "done" });
    expect(calls).toBe(2);
  });

  it("leaves a longer wait than a minute to the caller, telling it how long", async () => {
    let calls = 0;
    const { fetch } = scriptedFetch(() => {
      calls++;
      return new Response('{"error":{"message":"Rate limit reached","type":"rate_limit_error"}}', { status: 429, headers: { "retry-after": "120" } });
    });
    const { plugins } = setup({ fetch });
    const events = await runWith(plugins, collect(new LlmRequest({ model: "faux/plain", messages: [user("hi")] })));
    expect(events.map((event) => event.type)).toEqual(["start", "error"]);
    expect(events.at(-1)).toMatchObject({
      failure: { kind: "rate-limit", retryAfterMs: 120_000 },
      message: { errorMessage: "429 rate_limit_error: Rate limit reached" },
    });
    expect(calls).toBe(1);
  });

  it("fails with UnknownModel before starting", async () => {
    const { plugins } = setup();
    const error = await runWith(plugins, Effect.flip(collect(new LlmRequest({ model: "faux/missing", messages: [] }))));
    expect(error).toBeInstanceOf(LlmError);
    expect(error.reason).toBe("UnknownModel");
    const byRef = await runWith(plugins, Effect.flip(Effect.flatMap(Llm, (llm) => llm.model("nonsense"))));
    expect(byRef.reason).toBe("UnknownModel");
  });

  it("runs LlmRequestHook around the provider, which is asked the request as its caller made it", async () => {
    let wrapped = 0;
    const timer = definePlugin({
      id: "timer",
      layer: Layer.effectDiscard(
        Effect.flatMap(PluginContext, (context) =>
          context.on(LlmRequestHook, (request, next) =>
            Effect.map(
              next(request),
              Stream.tap(() => Effect.sync(() => wrapped++)),
            ),
          ),
        ),
      ),
    });
    const { fetch, sent } = scriptedFetch(() => sseResponse(completion("answered")));
    const { plugins } = setup({ fetch });
    const events = await runWith([...plugins, timer], collect(new LlmRequest({ model: "faux/plain", messages: [user("hi")] })));
    expect(events.at(-1)).toMatchObject({ type: "done", message: { content: [{ type: "text", text: "answered" }] } });
    expect(wrapped).toBe(events.length);
    expect(sent.map((request) => request.body.messages)).toEqual([[{ role: "user", content: "hi" }]]);
  });

  it("refuses a request a handler of LlmRequestHook changed, naming it, and sends nothing", async () => {
    const router = definePlugin({
      id: "router",
      layer: Layer.effectDiscard(
        Effect.flatMap(PluginContext, (context) => context.on(LlmRequestHook, (request, next) => next(new LlmRequest({ ...request, model: "faux/thinker" })))),
      ),
    });
    // Handing on an equal request is not a change.
    const copier = definePlugin({
      id: "copier",
      layer: Layer.effectDiscard(Effect.flatMap(PluginContext, (context) => context.on(LlmRequestHook, (request, next) => next(new LlmRequest(request))))),
    });
    const { fetch, sent } = scriptedFetch(() => sseResponse(completion("routed")));
    const { plugins } = setup({ fetch });
    const error = await runWith([...plugins, copier, router], Effect.flip(collect(new LlmRequest({ model: "faux/plain", messages: [user("hi")] }))));
    expect(error).toMatchObject({ reason: "Hook" });
    expect(error.message).toContain("router changed the request");
    expect(sent).toHaveLength(0);
    const events = await runWith([...plugins, copier], collect(new LlmRequest({ model: "faux/plain", messages: [user("hi")] })));
    expect(events.at(-1)).toMatchObject({ type: "done" });
    expect(sent).toHaveLength(1);
  });

  it("tells the user to log in when a provider has no key, asking it nothing", async () => {
    const { fetch, sent } = scriptedFetch(() => sseResponse(completion("unreachable")));
    const { plugins } = setup({ fetch, env: {} });
    const events = await runWith(plugins, collect(new LlmRequest({ model: "faux/plain", messages: [user("hi")] })));
    events.forEach((event) => decodeEvent(event));
    expect(events.map((e) => e.type)).toEqual(["start", "error"]);
    expect(events[1]).toMatchObject({ failure: { kind: "fatal" }, message: { errorMessage: expect.stringContaining("/login faux") } });
    expect(sent).toHaveLength(0);
  });

  it("leaves out thinking made under another prefix for a model that binds it, and keeps it for one that does not", async () => {
    const thought = (text: string) => ({
      role: "assistant" as const,
      content: [
        { type: "thinking" as const, thinking: `why ${text}`, thinkingSignature: `sig-${text}` },
        { type: "text" as const, text },
      ],
      api: "anthropic-messages",
      provider: "faux",
      model: "adaptive",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop" as const,
      timestamp: 1,
    });
    const anthropicAnswer = sseBody([
      { event: "message_start", data: { type: "message_start", message: { id: "m1", usage: { input_tokens: 3, output_tokens: 0 } } } },
      { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } } },
      { event: "message_stop", data: { type: "message_stop" } },
    ]);
    const { fetch, sent } = scriptedFetch(() => sseResponse(anthropicAnswer));
    const provider = faux({
      models: [
        catalogModel("adaptive", { api: "anthropic-messages", reasoning: true, thinking: { kind: "effort", levels: ["low", "high", "max"] } }),
        catalogModel("budget", { api: "anthropic-messages", reasoning: true, thinking: { kind: "budget", levels: ["off", "low", "high"] } }),
      ],
    });
    const { plugins } = setup({ fetch, providers: [provider] });
    const ask = (model: string) =>
      collect(new LlmRequest({ model, messages: [user("one"), thought("a"), user("two"), thought("b"), user("three")], thinkingFrom: 3, thinking: "high" }));
    await runWith(plugins, Effect.all([ask("faux/adaptive"), ask("faux/budget")]));
    const kinds = (body: Record<string, unknown>) =>
      (body.messages as { role: string; content: { type: string }[] }[]).map((message) => message.content.map((block) => block.type).join(","));
    // `adaptive` made them: its own thinking goes back where it was made under this prefix.
    expect(kinds(sent[0]!.body)).toEqual(["text", "text", "text", "thinking,text", "text"]);
    expect(sent[0]!.body).toMatchObject({ thinking: { type: "adaptive" }, output_config: { effort: "high" } });
    // To another model, thinking is text, wherever it was made.
    expect(kinds(sent[1]!.body)).toEqual(["text", "text,text", "text", "text,text", "text"]);
    expect(sent[1]!.body).toMatchObject({ thinking: { type: "enabled", budget_tokens: 6976 } });
  });
});

describe("providers", () => {
  it("lists configured OpenAI-compatible providers, keyless ones as available", async () => {
    const { plugins } = setup({ providers: [] });
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
      { "llm.http": config },
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
      thinkingLevels: ["off", "minimal", "low", "medium", "high"],
    });
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

  it("serves its built-ins from the committed catalog: Anthropic keyed, OpenAI keyed or signed in with ChatGPT", async () => {
    const llm = makeLlmPlugin({ fetch: offline, env: { ANTHROPIC_API_KEY: "sk-ant" } });
    const plugins = [fakeCredentials().plugin, fakeInteraction(() => Effect.succeed("")).plugin, llm];
    const result = await runWith(
      plugins,
      Effect.flatMap(Llm, (l) => Effect.all({ providers: l.providers, available: l.models({ available: true }), go: l.models() })),
    );
    expect(result.providers.map((p) => p.id)).toEqual(["anthropic", "openai", "openrouter", "opencode", "opencode-go"]);
    const anthropic = result.providers.find((p) => p.id === "anthropic")!;
    expect(anthropic).toMatchObject({ auth: [{ type: "api_key", name: "Anthropic API key" }], configured: true, source: "ANTHROPIC_API_KEY" });
    expect(result.providers.find((p) => p.id === "openai")?.auth).toEqual([
      { type: "api_key", name: "OpenAI API key", interactive: true },
      { type: "oauth", name: "Sign in with ChatGPT", interactive: true },
    ]);
    expect(new Set(result.available.map((m) => m.provider))).toEqual(new Set(["anthropic"]));
    expect(result.go.filter((m) => m.provider === "opencode-go").length).toBeGreaterThan(10);
  });

  it("leaves out a configured provider on a protocol it does not speak, serving the rest", async () => {
    const { plugins } = setup({ providers: [] });
    const ids = await runWith(
      plugins,
      Effect.map(
        Effect.flatMap(Llm, (l) => l.providers),
        (ps) => ps.map((p) => p.id),
      ),
      {
        "llm.http": {
          providers: [
            { id: "gemini", api: "google-generative-ai", baseUrl: "https://example.test", models: [{ id: "g" }] },
            { id: "local", api: "openai-completions", baseUrl: "http://localhost:1/v1", models: [{ id: "m" }] },
          ],
        },
      },
    );
    expect(ids).toEqual(["local"]);
  });

  it("asks a model of the user's that the catalog knows as the catalog says: a proxy's Claude Sonnet 5.5 thinks adaptively", async () => {
    const { plugins } = setup({ providers: [] });
    const config = {
      providers: [
        {
          id: "proxy",
          api: "anthropic-messages",
          baseUrl: "http://localhost:1",
          models: [
            { id: "claude-sonnet-5-5", reasoning: true },
            { id: "house-model", reasoning: true },
            { id: "house-adaptive", reasoning: true, compat: { forceAdaptiveThinking: true }, thinkingLevelMap: { xhigh: "xhigh" } },
            // A map adjusts the catalog's levels; it does not undo how the model is asked.
            { id: "claude-opus-5-5", reasoning: true, thinkingLevelMap: { max: null } },
            // The config's word that it thinks adaptively wins over the catalog's budget.
            { id: "claude-sonnet-4-5", reasoning: true, compat: { forceAdaptiveThinking: true } },
          ],
        },
      ],
    };
    const models = await runWith(
      plugins,
      Effect.flatMap(Llm, (llm) => llm.models()),
      { "llm.http": config },
    );
    // No `off`: Claude Sonnet 5.5 refuses thinking turned off, so off asks for its lowest effort.
    expect(models.map((model) => [model.id, model.thinkingLevels])).toEqual([
      ["claude-sonnet-5-5", ["low", "medium", "high", "xhigh", "max"]],
      ["house-model", ["off", "minimal", "low", "medium", "high"]],
      ["house-adaptive", ["low", "medium", "high", "xhigh"]],
      ["claude-opus-5-5", ["low", "medium", "high", "xhigh"]],
      ["claude-sonnet-4-5", ["low", "medium", "high"]],
    ]);
  });

  it("asks off at the effort a config maps it to: a proxy's Claude Sonnet 5.5, which refuses thinking turned off", async () => {
    const { fetch, sent } = scriptedFetch(() => new Response("no", { status: 400 }));
    const { plugins } = setup({ providers: [], fetch });
    await runWith(plugins, collect(new LlmRequest({ model: "proxy/claude-sonnet-5-5", messages: [user("hi")] })), {
      "llm.http": {
        providers: [
          {
            id: "proxy",
            api: "anthropic-messages",
            baseUrl: "http://localhost:1",
            models: [{ id: "claude-sonnet-5-5", reasoning: true, thinkingLevelMap: { off: "low" } }],
          },
        ],
      },
    });
    expect(sent[0]!.body).toMatchObject({ thinking: { type: "adaptive" }, output_config: { effort: "low" } });
  });

  it("asks a model the catalog has toggling behind OpenRouter by an effort on a server with no switch", async () => {
    const { fetch, sent } = scriptedFetch(() => new Response("no", { status: 400 }));
    const { plugins } = setup({ providers: [], fetch });
    const ask = (model: string) => collect(new LlmRequest({ model, messages: [user("hi")], thinking: "high" }));
    const gateway = (id: string, compat?: Record<string, unknown>) => ({
      id,
      api: "openai-completions",
      baseUrl: "https://gateway.test/v1",
      ...(compat === undefined ? {} : { compat }),
      models: [{ id: "openai/o3", reasoning: true }],
    });
    await runWith(plugins, Effect.all([ask("gateway/openai/o3"), ask("router/openai/o3")]), {
      "llm.http": { providers: [gateway("gateway"), gateway("router", { thinkingFormat: "openrouter" })] },
    });
    expect(sent[0]!.body).toMatchObject({ reasoning_effort: "high" });
    // A server whose config says it takes OpenRouter's format has the switch.
    expect(sent[1]!.body).toMatchObject({ reasoning: { enabled: true } });
  });

  it("asks a provider whose base URL ends in a slash at its paths, as one without", async () => {
    const { fetch, sent } = scriptedFetch(() => sseResponse(completion("ok")));
    const { plugins } = setup({ providers: [], fetch });
    await runWith(plugins, collect(new LlmRequest({ model: "slash/m", messages: [user("hi")] })), {
      "llm.http": { providers: [{ id: "slash", api: "openai-completions", baseUrl: "http://localhost:1/v1//", models: [{ id: "m" }] }] },
    });
    expect(sent.map((request) => request.url)).toEqual(["http://localhost:1/v1/chat/completions"]);
  });

  it("filters built-ins with include and exclude", async () => {
    const { plugins } = setup({ providers: [faux(), faux({ id: "other", name: "Other" })] });
    const ids = await runWith(
      plugins,
      Effect.map(
        Effect.flatMap(Llm, (l) => l.providers),
        (ps) => ps.map((p) => p.id),
      ),
      { "llm.http": { include: ["faux", "other"], exclude: ["other"] } },
    );
    expect(ids).toEqual(["faux"]);
  });

  it("serves no classifiers or image models: they are other protocols", async () => {
    const { plugins } = setup();
    const result = await runWith(
      plugins,
      Effect.flatMap(Llm, (llm) =>
        Effect.all({
          classifiers: llm.classifiers(),
          images: llm.imageModels({ available: true }),
          classify: Effect.flip(llm.classify("faux/plain", { state: {}, questions: {} })),
          generate: Effect.flip(llm.generateImages("faux/plain", { input: [] })),
        }),
      ),
    );
    expect(result).toMatchObject({ classifiers: [], images: [], classify: { reason: "UnknownModel" }, generate: { reason: "UnknownModel" } });
  });
});

describe("model catalogs", () => {
  /** models.dev's listing of `faux`, as `fetch` answers it; `served` counts the reads. */
  const dev = (models: Record<string, unknown>) => {
    let served = 0;
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input) !== "https://models.dev/api.json") throw new Error("offline in tests");
      served++;
      return Response.json({ faux: { npm: "@ai-sdk/openai-compatible", models } });
    };
    return { fetch: fetchImpl, served: () => served };
  };

  it("lists what models.dev says a built-in serves now, and tells clients the list changed", async () => {
    // Observing from before the llm plugin starts, so the refresh at startup cannot be missed.
    const heard = Deferred.makeUnsafe<void>();
    const listener = definePlugin({
      id: "listener",
      layer: Layer.effectDiscard(Effect.flatMap(PluginContext, (context) => context.observe(ModelsChanged, () => Deferred.succeed(heard, undefined)))),
    });
    const source = dev({
      plain: { name: "Plain", tool_call: true, limit: { context: 50_000, output: 4_000 } },
      fresh: {
        name: "Fresh",
        tool_call: true,
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["none", "low", "high"] }],
        modalities: { input: ["text", "image"] },
      },
      chatty: { name: "No tools", tool_call: false },
      painter: { name: "Paints", tool_call: true, modalities: { output: ["image"] } },
      other: { name: "Elsewhere", tool_call: true, provider: { npm: "@ai-sdk/google" } },
    });
    const { plugins } = setup({ fetch: source.fetch });
    const models = await runWith(
      [listener, ...plugins],
      Effect.gen(function* () {
        const llm = yield* Llm;
        yield* Deferred.await(heard);
        return yield* llm.models();
      }),
    );
    expect(models.map((model) => model.ref)).toEqual(["faux/fresh", "faux/plain"]);
    expect(models[0]).toMatchObject({
      name: "Fresh",
      reasoning: true,
      thinkingLevels: ["off", "low", "high"],
      input: ["text", "image"],
      contextWindow: 128_000,
    });
    expect(models[1]).toMatchObject({ name: "Plain", contextWindow: 50_000, maxTokens: 4_000 });
  });

  it("tells clients when a refresh changed a model's limits, though it serves the same models", async () => {
    const heard = Deferred.makeUnsafe<void>();
    const listener = definePlugin({
      id: "listener",
      layer: Layer.effectDiscard(Effect.flatMap(PluginContext, (context) => context.observe(ModelsChanged, () => Deferred.succeed(heard, undefined)))),
    });
    // The same two models, `plain` with a smaller window than this version's catalog says.
    const source = dev({ plain: { tool_call: true, limit: { context: 50_000, output: 8_000 } }, thinker: { tool_call: true } });
    const { plugins } = setup({ fetch: source.fetch, providers: [faux({ models: [catalogModel("plain"), catalogModel("thinker")] })] });
    const window = await runWith(
      [listener, ...plugins],
      Effect.gen(function* () {
        yield* Deferred.await(heard);
        return (yield* (yield* Llm).model("faux/plain")).contextWindow;
      }),
    );
    expect(window).toBe(50_000);
  });

  it("keeps this version's catalog with liveCatalogs off", async () => {
    const source = dev({ fresh: { tool_call: true } });
    const { plugins } = setup({ fetch: source.fetch });
    const refs = await runWith(
      plugins,
      Effect.map(
        Effect.flatMap(Llm, (llm) => llm.models()),
        (models) => models.map((model) => model.ref),
      ),
      {
        "llm.http": { liveCatalogs: false },
      },
    );
    expect(refs).toEqual(["faux/plain", "faux/thinker"]);
    expect(source.served()).toBe(0);
  });

  it("keeps the user's provider that replaces a built-in its own models after a logout", async () => {
    const { plugins } = setup();
    const refs = await runWith(
      plugins,
      Effect.gen(function* () {
        const llm = yield* Llm;
        yield* llm.logout("faux");
        return (yield* llm.models()).map((model) => model.ref);
      }),
      { "llm.http": { providers: [{ id: "faux", api: "openai-completions", baseUrl: "https://private.test/v1", models: [{ id: "private" }] }] } },
    );
    expect(refs).toEqual(["faux/private"]);
  });

  it("tells clients after a login or logout, though the models stayed the same", async () => {
    const { plugins } = setup();
    const heard = await runWith(
      plugins,
      Effect.gen(function* () {
        const events = yield* Events;
        const llm = yield* Llm;
        const changes = yield* Effect.forkChild(Stream.runCollect(events.stream(ModelsChanged).pipe(Stream.take(2))));
        yield* Effect.yieldNow;
        yield* llm.login("faux", "api_key");
        yield* llm.logout("faux");
        return yield* Fiber.join(changes);
      }),
    );
    expect(heard).toHaveLength(2);
  });
});

describe("login", () => {
  const gateway = {
    providers: [
      { id: "gateway", name: "Gateway", api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1", apiKey: { env: "GATEWAY_KEY" }, models: [{ id: "m" }] },
    ],
  };

  it("asks for an API key through Interaction and stores it", async () => {
    const { plugins, credentials, interaction } = setup({ providers: [] });
    const after = await runWith(
      plugins,
      Effect.gen(function* () {
        const llm = yield* Llm;
        yield* llm.login("gateway", "api_key");
        return yield* llm.providers;
      }),
      { "llm.http": gateway },
    );
    expect(interaction.asked).toEqual([{ type: "ask", title: "Enter the Gateway API key", secret: true }]);
    expect(credentials.store.get("gateway")).toEqual({ type: "api_key", key: "sk-test" });
    expect(after[0]).toMatchObject({ configured: true, source: "stored credential" });

    await runWith(
      plugins,
      Effect.flatMap(Llm, (l) => l.logout("gateway")),
      { "llm.http": gateway },
    );
    expect(credentials.store.has("gateway")).toBe(false);
  });

  it("reports a dismissed prompt as Cancelled and unknown providers as UnknownProvider", async () => {
    const credentials = fakeCredentials();
    const interaction = fakeInteraction(() => Effect.fail(new InteractionError({ reason: "Dismissed", message: "closed" })));
    const plugins = [credentials.plugin, interaction.plugin, makeLlmPlugin({ fetch: offline, providers: () => [], env: {} })];
    const cancelled = await runWith(plugins, Effect.flip(Effect.flatMap(Llm, (l) => l.login("gateway", "api_key"))), { "llm.http": gateway });
    expect(cancelled.reason).toBe("Cancelled");
    const unknown = await runWith(plugins, Effect.flip(Effect.flatMap(Llm, (l) => l.login("nope", "api_key"))), { "llm.http": gateway });
    expect(unknown.reason).toBe("UnknownProvider");
    const unsupported = await runWith(plugins, Effect.flip(Effect.flatMap(Llm, (l) => l.login("gateway", "oauth"))), { "llm.http": gateway });
    expect(unsupported.reason).toBe("LoginFailed");
  });

  it("runs a sign-in's flow under the login's origin, its notices in order, and stores its credential", async () => {
    let withdrawn = false;
    const devices: string[] = [];
    const sso: OAuthMethod = {
      name: "SSO account",
      login: (context) =>
        Effect.gen(function* () {
          devices.push(context.deviceId(), context.deviceId());
          yield* context.notify({
            kind: "sign-in",
            message: "Open the link to sign in to SSO.",
            links: [{ url: "https://sso.test/authorize", label: "Sign in to SSO" }],
          });
          yield* context.notify({ kind: "device-code", message: "Enter code ABCD-1234", code: "ABCD-1234" });
          // A paste prompt that loses the race to the browser's callback is withdrawn.
          const pasted = context.ask("Paste the code", { kind: "sign-in-code" }).pipe(Effect.onInterrupt(() => Effect.sync(() => void (withdrawn = true))));
          yield* Effect.raceFirst(pasted, Effect.succeed("from the callback"));
          return { type: "oauth" as const, access: "token", refresh: "refresh", expires: Date.now() + 3_600_000, accountId: "acct" };
        }),
      refresh: async (credential) => credential,
    };
    const credentials = fakeCredentials();
    const interaction = fakeInteraction(() => Effect.never);
    const recorder = noticeRecorder();
    const host = fakeHost();
    const plugins = [
      credentials.plugin,
      interaction.plugin,
      recorder.plugin,
      host.plugin,
      makeLlmPlugin({ fetch: offline, providers: () => [faux({ id: "sso", name: "SSO", oauth: sso })], env: {} }),
    ];
    const info = await runWith(
      plugins,
      Effect.gen(function* () {
        const llm = yield* Llm;
        yield* Effect.provideService(llm.login("sso", "oauth"), InteractionOrigin, "login:sso");
        // Signed in is told once the catalog has refreshed, after the login returns.
        yield* Effect.promise(() => expect.poll(() => recorder.notices.length).toBe(3));
        return yield* llm.providers;
      }),
    );
    expect(withdrawn).toBe(true);
    expect(interaction.origins).toEqual(["login:sso"]);
    expect(interaction.asked).toEqual([{ type: "ask", title: "Paste the code", kind: "sign-in-code" }]);
    // The installation's one device ID (OpenAI's ChatGPT sign-in requires it), kept in the host's home.
    expect(devices[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(devices[1]).toBe(devices[0]);
    expect(readFileSync(join(host.home, "device-id"), "utf8").trim()).toBe(devices[0]);
    expect(credentials.store.get("sso")).toMatchObject({ type: "oauth", access: "token", accountId: "acct" });
    expect(info[0]).toMatchObject({
      auth: [{ type: "api_key" }, { type: "oauth", name: "SSO account", interactive: true }],
      configured: true,
      source: "OAuth",
    });
    expect(recorder.notices).toEqual([
      {
        level: "info",
        source: "llm.http",
        kind: "sign-in",
        message: "Open the link to sign in to SSO.",
        links: [{ url: "https://sso.test/authorize", label: "Sign in to SSO" }],
        origin: "login:sso",
      },
      { level: "info", source: "llm.http", kind: "device-code", message: "Enter code ABCD-1234", code: "ABCD-1234", origin: "login:sso" },
      // Success is announced to every client after the flow's own notices.
      { level: "info", source: "llm.http", kind: "signed-in", message: "Logged in to SSO", origin: "login:sso" },
    ]);
  });

  it("announces a failed login as ended, under its origin", async () => {
    const recorder = noticeRecorder();
    const denied: OAuthMethod = { name: "SSO", login: () => Effect.fail(new Error("denied")), refresh: async (credential) => credential };
    const plugins = [
      fakeCredentials().plugin,
      fakeInteraction(() => Effect.succeed("unused")).plugin,
      recorder.plugin,
      fakeHost().plugin,
      makeLlmPlugin({ fetch: offline, providers: () => [faux({ id: "sso", name: "SSO", oauth: denied })], env: {} }),
    ];
    const failure = await runWith(
      plugins,
      Effect.flip(Effect.flatMap(Llm, (llm) => Effect.provideService(llm.login("sso", "oauth"), InteractionOrigin, "login:sso"))),
    );
    expect(failure).toMatchObject({ reason: "LoginFailed", message: "SSO login failed: denied" });
    expect(recorder.notices).toEqual([{ level: "info", source: "llm.http", kind: "ended", message: "SSO login failed", origin: "login:sso" }]);
  });

  it("returns once the credential is stored, without waiting on the catalog refresh a cancel could interrupt", async () => {
    const credentials = fakeCredentials();
    // models.dev never answers: the refresh after the login waits on it.
    const never = (() => new Promise<Response>(() => {})) as typeof fetch;
    const plugins = [
      credentials.plugin,
      fakeInteraction(() => Effect.succeed("sk-new")).plugin,
      fakeHost().plugin,
      makeLlmPlugin({ fetch: never, providers: () => [faux()], env: {} }),
    ];
    await runWith(
      plugins,
      Effect.flatMap(Llm, (llm) => llm.login("faux", "api_key").pipe(Effect.timeout("2 seconds"))),
    );
    expect(credentials.store.get("faux")).toEqual({ type: "api_key", key: "sk-new" });
  });

  it("refreshes an expired sign-in once, under the credential's lock, before a request", async () => {
    let refreshed = 0;
    const sso: OAuthMethod = {
      name: "SSO",
      login: () => Effect.die("not used"),
      refresh: async (credential) => {
        refreshed++;
        return { ...credential, access: `token-${refreshed}`, expires: Date.now() + 3_600_000 };
      },
    };
    const credentials = fakeCredentials({ faux: { type: "oauth", access: "old", refresh: "r", expires: Date.now() - 1, clientId: "c" } });
    const { fetch, sent } = scriptedFetch(() => sseResponse(completion("ok")));
    const plugins = [
      credentials.plugin,
      fakeInteraction(() => Effect.succeed("")).plugin,
      makeLlmPlugin({ fetch, providers: () => [faux({ oauth: sso })], env: {} }),
    ];
    const request = new LlmRequest({ model: "faux/plain", messages: [user("hi")] });
    await runWith(plugins, Effect.all([collect(request), collect(request)], { concurrency: "unbounded" }));
    expect(refreshed).toBe(1);
    expect(sent.map((one) => one.headers.get("authorization"))).toEqual(["Bearer token-1", "Bearer token-1"]);
    expect(credentials.store.get("faux")).toMatchObject({ type: "oauth", access: "token-1", clientId: "c" });
  });

  it("keeps a refreshed token though the request that asked for it was stopped", async () => {
    let asked = false;
    let release!: () => void;
    const sso: OAuthMethod = {
      name: "SSO",
      login: () => Effect.die("not used"),
      refresh: async (credential) => {
        asked = true;
        // Once asked, the provider may have rotated the refresh token: the answer must be kept.
        await new Promise<void>((resolve) => (release = resolve));
        return { ...credential, access: "rotated", refresh: "rotated-refresh", expires: Date.now() + 3_600_000 };
      },
    };
    const credentials = fakeCredentials({ faux: { type: "oauth", access: "old", refresh: "r", expires: Date.now() - 1 } });
    const { fetch } = scriptedFetch(() => sseResponse(completion("ok")));
    const plugins = [
      credentials.plugin,
      fakeInteraction(() => Effect.succeed("")).plugin,
      makeLlmPlugin({ fetch, providers: () => [faux({ oauth: sso })], env: {} }),
    ];
    await runWith(
      plugins,
      Effect.gen(function* () {
        const request = yield* Effect.forkChild(collect(new LlmRequest({ model: "faux/plain", messages: [user("hi")] })));
        yield* Effect.promise(() => expect.poll(() => asked).toBe(true));
        yield* Fiber.interrupt(request);
        release();
        yield* Effect.promise(() => expect.poll(() => credentials.store.get("faux")).toMatchObject({ access: "rotated", refresh: "rotated-refresh" }));
      }),
    );
  });

  it("tells a request whose sign-in cannot be refreshed to sign in again", async () => {
    const sso: OAuthMethod = { name: "SSO", login: () => Effect.die("not used"), refresh: () => Promise.reject(new Error("invalid_grant")) };
    const credentials = fakeCredentials({ faux: { type: "oauth", access: "old", refresh: "r", expires: Date.now() - 1 } });
    const plugins = [
      credentials.plugin,
      fakeInteraction(() => Effect.succeed("")).plugin,
      makeLlmPlugin({ fetch: offline, providers: () => [faux({ oauth: sso })], env: {} }),
    ];
    const events = await runWith(plugins, collect(new LlmRequest({ model: "faux/plain", messages: [user("hi")] })));
    expect(events.at(-1)).toMatchObject({
      type: "error",
      failure: { kind: "fatal" },
      message: { errorMessage: "Faux sign-in could not be refreshed: invalid_grant. Run /login faux to sign in again." },
    });
  });
});

describe("custom providers", () => {
  it("adds, relabels, and removes the user's providers through its own config", async () => {
    const host = fakeHost();
    const { plugins } = setup({ providers: [] });
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
        yield* llm.setLogo("my-gateway", "<svg/>");
        yield* llm.removeCustom("my-gateway");
        const missing = yield* Effect.flip(llm.removeCustom("never-added"));
        return [added, bad, missing] as const;
      }),
      { "llm.http": gateway },
    );
    // Its id avoids the one already taken; the key is asked for at login or read from the environment.
    expect(added).toBe("my-gateway-2");
    expect(bad).toMatchObject({ reason: "InvalidProvider" });
    expect(missing).toMatchObject({ reason: "UnknownProvider" });
    expect(host.saved).toEqual([
      {
        "llm.http": {
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
      { "llm.http": { add: { providers: [{ ...gateway.providers[0], logo: "<svg/>" }] } } },
      { "llm.http": { remove: { providers: ["my-gateway"] } } },
    ]);
    // A saved logo is how clients show the provider.
    const listed = await runWith(
      [...plugins, host.plugin],
      Effect.flatMap(Llm, (llm) => llm.providers),
      {
        "llm.http": { providers: [{ ...gateway.providers[0], logo: "<svg/>" }] },
      },
    );
    expect(listed.find((provider) => provider.id === "my-gateway")).toMatchObject({ custom: true, logo: "<svg/>" });
    expect(host.scopes).toEqual([undefined, undefined, undefined]);
  });

  it("saves the user's providers in the config file its config comes from", async () => {
    const host = fakeHost({ configScope: "project" });
    const { plugins } = setup({ providers: [] });
    await runWith(
      [...plugins, host.plugin],
      Effect.flatMap(Llm, (llm) => llm.addCustom({ name: "Local", api: "openai-completions", baseUrl: "http://localhost:1", models: ["m"] })),
    );
    expect(host.scopes).toEqual(["project"]);
  });

  it("replaces a built-in with the user's provider of the same id", async () => {
    const { plugins } = setup();
    const refs = await runWith(
      plugins,
      Effect.map(
        Effect.flatMap(Llm, (llm) => llm.models()),
        (models) => models.map((model) => model.ref),
      ),
      {
        "llm.http": { providers: [{ id: "faux", api: "openai-completions", baseUrl: "http://localhost:1/v1", models: [{ id: "mine" }] }] },
      },
    );
    expect(refs).toEqual(["faux/mine"]);
  });
});

describe("providers plugins add", () => {
  it("serves one while its plugin adds it, attributed to that plugin, and leaves out one it cannot serve", async () => {
    const { plugins } = setup({ providers: [] });
    let captured: Context.Service.Shape<typeof PluginContext> | undefined;
    const gateway = definePlugin({
      id: "gateway",
      layer: Layer.effectDiscard(
        Effect.map(PluginContext, (context) => {
          captured = context;
        }),
      ),
    });
    const [listed, models, after] = await runWith(
      [...plugins, gateway],
      Effect.gen(function* () {
        const llm = yield* Llm;
        const events = yield* Events;
        const changed = Effect.forkChild(Stream.runHead(events.stream(ModelsChanged)));
        const added = yield* changed;
        yield* Effect.yieldNow;
        const remove = yield* captured!.add(Providers, {
          id: "corp",
          name: "Corp Gateway",
          api: "openai-completions",
          baseUrl: "http://localhost:1/v1",
          models: [{ id: "big", name: "Big", contextWindow: 200_000 }],
        });
        // A protocol it does not speak: left out, with a warning.
        yield* captured!.add(Providers, { id: "pigeon", api: "carrier-pigeon", baseUrl: "http://x", models: [] });
        yield* Fiber.join(added);
        const listed = yield* llm.providers;
        const models = yield* llm.models();
        const removed = yield* changed;
        yield* Effect.yieldNow;
        yield* remove;
        yield* Fiber.join(removed);
        return [listed, models, yield* llm.providers] as const;
      }),
    );
    expect(listed.find((provider) => provider.id === "corp")).toMatchObject({ name: "Corp Gateway", from: "gateway" });
    expect(models.find((model) => model.ref === "corp/big")).toMatchObject({ name: "Big", contextWindow: 200_000 });
    expect(listed.some((provider) => provider.id === "pigeon")).toBe(false);
    expect(after.some((provider) => provider.id === "corp")).toBe(false);
  });

  it("refuses what is not a provider, failing the plugin adding it", async () => {
    const { plugins } = setup({ providers: [] });
    const broken = definePlugin({
      id: "broken",
      layer: Layer.effectDiscard(Effect.flatMap(PluginContext, (owner) => owner.add(Providers, { id: "a/b", api: "x" } as never))),
    });
    const exit = await Effect.runPromiseExit(Effect.scoped(makeCore([...plugins, fakeHost().plugin, broken])));
    expect(JSON.stringify(exit)).toContain("Not a provider");
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
  it("lets a plugin change a request's headers, and tells who changed which, how the provider answered, and what it passed on", async () => {
    const received: { trace?: string | undefined; body?: unknown } = {};
    const server = createServer((request, response) => {
      received.trace = request.headers["x-trace"] as string | undefined;
      let body = "";
      request.on("data", (part) => (body += String(part)));
      request.on("end", () => {
        received.body = JSON.parse(body);
        response.writeHead(200, { "content-type": "text/event-stream", "x-request-id": "req-7" });
        response.end(sseBody([chunk({ role: "assistant", content: "hi" }), chunk({}, "stop"), "[DONE]"]));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const providers = [{ id: "local", api: "openai-completions", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: { value: "sk-test" }, models: [{ id: "m" }] }];
    const responses: unknown[] = [];
    const tracer = definePlugin({
      id: "tracer",
      layer: Layer.effectDiscard(
        Effect.gen(function* () {
          const owner = yield* PluginContext;
          yield* owner.on(LlmProviderHeadersHook, (input, next) => Effect.map(next(input), (headers) => ({ ...headers, "x-trace": "t-1" })));
          yield* owner.observe(LlmProviderResponse, (response) => Effect.sync(() => void responses.push(response)));
        }),
      ),
    });
    const { plugins } = setup({ providers: [], fetch: (input, init) => fetch(input, init) });
    try {
      const events = await runWith(
        [...plugins, tracer],
        collect(
          new LlmRequest({ model: "local/m", messages: [user("hi")], sessionId: "s1", providerOptions: { temperature: 0.2, samplingParams: { top_k: 5 } } }),
        ),
        { "llm.http": { providers } },
      );
      expect(received).toMatchObject({ trace: "t-1", body: { temperature: 0.2, top_k: 5 } });
      expect([...events].find((event) => event.type === "provider")).toEqual({
        type: "provider",
        status: 200,
        requestId: "req-7",
        credit: { handlers: [{ source: "tracer", ms: expect.any(Number), changed: ["x-trace"] }] },
      });
      await expect.poll(() => responses.length).toBe(1);
      expect(responses[0]).toMatchObject({ sessionId: "s1", provider: "local", model: "local/m", status: 200, headers: { "x-request-id": "req-7" } });
    } finally {
      server.close();
    }
  });

  it("hands the headers hook the model's own headers, and says who changed which though the provider refused the request", async () => {
    const authorizations: (string | undefined)[] = [];
    const server = createServer((request, response) => {
      authorizations.push(request.headers.authorization);
      response.writeHead(401, { "content-type": "application/json" }).end('{"error":{"message":"bad key"}}');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const providers = [
      {
        id: "local",
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: { value: "sk-test" },
        headers: { "X-Team": "agents" },
        models: [{ id: "m" }],
      },
    ];
    const handed: Record<string, string | null>[] = [];
    const gateway = definePlugin({
      id: "gateway",
      layer: Layer.effectDiscard(
        Effect.flatMap(PluginContext, (owner) =>
          owner.on(LlmProviderHeadersHook, (input, next) => {
            handed.push({ ...input.headers });
            return Effect.map(next(input), (headers) => ({ ...headers, Authorization: "Bearer gateway" }));
          }),
        ),
      ),
    });
    const { plugins } = setup({ providers: [], fetch: (input, init) => fetch(input, init) });
    try {
      const events = [
        ...(await runWith([...plugins, gateway], collect(new LlmRequest({ model: "local/m", messages: [user("hi")] })), { "llm.http": { providers } })),
      ];
      expect(handed).toMatchObject([{ "X-Team": "agents" }]);
      // The handler's header goes over the protocol's own, the key among them.
      expect(authorizations).toEqual(["Bearer gateway"]);
      // No status: it was refused. Who changed the headers is told all the same, before the error.
      const told = events.findIndex((event) => event.type === "provider");
      expect(events[told]).toEqual({ type: "provider", credit: { handlers: [{ source: "gateway", ms: expect.any(Number), changed: ["Authorization"] }] } });
      expect(events.findIndex((event) => event.type === "error")).toBeGreaterThan(told);
      expect(events.at(-1)).toMatchObject({ failure: { kind: "fatal" }, message: { errorMessage: "401 bad key" } });
    } finally {
      server.close();
    }
  });

  it("names Lemma on every wire API, unless a model sends its own User-Agent", async () => {
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
    const { plugins } = setup({ providers: [], fetch: (input, init) => fetch(input, init) });
    try {
      await runWith(
        plugins,
        Effect.forEach(providers, ({ id }) => collect(new LlmRequest({ model: `${id}/m`, messages: [user("hi")] }))),
        { "llm.http": { providers } },
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

  it("sends OpenCode's session header, which it routes a conversation by", async () => {
    const { fetch, sent } = scriptedFetch(() => sseResponse(completion("ok")));
    const { plugins } = setup({ fetch, providers: [faux({ headers: (sessionId) => ({ "x-opencode-session": sessionId ?? "fresh" }) })] });
    await runWith(plugins, collect(new LlmRequest({ model: "faux/plain", messages: [user("hi")], sessionId: "s9" })));
    expect(sent[0]!.headers.get("x-opencode-session")).toBe("s9");
  });
});
