# @lemma/plugin-llm-pi-ai

Provides `Llm` (plugin id `llm`) by wrapping [`@earendil-works/pi-ai`](https://github.com/earendil-works/pi). Requires `Credentials` and `Interaction`.

Every pi-ai built-in provider but the legacy OpenAI Codex is registered, with the logins pi-ai offers: OpenAI (API key, or signing in with a ChatGPT plan), Anthropic (API keys only), Google, Vertex, Bedrock, Mistral, Groq, xAI, OpenRouter, GitHub Copilot, OpenCode Zen and Go, and the rest. Auth resolves the way pi does: a credential stored by `/login` wins, then the provider's environment variables or ambient config (AWS profiles, gcloud ADC).

## Config

All fields are optional.

```jsonc
{
  "plugins": {
    "llm": {
      "config": {
        "include": ["anthropic", "openai", "openrouter"], // built-ins to register; default all
        "exclude": ["amazon-bedrock"], // default ["openai-codex"]; [] registers it too
        "liveCatalogs": true, // list the models providers serve now (see Behavior); false keeps pi-ai's lists
        "providers": [
          // Keyless local server: no apiKey.
          {
            "id": "ollama",
            "api": "openai-completions",
            "baseUrl": "http://localhost:11434/v1",
            "compat": { "supportsDeveloperRole": false, "supportsReasoningEffort": false },
            "models": [{ "id": "qwen3:8b", "reasoning": true }],
          },
          // Authenticated proxy: key from the environment (or `"value"`), or stored via /login.
          {
            "id": "gateway",
            "name": "Company gateway",
            "api": "openai-responses",
            "baseUrl": "https://llm.example.com/v1",
            "apiKey": { "env": "GATEWAY_API_KEY" },
            "headers": { "X-Team": "agents" },
            "models": [{ "id": "gpt-5", "input": ["text", "image"], "contextWindow": 400000, "maxTokens": 128000 }],
          },
        ],
      },
    },
  },
}
```

The web app's Providers page adds and removes these rows for you (through the host's `add`/`remove` config edits, which never read the list back); a key typed there is stored with `/login`, and the row reads `<ID>_API_KEY` instead of holding it. A custom provider needs `id` (no `/`), `api`, `baseUrl`, and `models`. `api` is one of pi-ai's wire APIs: `openai-completions`, `openai-responses`, `openai-codex-responses`, `azure-openai-responses`, `anthropic-messages`, `google-generative-ai`, `google-vertex`, `mistral-conversations`, `bedrock-converse-stream`, `pi-messages`. Model defaults follow pi's `models.json`: `name` = `id`, `reasoning: false`, `input: ["text"]`, 128k context, 16,384 output tokens, zero cost (USD per million tokens). `compat` (provider-wide, overridden per model field by field) and `thinkingLevelMap` are passed through to pi-ai unchanged; see pi-ai's "OpenAI Compatibility Settings". A custom provider with the id of a built-in replaces it.

Without an `apiKey`, a custom provider counts as configured and sends a placeholder key, because the OpenAI SDKs refuse an empty one and local servers ignore it. A configured `apiKey.env` that is unset leaves the provider unconfigured until `/login` stores a key.

## Behavior

- Model refs are `<provider>/<id>`. An unknown ref fails with `LlmError` `UnknownModel` before any request. `thinkingLevels` come from pi-ai's `getSupportedThinkingLevels`, without pi's `max` (the contract has no equivalent). A request's `thinking` is clamped to the model's supported levels, and `"off"` sends no reasoning option.
- `stream` runs `LlmRequestHook` around pi-ai's `streamSimple`. Interrupting the stream aborts the provider request. The plugin enforces the `StreamEvent` protocol even where pi-ai does not: it adds a `start` event when setup fails before one, emits exactly one `done`/`error`, and rebuilds the final message without pi-only fields such as diagnostics. pi's `pending` and `deferred` stop reasons become `error`. When auth is missing, the plugin returns an `error` event telling the user to run `/login <provider>`. It does not throw.
- `login(provider, type)` runs the provider's pi-ai flow. Text, secret, and paste-the-code prompts become `Interaction.ask` (secret prompts are masked), and choices become `Interaction.select`. A prompt the flow abandons, such as a paste prompt that loses the race to the local callback server, is withdrawn by interrupting the question. Auth URLs, device codes, and progress are published as `Notice` events. A dismissed prompt fails with `Cancelled`, and other failures with `LoginFailed` and the provider's message.
- Anthropic's subscription OAuth (Claude Pro/Max) is excluded by policy, so Anthropic accepts API keys only. The other OAuth providers stay.
- pi-ai's `openai-codex` (ChatGPT sign-in through the Codex backend) is left out by default: pi-ai calls it legacy now that `openai` signs in with ChatGPT itself, and two OpenAI sign-ins would only ask which. Its login is not `openai`'s (another OAuth client, a token for `api.openai.com`), so moving over means signing in again.
- Built-in providers' model lists are live (`liveCatalogs`, default on). On refresh, at startup and after a login (which waits for it before announcing itself, so clients listing models then see all of them), [models.dev](https://models.dev) decides which models are current: pi-ai's lists are generated from it, so a model it no longer lists has been retired and is hidden, even where the provider's own `/models` still names it. Current models pi-ai does not know are added: the ones the provider's OpenAI-style `/models` lists (asked with its key, then without, as OpenCode's refuses keys), or all of models.dev's when it has no such list. An added model is served like a known model on the same wire API; its request settings come from the same model at another built-in provider, else the known model with the nearest id, and its limits, prices, and inputs from models.dev. Without models.dev a provider keeps pi-ai's list. Radius keeps its own dynamic catalog. models.dev is read at most once an hour; catalogs are in memory only.
- On disposal the plugin calls pi-ai's `cleanupSessionResources()`, releasing pooled Codex websockets so the process can exit. This cleanup is process-global in pi-ai.

## Testing

`makeLlmPlugin({ providers, authContext })` replaces the built-in provider list and the environment used for auth. Tests use it to register pi-ai's `fauxProvider` and isolate themselves from the developer's API keys.
