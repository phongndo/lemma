import type { WireApi } from "./model.ts";

/** A built-in provider's endpoints: where it serves which protocol, and the environment variables its key is read from. */
export interface Endpoint {
  readonly id: string;
  readonly name: string;
  /** The base URL of each wire API it serves its models on; its catalog leaves out a model on any other. */
  readonly apis: Readonly<Partial<Record<WireApi, string>>>;
  readonly env: readonly string[];
}

/** The providers this plugin knows. Their models are models.dev's provider of the same id. */
export const ENDPOINTS: readonly Endpoint[] = [
  { id: "anthropic", name: "Anthropic", apis: { "anthropic-messages": "https://api.anthropic.com" }, env: ["ANTHROPIC_API_KEY"] },
  { id: "openai", name: "OpenAI", apis: { "openai-responses": "https://api.openai.com/v1" }, env: ["OPENAI_API_KEY"] },
  { id: "openrouter", name: "OpenRouter", apis: { "openai-completions": "https://openrouter.ai/api/v1" }, env: ["OPENROUTER_API_KEY"] },
  {
    id: "opencode",
    name: "OpenCode Zen",
    apis: {
      "anthropic-messages": "https://opencode.ai/zen",
      "openai-responses": "https://opencode.ai/zen/v1",
      "openai-completions": "https://opencode.ai/zen/v1",
    },
    env: ["OPENCODE_API_KEY"],
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
];
