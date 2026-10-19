import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { Llm } from "@lemma/llm";
import { devSource, fromDev, mustThinkOf, mustThinkSource, planModels, planSource, thinkingOf } from "../src/catalog.ts";
import type { DevProvider, PlanModel } from "../src/catalog.ts";
import { chatgpt } from "../src/chatgpt.ts";
import { makeLlmPlugin } from "../src/index.ts";
import type { Model } from "../src/model.ts";
import type { LoginContext } from "../src/providers.ts";
import { builtinProviders } from "../src/providers.ts";
import { fakeCredentials, fakeInteraction, runWith } from "./helpers.ts";

describe("thinkingOf", () => {
  const effort = (...values: string[]) => [{ type: "effort", values }];

  it("asks Anthropic's adaptive models (a max effort) for an effort, its others for a budget", () => {
    expect(thinkingOf("anthropic-messages", effort("low", "medium", "high", "xhigh", "max"), true)).toEqual({
      kind: "effort",
      levels: ["low", "medium", "high", "xhigh", "max"],
    });
    // One that also thinks in a budget (Claude 4.6) can stop.
    expect(thinkingOf("anthropic-messages", [...effort("low", "high", "max"), { type: "budget_tokens" }], true)).toEqual({
      kind: "effort",
      levels: ["off", "low", "high", "max"],
    });
    expect(thinkingOf("anthropic-messages", [...effort("low", "medium", "high"), { type: "budget_tokens" }], true)).toEqual({
      kind: "budget",
      levels: ["off", "minimal", "low", "medium", "high"],
    });
    expect(thinkingOf("anthropic-messages", [{ type: "toggle" }], true)).toEqual({ kind: "toggle", levels: ["off", "high"] });
  });

  it("takes an effort's levels as named, none as off, and a toggle only where the protocol has a switch", () => {
    expect(thinkingOf("openai-responses", effort("none", "low", "medium", "high", "xhigh"), false)).toEqual({
      kind: "effort",
      levels: ["off", "low", "medium", "high", "xhigh"],
      values: { off: "none" },
    });
    expect(thinkingOf("openai-completions", effort("high", "max"), false)).toEqual({ kind: "effort", levels: ["high", "max"] });
    expect(thinkingOf("openai-completions", [{ type: "toggle" }], false)).toBeUndefined();
    expect(thinkingOf("openai-completions", [{ type: "toggle" }], true)).toEqual({ kind: "toggle", levels: ["off", "high"] });
    expect(thinkingOf("openai-completions", [], true)).toBeUndefined();
  });

  it("gives off only to a model that can stop thinking: not one whose least budget is more than none, nor one its provider says must reason", () => {
    // Gemini 2.5 Pro behind OpenRouter: it thinks in at least 128 tokens.
    expect(thinkingOf("openai-completions", [{ type: "budget_tokens", min: 128 }], true)).toEqual({ kind: "toggle", levels: ["high"] });
    expect(thinkingOf("openai-completions", [{ type: "budget_tokens", min: 0 }], true)).toEqual({ kind: "toggle", levels: ["off", "high"] });
    // OpenAI's o3 behind OpenRouter, which models.dev has switching thinking off.
    expect(thinkingOf("openai-completions", [{ type: "toggle" }], true, true)).toEqual({ kind: "toggle", levels: ["high"] });
    expect(thinkingOf("openai-completions", [...effort("low", "high"), { type: "toggle" }], true, true)).toEqual({ kind: "effort", levels: ["low", "high"] });
    // Anthropic's budget models turn thinking off however little they think in.
    expect(thinkingOf("anthropic-messages", [{ type: "budget_tokens", min: 1024 }], true)?.levels).toContain("off");
  });
});

describe("fromDev", () => {
  const dev: DevProvider = {
    npm: "@ai-sdk/openai-compatible",
    models: {
      "kimi-k3": {
        name: "Kimi K3",
        reasoning: true,
        tool_call: true,
        temperature: false,
        reasoning_options: [{ type: "effort", values: ["max"] }],
        modalities: { input: ["text", "image", "video"] },
        limit: { context: 1_048_576, output: 131_072 },
        cost: { input: 3, output: 15, cache_read: 0.3 },
      },
      "claude-x": { name: "Claude X", tool_call: true, provider: { npm: "@ai-sdk/anthropic" } },
      gemini: { name: "Gemini", tool_call: true, provider: { npm: "@ai-sdk/google" } },
      embedder: { name: "Embedder", tool_call: false },
    },
  };

  it("keeps the chat models on the protocols a provider serves, as the catalog describes them", () => {
    expect(
      fromDev(
        dev,
        () => true,
        () => false,
      ),
    ).toEqual([
      {
        id: "claude-x",
        name: "Claude X",
        api: "anthropic-messages",
        input: ["text"],
        contextWindow: 128_000,
        maxTokens: 16_384,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        reasoning: false,
      },
      {
        id: "kimi-k3",
        name: "Kimi K3",
        api: "openai-completions",
        input: ["text", "image"],
        contextWindow: 1_048_576,
        maxTokens: 131_072,
        cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
        reasoning: true,
        thinking: { kind: "effort", levels: ["max"] },
        temperature: false,
      },
    ]);
    expect(
      fromDev(
        dev,
        (api) => api === "openai-completions",
        () => false,
      ).map((model) => model.id),
    ).toEqual(["kimi-k3"]);
  });

  it("describes the committed catalog's providers on the protocols this plugin speaks", () => {
    const providers = builtinProviders();
    expect(providers.map((provider) => provider.id)).toEqual(["anthropic", "openai", "openrouter", "opencode", "opencode-go"]);
    for (const provider of providers) {
      expect(provider.models.length).toBeGreaterThan(0);
      for (const model of provider.models) expect(provider.apis[model.api]).toBeDefined();
    }
  });
});

describe("mustThinkSource", () => {
  it("reads which of OpenRouter's models must reason from its list, once an hour, and nothing for a provider with none", async () => {
    let reads = 0;
    const read = mustThinkSource(async (input) => {
      reads++;
      expect(String(input)).toBe("https://openrouter.ai/api/v1/models");
      return Response.json({
        data: [{ id: "openai/o3", reasoning: { mandatory: true } }, { id: "anthropic/claude", reasoning: { mandatory: false } }, { id: "x" }],
      });
    });
    const signal = new AbortController().signal;
    expect(await read("openrouter", signal)).toEqual(new Set(["openai/o3"]));
    expect(await read("openrouter", signal)).toEqual(new Set(["openai/o3"]));
    expect(await read("faux", signal)).toBeUndefined();
    expect(reads).toBe(1);
    expect(mustThinkOf({ error: "nope" })).toBeUndefined();
  });
});

describe("devSource", () => {
  it("reads models.dev once for every provider, and again after a failure", async () => {
    let reads = 0;
    let up = false;
    const read = devSource(async () => {
      reads++;
      if (!up) throw new Error("down");
      return Response.json({ faux: { models: {} } });
    });
    const signal = new AbortController().signal;
    expect(await read(signal)).toBeUndefined();
    up = true;
    expect(await read(signal)).toEqual({ faux: { models: {} } });
    expect(await read(signal)).toEqual({ faux: { models: {} } });
    expect(reads).toBe(2);
  });
});

describe("ChatGPT plans", () => {
  const known = (id: string, extra: Partial<Model> = {}): Model => ({
    provider: "openai",
    id,
    name: id,
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    input: ["text"],
    contextWindow: 400_000,
    maxTokens: 128_000,
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    reasoning: false,
    ...extra,
  });
  const api = [known("gpt-6-sol", { reasoning: true, input: ["text", "image"] }), known("gpt-6-astra", { reasoning: true }), known("o1"), known("gpt-4o")];
  // As `GET /v1/models?client_version=…` answers a ChatGPT sign-in.
  const listed: PlanModel[] = [
    {
      slug: "gpt-6.1-sol",
      display_name: "GPT-6.1-Sol",
      visibility: "list",
      context_window: 900_000,
      input_modalities: ["text", "image"],
      supported_reasoning_levels: [{}],
    },
    { slug: "gpt-6-astra", display_name: "GPT-6-Astra", visibility: "list" },
    { slug: "gpt-reserve", visibility: "hide" },
    { slug: "gpt-6-sol", visibility: "list" },
    { slug: "gpt-app-only", visibility: "list", supported_in_api: false },
  ];

  it("offers what the plan lists for its pickers, in its order, the API catalog's entries where it has them", () => {
    const models = planModels(api, listed);
    expect(models.map((m) => m.id)).toEqual(["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol"]);
    expect(models[1]).toBe(api[1]);
    // A model the catalog does not know is served like the nearest known one, described by the list.
    expect(models[0]).toMatchObject({
      name: "GPT-6.1-Sol",
      api: "openai-responses",
      provider: "openai",
      contextWindow: 900_000,
      input: ["text", "image"],
      reasoning: true,
    });
  });

  it("asks OpenAI as a client newer than any, with the sign-in's token", async () => {
    const requests: { url: string; authorization: string | null }[] = [];
    const source = planSource(async (input, init) => {
      requests.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify({ models: [{ slug: "gpt-6-sol", visibility: "list" }, { visibility: "list" }] }));
    });
    expect(await source("token", new AbortController().signal)).toEqual([{ slug: "gpt-6-sol", visibility: "list" }]);
    expect(requests).toEqual([{ url: "https://api.openai.com/v1/models?client_version=999.0.0", authorization: "Bearer token" }]);
    const refused = planSource(async () => new Response("no", { status: 401 }));
    expect(await refused("token", new AbortController().signal)).toBeUndefined();
  });

  it("lists the plan's models signed in with ChatGPT, and the API's with a key", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.startsWith("https://api.openai.com/v1/models"))
        return Response.json({ models: [{ slug: "gpt-plan-only", display_name: "Plan only", visibility: "list" }] });
      throw new Error("offline in tests");
    };
    const openai = builtinProviders().filter((provider) => provider.id === "openai");
    const run = (credential: Parameters<typeof fakeCredentials>[0], until: (refs: readonly string[]) => boolean, config: Record<string, unknown> = {}) =>
      runWith(
        [
          fakeCredentials(credential).plugin,
          fakeInteraction(() => Effect.succeed("")).plugin,
          makeLlmPlugin({ fetch: fetchImpl, providers: () => openai, env: {} }),
        ],
        Effect.flatMap(Llm, (llm) => {
          const refs = () => Effect.runPromise(Effect.map(llm.models({ available: true }), (models) => models.map((model) => model.ref)));
          // Once the refresh at startup has run.
          return Effect.andThen(
            Effect.promise(() => expect.poll(async () => until(await refs())).toBe(true)),
            llm.models({ available: true }),
          );
        }),
        { "llm.http": config },
      );
    const plan = await run({ openai: { type: "oauth", access: "tok", refresh: "r", expires: Date.now() + 3_600_000 } }, (refs) => refs.length === 1);
    expect(plan.map((model) => model.ref)).toEqual(["openai/gpt-plan-only"]);
    // models.dev's catalogs off, a plan still lists its own.
    const offline = await run({ openai: { type: "oauth", access: "tok", refresh: "r", expires: Date.now() + 3_600_000 } }, (refs) => refs.length === 1, {
      liveCatalogs: false,
    });
    expect(offline.map((model) => model.ref)).toEqual(["openai/gpt-plan-only"]);
    const keyed = await run({ openai: { type: "api_key", key: "sk" } }, () => true);
    expect(keyed.length).toBeGreaterThan(5);
    expect(keyed.some((model) => model.ref === "openai/gpt-plan-only")).toBe(false);
  });
});

describe("Sign in with ChatGPT", () => {
  /** A login context that answers the paste prompt with `paste` (given the sign-in link), recording what the flow does. */
  const context = (paste: (link: URL) => string, fetchImpl: typeof fetch) => {
    const notices: { kind?: string | undefined; message: string; links?: readonly { url: string }[] | undefined }[] = [];
    const login: LoginContext = {
      notify: (notice) => Effect.sync(() => void notices.push(notice)),
      ask: () => Effect.sync(() => paste(new URL(notices[0]!.links![0]!.url))),
      deviceId: () => "0b5c3f6e-6a9f-4a51-9a35-2f6f0e3b8a10",
      fetch: fetchImpl,
    };
    return { notices, login };
  };

  it("signs in with a pasted redirect, naming this installation, and exchanges the code for a credential", async () => {
    const posts: { url: string; body: URLSearchParams }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      posts.push({ url: String(input), body: new URLSearchParams(String(init?.body)) });
      return Response.json({ access_token: "acc", refresh_token: "ref", id_token: "id", scope: "openid chatgpt.tokens.use.direct", expires_in: 3600 });
    };
    const { notices, login } = context(
      (link) => `http://127.0.0.1:1455/auth/callback?code=the-code&state=${link.searchParams.get("state")}&client_id=issued`,
      fetchImpl,
    );
    const credential = await Effect.runPromise(chatgpt.login(login));
    const link = new URL(notices[0]!.links![0]!.url);
    expect(link.origin + link.pathname).toBe("https://auth.openai.com/api/accounts/authorize");
    expect(Object.fromEntries(link.searchParams)).toMatchObject({
      client_id: "dynamic_agent_client",
      agent_name_hint: "Lemma",
      ext_agent_host_id: "urn:uuid:0b5c3f6e-6a9f-4a51-9a35-2f6f0e3b8a10",
      redirect_uri: "http://127.0.0.1:1455/auth/callback",
      code_challenge_method: "S256",
    });
    expect(notices.map((notice) => notice.kind)).toEqual(["sign-in", "progress"]);
    expect(posts[0]!.url).toBe("https://auth.openai.com/api/accounts/oauth/token");
    expect(Object.fromEntries(posts[0]!.body)).toMatchObject({ grant_type: "authorization_code", client_id: "issued", code: "the-code" });
    expect(credential).toMatchObject({ type: "oauth", access: "acc", refresh: "ref", clientId: "issued", scopes: ["openid", "chatgpt.tokens.use.direct"] });
  });

  it("fails, rather than dies, when this installation's device id cannot be kept", async () => {
    const { login } = context(
      () => "unused",
      async () => Response.json({}),
    );
    const failed = await Effect.runPromise(
      Effect.flip(
        chatgpt.login({
          ...login,
          deviceId: () => {
            throw new Error("EACCES: permission denied");
          },
        }),
      ),
    );
    expect(String(failed)).toContain("EACCES");
  });

  it("refuses a pasted redirect for another login, and refreshes with the issued client id", async () => {
    const { login } = context(
      () => "http://127.0.0.1:1455/auth/callback?code=c&state=stale&client_id=issued",
      async () => Response.json({}),
    );
    const refused = await Effect.runPromise(Effect.flip(chatgpt.login(login)));
    expect(String(refused)).toContain("another login");
    const bodies: URLSearchParams[] = [];
    const fresh = await chatgpt.refresh(
      { type: "oauth", access: "old", refresh: "ref", expires: 0, clientId: "issued" },
      async (_, init) => {
        bodies.push(new URLSearchParams(String(init?.body)));
        return Response.json({ access_token: "new", refresh_token: "ref2", scope: "chatgpt.tokens.use.direct", expires_in: 3600 });
      },
      new AbortController().signal,
    );
    expect(Object.fromEntries(bodies[0]!)).toEqual({
      grant_type: "refresh_token",
      client_id: "issued",
      refresh_token: "ref",
      resource: "https://api.openai.com/v1",
    });
    expect(fresh).toMatchObject({ access: "new", refresh: "ref2", clientId: "issued" });
  });
});
