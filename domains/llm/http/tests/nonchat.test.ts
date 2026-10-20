import { describe, expect, it } from "vitest";
import { Effect, Fiber, Schema } from "effect";
import { ClassifierResult, ImagesResult, Llm } from "@lemma/llm";
import type { ClassifierContext } from "@lemma/llm";
import { openrouterNonchat } from "../src/catalog.ts";
import { builtinProviders } from "../src/providers.ts";
import { makeLlmPlugin } from "../src/index.ts";
import type { BuiltinProvider } from "../src/index.ts";
import { fakeCredentials, fakeInteraction, faux, offline, runWith, scriptedFetch } from "./helpers.ts";

const decodeClassified = Schema.decodeUnknownSync(ClassifierResult, { onExcessProperty: "error" });
const decodeImages = Schema.decodeUnknownSync(ImagesResult, { onExcessProperty: "error" });

/** `faux` serving Jev on System One, a Decisions classifier, and an image model, beside its chat models. */
const serving = (extra: Partial<BuiltinProvider> = {}): BuiltinProvider[] => [
  faux({
    classifiers: { api: "typesafe-system-one", baseUrl: "https://faux.test/v1/" },
    images: { api: "openrouter-images", baseUrl: "https://faux.test/v1" },
    nonchat: {
      classifiers: [{ id: "jev", name: "Jev", input: ["text"], contextWindow: 64_000, cost: { input: 2, output: 0 } }],
      images: [
        { id: "painter", name: "Painter", input: ["text", "image"], output: ["image", "text"], cost: { input: 1, output: 4, cacheRead: 0, cacheWrite: 0 } },
      ],
    },
    ...extra,
  }),
  {
    id: "decider",
    name: "Decider",
    apis: {},
    env: ["DECIDER_KEY"],
    models: [],
    classifiers: {
      api: "openai-decisions",
      baseUrl: "https://decider.test/v1",
      models: [
        {
          id: "luna",
          name: "Luna",
          input: ["text", "image"],
          contextWindow: 900_000,
          cost: { input: 0.1, output: 0, longInput: { above: 1000, input: 0.2, output: 0 } },
        },
      ],
    },
  },
];

const plugins = (options: { readonly fetch?: typeof fetch; readonly env?: Record<string, string>; readonly providers?: BuiltinProvider[] } = {}) => {
  const credentials = fakeCredentials();
  return [
    credentials.plugin,
    fakeInteraction(() => Effect.succeed("")).plugin,
    makeLlmPlugin({
      fetch: options.fetch ?? offline,
      providers: () => options.providers ?? serving(),
      env: options.env ?? { FAUX_KEY: "sk-faux", DECIDER_KEY: "sk-decider" },
    }),
  ];
};

const questions: ClassifierContext["questions"] = {
  mood: { type: "choice", instructions: "The user's mood", criteria: { happy: "pleased", sad: "" } },
  urgency: { type: "score", instructions: "How urgent it is", criteria: ["not", "somewhat", "very"] },
  spam: { type: "bool", instructions: "Whether it is spam", criteria: { true: "an advert", false: "" } },
};

describe("classify", () => {
  it("asks System One the questions by id, a yes-or-no as its noul, and reads its answers and usage", async () => {
    const { sent, fetch } = scriptedFetch(() =>
      Response.json({
        answers: {
          mood: { type: "choice", choice: "happy", probabilities: { happy: 0.9, sad: 0.1 }, confidence: 0.8 },
          urgency: { type: "score", score: 1.5, confidence: 0.6 },
          spam: { type: "noul", noul: 0.05 },
        },
        usage: { input_tokens: 500_000, output_tokens: 0 },
      }),
    );
    const result = await runWith(
      plugins({ fetch }),
      Effect.flatMap(Llm, (llm) => llm.classify("faux/jev", { state: { message: "hi" }, questions })),
    );
    expect(decodeClassified(result)).toEqual({
      provider: "faux",
      model: "jev",
      answers: {
        mood: { type: "choice", choice: "happy", probabilities: { happy: 0.9, sad: 0.1 }, confidence: 0.8 },
        urgency: { type: "score", score: 1.5, confidence: 0.6 },
        spam: { type: "bool", probability: 0.05 },
      },
      usage: {
        input: 500_000,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 500_000,
        cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
      },
      stopReason: "stop",
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("https://faux.test/v1/systemone");
    expect(sent[0]!.headers.get("authorization")).toBe("Bearer sk-faux");
    expect(sent[0]!.headers.get("user-agent")).toMatch(/^lemma /);
    expect(sent[0]!.body).toEqual({
      model: "jev",
      state: { message: "hi" },
      questions: { ...questions, spam: { type: "noul", instructions: "Whether it is spam", criteria: { true: "an advert", false: "" } } },
    });
  });

  it("fails an answer missing a question's, keeping its billed usage, and a refusal with the provider's words", async () => {
    let call = 0;
    const { fetch } = scriptedFetch(() =>
      ++call === 1
        ? Response.json({ answers: { mood: { type: "choice", choice: "sad", probabilities: { sad: 1 }, confidence: 1 } }, usage: { input_tokens: 10 } })
        : Response.json({ error: { message: "Invalid API key" } }, { status: 401 }),
    );
    const [missing, refused] = await runWith(
      plugins({ fetch }),
      Effect.flatMap(Llm, (llm) => Effect.all([llm.classify("faux/jev", { state: {}, questions }), llm.classify("faux/jev", { state: {}, questions })])),
    );
    expect(missing).toMatchObject({ answers: {}, stopReason: "error", errorMessage: "System One did not answer urgency", usage: { input: 10 } });
    expect(refused).toEqual({ provider: "faux", model: "jev", answers: {}, stopReason: "error", errorMessage: "System One: 401 Invalid API key" });
  });

  it("refuses images on System One, sending nothing", async () => {
    const { sent, fetch } = scriptedFetch(() => Response.json({}));
    const result = await runWith(
      plugins({ fetch }),
      Effect.flatMap(Llm, (llm) => llm.classify("faux/jev", { state: {}, images: [{ type: "image", mimeType: "image/png", data: "AA==" }], questions })),
    );
    expect(result).toMatchObject({ stopReason: "error", errorMessage: "System One classifiers take no images" });
    expect(sent).toHaveLength(0);
  });

  it("asks OpenAI's Decisions with the state as text, a yes-or-no as a predicate, and reads answers by name at its long input's price", async () => {
    const { sent, fetch } = scriptedFetch(() =>
      Response.json({
        answers: [
          { name: "spam", type: "predicate", probability: 0.2 },
          {
            name: "mood",
            type: "choice",
            choice: "sad",
            probabilities: [
              { value: "sad", probability: 0.7 },
              { value: "happy", probability: 0.3 },
            ],
            confidence: 0.5,
          },
          { name: "urgency", type: "score", score: 0, confidence: 0.9 },
        ],
        usage: { input_tokens: 2000, output_tokens: 0 },
      }),
    );
    const [plain, pictured] = await runWith(
      plugins({ fetch }),
      Effect.flatMap(Llm, (llm) =>
        Effect.all([
          llm.classify("decider/luna", { state: { a: 1 }, questions }),
          llm.classify("decider/luna", { state: { a: 1 }, images: [{ type: "image", mimeType: "image/png", data: "AA==" }], questions }),
        ]),
      ),
    );
    expect(decodeClassified(plain)).toMatchObject({
      answers: {
        mood: { type: "choice", choice: "sad", probabilities: { sad: 0.7, happy: 0.3 }, confidence: 0.5 },
        urgency: { type: "score", score: 0, confidence: 0.9 },
        spam: { type: "bool", probability: 0.2 },
      },
      stopReason: "stop",
    });
    // Over the long input's threshold, the whole input is at its price.
    expect(plain.usage?.cost.input).toBeCloseTo(0.0004);
    expect(pictured.stopReason).toBe("stop");
    expect(sent[0]!.url).toBe("https://decider.test/v1/decisions");
    expect(sent[0]!.body).toEqual({
      model: "luna",
      input: '{"a":1}',
      questions: [
        { type: "choice", name: "mood", instructions: "The user's mood", choices: [{ value: "happy", description: "pleased" }, { value: "sad" }] },
        { type: "score", name: "urgency", instructions: "How urgent it is", levels: [{ label: "not" }, { label: "somewhat" }, { label: "very" }] },
        { type: "predicate", name: "spam", instructions: "Whether it is spam\n\nTrue means: an advert" },
      ],
    });
    expect(sent[1]!.body.input).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: '{"a":1}' },
          { type: "input_image", image_url: "data:image/png;base64,AA==" },
        ],
      },
    ]);
  });

  it("does not ask Decisions again after its gateway's 504, saying why it came", async () => {
    const { sent, fetch } = scriptedFetch(() => new Response("<html>Gateway Timeout</html>", { status: 504 }));
    const result = await runWith(
      plugins({ fetch }),
      Effect.flatMap(Llm, (llm) => llm.classify("decider/luna", { state: {}, questions })),
    );
    expect(sent).toHaveLength(1);
    expect(result.errorMessage).toMatch(/^OpenAI Decisions: 504: the request timed out at OpenAI's gateway/);
  });

  it("does not offer or ask Decisions with a signed-in account's token, which it refuses", async () => {
    const credentials = fakeCredentials({ decider: { type: "oauth", access: "chatgpt-token", refresh: "r", expires: Date.now() + 3_600_000 } });
    const { sent, fetch } = scriptedFetch(() => Response.json({}));
    const signIn = { id: "account", name: "Sign in", login: () => Effect.die("unused"), refresh: async () => Promise.reject(new Error("unused")) };
    const [decider, ...rest] = serving().reverse();
    const providers = [...rest.reverse(), { ...decider!, oauth: signIn }];
    const result = await runWith(
      [credentials.plugin, fakeInteraction(() => Effect.succeed("")).plugin, makeLlmPlugin({ fetch, providers: () => providers, env: { FAUX_KEY: "k" } })],
      Effect.flatMap(Llm, (llm) =>
        Effect.all({
          available: llm.classifiers({ available: true }),
          all: llm.classifiers(),
          asked: llm.classify("decider/luna", { state: {}, questions }),
        }),
      ),
    );
    expect(result.available.map((model) => model.ref)).toEqual(["faux/jev"]);
    expect(result.all.map((model) => model.ref)).toEqual(["faux/jev", "decider/luna"]);
    expect(result.asked).toMatchObject({ stopReason: "error", errorMessage: "OpenAI Decisions takes an API key, not a signed-in account's token" });
    expect(sent).toHaveLength(0);
  });

  it("answers a provider without a key as an error, and an unknown classifier as UnknownModel", async () => {
    const result = await runWith(
      plugins({ env: {} }),
      Effect.flatMap(Llm, (llm) =>
        Effect.all({ unkeyed: llm.classify("faux/jev", { state: {}, questions }), unknown: Effect.flip(llm.classify("faux/plain", { state: {}, questions })) }),
      ),
    );
    expect(result.unkeyed).toMatchObject({
      stopReason: "error",
      errorMessage: "Faux is not authenticated. Run /login faux or set its API key environment variable.",
    });
    expect(result.unknown.reason).toBe("UnknownModel");
  });

  it("aborts the request when interrupted", async () => {
    let signal: AbortSignal | undefined;
    let reached = () => {};
    const asked = new Promise<void>((resolve) => (reached = resolve));
    const { fetch } = scriptedFetch(
      (sent) =>
        new Promise<Response>((_, reject) => {
          signal = sent.signal;
          sent.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          reached();
        }),
    );
    await runWith(
      plugins({ fetch }),
      Effect.flatMap(Llm, (llm) =>
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(llm.classify("faux/jev", { state: {}, questions }));
          yield* Effect.promise(() => asked);
          yield* Fiber.interrupt(fiber);
        }),
      ),
    );
    expect(signal?.aborted).toBe(true);
  });

  it("lists the classifiers of configured providers as available", async () => {
    const result = await runWith(
      plugins({ env: { DECIDER_KEY: "k" } }),
      Effect.flatMap(Llm, (llm) => Effect.all({ available: llm.classifiers({ available: true }), all: llm.classifiers() })),
    );
    expect(result.available).toEqual([
      {
        ref: "decider/luna",
        provider: "decider",
        id: "luna",
        name: "Luna",
        api: "openai-decisions",
        input: ["text", "image"],
        contextWindow: 900_000,
        cost: { input: 0.1, output: 0 },
      },
    ]);
    expect(result.all.map((model) => model.ref)).toEqual(["faux/jev", "decider/luna"]);
  });
});

describe("generateImages", () => {
  it("asks OpenRouter's Chat Completions for the whole answer in images and text, and reads both", async () => {
    const { sent, fetch } = scriptedFetch(() =>
      Response.json({
        choices: [
          { message: { content: "Here it is", images: [{ image_url: { url: "data:image/png;base64,iVBO" } }, { image_url: "https://not.data/x.png" }] } },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 1000 },
      }),
    );
    const result = await runWith(
      plugins({ fetch }),
      Effect.flatMap(Llm, (llm) =>
        llm.generateImages("faux/painter", {
          input: [
            { type: "text", text: "a cat" },
            { type: "image", mimeType: "image/jpeg", data: "/9j/" },
          ],
        }),
      ),
    );
    expect(decodeImages(result)).toEqual({
      provider: "faux",
      model: "painter",
      output: [
        { type: "text", text: "Here it is" },
        { type: "image", mimeType: "image/png", data: "iVBO" },
      ],
      usage: {
        input: 100,
        output: 1000,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        totalTokens: 1100,
        cost: { input: 0.0001, output: 0.004, cacheRead: 0, cacheWrite: 0, total: 0.0041 },
      },
      stopReason: "stop",
    });
    expect(sent[0]!.url).toBe("https://faux.test/v1/chat/completions");
    expect(sent[0]!.body).toEqual({
      model: "painter",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "a cat" },
            { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/" } },
          ],
        },
      ],
      stream: false,
      modalities: ["image", "text"],
    });
  });

  it("answers a refusal as an error, and lists image models", async () => {
    const { fetch } = scriptedFetch(() => Response.json({ error: { message: "No credits" } }, { status: 402 }));
    const result = await runWith(
      plugins({ fetch }),
      Effect.flatMap(Llm, (llm) =>
        Effect.all({ made: llm.generateImages("faux/painter", { input: [{ type: "text", text: "a cat" }] }), listed: llm.imageModels() }),
      ),
    );
    expect(result.made).toEqual({ provider: "faux", model: "painter", output: [], stopReason: "error", errorMessage: "OpenRouter: 402 No credits" });
    expect(result.listed.map((model) => model.ref)).toEqual(["faux/painter"]);
  });
});

describe("built-in classifiers and image models", () => {
  it("serves TypeSafe's Jev, OpenAI's Decisions, and OpenRouter's and OpenCode's classifiers and OpenRouter's image models", async () => {
    const result = await runWith(
      [fakeCredentials().plugin, fakeInteraction(() => Effect.succeed("")).plugin, makeLlmPlugin({ fetch: offline, env: { TYPESAFE_API_KEY: "k" } })],
      Effect.flatMap(Llm, (llm) => Effect.all({ all: llm.classifiers(), available: llm.classifiers({ available: true }), images: llm.imageModels() })),
    );
    expect(result.available.map((model) => model.ref)).toEqual(["typesafe/jev-latest"]);
    const refs = result.all.map((model) => model.ref);
    expect(refs).toEqual(expect.arrayContaining(["openai/gpt-6-luna", "opencode/jev-1.13", "openrouter/typesafe/jev-1.13"]));
    expect(new Set(result.all.map((model) => model.api))).toEqual(new Set(["openai-decisions", "typesafe-system-one"]));
    expect(result.images.length).toBeGreaterThan(10);
    expect(result.images.every((model) => model.provider === "openrouter" && model.output.includes("image"))).toBe(true);
    expect(builtinProviders().find((provider) => provider.id === "typesafe")?.models).toEqual([]);
  });

  it("reads OpenRouter's classifiers and image models from its list, at prices a million tokens", () => {
    const listed = openrouterNonchat({
      data: [
        {
          id: "typesafe/jev-1.14",
          name: "TypeSafe: Jev 1.14",
          context_length: 262144,
          architecture: { input_modalities: ["text", "image"], output_modalities: ["decisions"] },
          pricing: { prompt: "0.000000042", completion: "0" },
        },
        {
          id: "respan/span-01",
          name: "Respan: Span-01",
          context_length: 0,
          architecture: { output_modalities: ["decisions"] },
          pricing: { prompt: "0.00000002" },
        },
        {
          id: "google/image",
          name: "Image",
          architecture: { input_modalities: ["image", "text", "file"], output_modalities: ["image", "text"] },
          pricing: { prompt: "0.0000003", completion: "0.0000025", input_cache_read: "0.00000003" },
        },
        {
          id: "openrouter/auto",
          architecture: { input_modalities: ["text"], output_modalities: ["text", "image"] },
          pricing: { prompt: "-1", completion: "-1" },
        },
        { id: "chat", architecture: { output_modalities: ["text"] } },
      ],
    });
    expect(listed).toEqual({
      classifiers: [
        { id: "respan/span-01", name: "Respan: Span-01", input: ["text"], contextWindow: 0, cost: { input: 0.02, output: 0 } },
        { id: "typesafe/jev-1.14", name: "TypeSafe: Jev 1.14", input: ["text"], contextWindow: 262144, cost: { input: 0.042, output: 0 } },
      ],
      images: [
        {
          id: "google/image",
          name: "Image",
          input: ["image", "text"],
          output: ["image", "text"],
          cost: { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0 },
        },
        {
          id: "openrouter/auto",
          name: "openrouter/auto",
          input: ["text"],
          output: ["image", "text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    });
    expect(openrouterNonchat({ error: "x" })).toBeUndefined();
  });
});
