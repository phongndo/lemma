import type { CatalogClassifier, ClassifierApi } from "./classify.ts";
import type { ImageApi } from "./images.ts";
import type { WireApi } from "./model.ts";

/** A built-in provider's endpoints: where it serves which protocol, and the environment variables its key is read from. */
export interface Endpoint {
  readonly id: string;
  readonly name: string;
  /** The base URL of each wire API it serves its models on; its catalog leaves out a model on any other. */
  readonly apis: Readonly<Partial<Record<WireApi, string>>>;
  readonly env: readonly string[];
  /** models.dev's id for it, where that is not its own (Kimi Code's plan is `kimi-code-plan-cn` there). */
  readonly catalog?: string;
  /** False: it takes no key a person can give it, only a sign-in (Copilot's). */
  readonly keyLogin?: false;
  /**
   * Where it serves its classifier models (`classify.ts`), on which protocol, and those models where it publishes no
   * list of them: kept by hand. OpenRouter's are its list's, in `nonchat.json` (`scripts/catalog.ts`).
   */
  readonly classifiers?: { readonly api: ClassifierApi; readonly baseUrl: string; readonly models?: readonly CatalogClassifier[] };
  /** Where it serves its image models (`images.ts`), on which protocol. */
  readonly images?: { readonly api: ImageApi; readonly baseUrl: string };
}

/** The providers this plugin knows. Their models are models.dev's provider of the same id. */
export const ENDPOINTS: readonly Endpoint[] = [
  { id: "anthropic", name: "Anthropic", apis: { "anthropic-messages": "https://api.anthropic.com" }, env: ["ANTHROPIC_API_KEY"] },
  {
    id: "openai",
    name: "OpenAI",
    apis: { "openai-responses": "https://api.openai.com/v1" },
    env: ["OPENAI_API_KEY"],
    classifiers: {
      api: "openai-decisions",
      baseUrl: "https://api.openai.com/v1",
      models: [
        {
          id: "gpt-6-luna",
          name: "GPT-6 Luna",
          input: ["text", "image"],
          contextWindow: 922_000,
          cost: { input: 0.1, output: 0, longInput: { above: 272_000, input: 0.2, output: 0 } },
        },
      ],
    },
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    apis: { "openai-completions": "https://openrouter.ai/api/v1" },
    env: ["OPENROUTER_API_KEY"],
    classifiers: { api: "typesafe-system-one", baseUrl: "https://openrouter.ai/api/v1" },
    images: { api: "openrouter-images", baseUrl: "https://openrouter.ai/api/v1" },
  },
  {
    id: "opencode",
    name: "OpenCode Zen",
    apis: {
      "anthropic-messages": "https://opencode.ai/zen",
      "openai-responses": "https://opencode.ai/zen/v1",
      "openai-completions": "https://opencode.ai/zen/v1",
    },
    env: ["OPENCODE_API_KEY"],
    classifiers: {
      api: "typesafe-system-one",
      baseUrl: "https://opencode.ai/zen/v1",
      models: [
        { id: "jev-1.13", name: "Jev 1.13", input: ["text"], contextWindow: 32_000, cost: { input: 0.042, output: 0 } },
        { id: "jev-1.13-free", name: "Jev 1.13 Free", input: ["text"], contextWindow: 32_000, cost: { input: 0, output: 0 } },
      ],
    },
  },
  {
    id: "opencode-go",
    name: "OpenCode Go",
    apis: {
      "anthropic-messages": "https://opencode.ai/zen/go",
      "openai-responses": "https://opencode.ai/zen/go/v1",
      "openai-completions": "https://opencode.ai/zen/go/v1",
    },
    env: ["OPENCODE_API_KEY"],
  },
  { id: "xai", name: "xAI", apis: { "openai-responses": "https://api.x.ai/v1" }, env: ["XAI_API_KEY"] },
  {
    id: "github-copilot",
    name: "GitHub Copilot",
    // A signed-in account's requests go to the host its token names (`copilot.ts`).
    apis: {
      "anthropic-messages": "https://api.githubcopilot.com",
      "openai-responses": "https://api.githubcopilot.com",
      "openai-completions": "https://api.githubcopilot.com",
    },
    env: [],
    keyLogin: false,
  },
  {
    id: "kimi-coding",
    name: "Kimi Code",
    catalog: "kimi-code-plan-cn",
    apis: { "openai-completions": "https://api.kimi.com/coding/v1" },
    env: ["KIMI_API_KEY"],
  },
  { id: "meta", name: "Meta", apis: { "openai-responses": "https://api.meta.ai/v1" }, env: ["META_API_KEY"] },
  // Classifiers only: no chat models, and none in models.dev's catalog.
  {
    id: "typesafe",
    name: "TypeSafe",
    apis: {},
    env: ["TYPESAFE_API_KEY"],
    classifiers: {
      api: "typesafe-system-one",
      baseUrl: "https://api.typesafe.ai/v1",
      models: [{ id: "jev-latest", name: "Jev", input: ["text"], contextWindow: 64_000, cost: { input: 0, output: 0 } }],
    },
  },
];
