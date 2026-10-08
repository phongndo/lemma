# @lemma/plugin-llm-pi-ai

Provides `Llm` (plugin id `llm`) by wrapping [`@earendil-works/pi-ai`](https://github.com/earendil-works/pi), and serves its `llm.*` channels to clients (`llmChannels` in [the contract](../../packages/contracts/src/llm.ts)). Requires `Credentials`, `Interaction`, `HostControl`, and `Paths`.

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
        "streamTimeout": 300, // seconds a response may send nothing before it fails as stalled; 0 waits forever
        "cacheRetention": "short", // or "long": providers keep the prompt cache an hour where offered
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
- **Failures.** pi-ai asks a failing provider again itself, twice, before a response starts, where its SDK would (a 408, 409, 429, or 5xx, or a lost connection), waiting the delay the provider names (`Retry-After`) up to a minute; pi-ai makes none unless asked, and reads no `Retry-After` without them. What still fails ends with an `error` event carrying `failure` (`LlmFailure`), from pi-ai's classifiers over the provider's wording, as pi reports failures as text: `overflow` when `isContextOverflow` matches; `fatal` for a leading 4xx status other than those (a request at fault, which pi's test, finding a status anywhere in the text, could take for a 5xx) and a request over a per-minute token limit; `transient` for Node's connection errors (`ECONNRESET`, `ETIMEDOUT`, …), which pi's test misses; else `transient`, or `rate-limit` when the text says so, when `isRetryableAssistantError` says asking again can help (with `retryAfterMs` when the provider asked for a longer wait than pi-ai sits out), and `fatal` otherwise (authentication, quota and billing limits). Callers retry the rest (the agent does).
- **Silent overflow.** A response cut off at its output limit having said nothing, its input filling the context window, ends as an `overflow` failure: some providers cut a request too long to fit instead of refusing it. pi-ai also counts a finished answer whose input exceeds the window, but that one is kept, as a wrong window in a model's metadata would turn good answers into failures.
- **Stalls.** A response that sends nothing for `streamTimeout` seconds (its first event, or the next) ends at once as a `transient` failure, and its request is aborted: a half-open connection would otherwise hold a turn forever.
- **Prompt cache.** `cacheRetention` goes to pi-ai, which maps it to each provider's cache lifetime. `long` (Anthropic's hour, where offered) suits turns whose tool calls outlast the short lifetime of about five minutes, at a higher price for writing the cache.
- `login(provider, type)` runs the provider's pi-ai flow. Text, secret, and paste-the-code prompts become `Interaction.ask` (secret prompts are masked), and choices become `Interaction.select`. A prompt the flow abandons, such as a paste prompt that loses the race to the local callback server, is withdrawn by interrupting the question. Auth URLs, device codes, and progress are published as `Notice` events, with their `kind` (`sign-in`, `device-code`, `progress`; a flow's other notices, such as documentation links, have none), and a paste-the-code prompt is asked with `kind: "sign-in-code"`, so clients never infer either from the order of events. Its questions and notices carry the caller's `InteractionOrigin` (`login:<provider>` from `llm.login`), so a client shows them together; pi-ai calls back outside the login's fiber, so the plugin carries the origin rather than letting the prompts inherit it. A login that fails or is cancelled publishes an `ended` notice. Once the credential is stored, `login` returns; the catalog refresh and the `signed-in` notice that follows it run in the plugin's scope, so cancelling the login then cannot report a stored credential as cancelled. A dismissed prompt fails with `Cancelled`, and other failures with `LoginFailed` and the provider's message. A flow that names the installation (OpenAI's ChatGPT sign-in) gets its device ID from `<home>/device-id`, a UUID made on first use and kept, since the provider expects the same one at every login.
- **Logins from clients.** `llm.login` runs the login in this plugin's scope, not the call's: a client that reloads or drops its connection mid-login leaves it running, its question waiting for a client to answer, and a second call for the same provider joins it. `llm.cancel-login` stops it from any client, withdrawing its question; every call waiting on it fails `Cancelled`. A login still running when the plugin stops ends with it.
- Providers see Lemma, not pi. Model requests send `User-Agent: lemma (<os> <release>; <arch>)` in place of pi-ai's `pi (…)`, unless the model sets its own (GitHub Copilot's models name Copilot Chat, as Copilot requires); the plugin's own catalog requests send it too.
- Anthropic's subscription OAuth (Claude Pro/Max) is excluded by policy, so Anthropic accepts API keys only. The other OAuth providers stay.
- pi-ai's `openai-codex` (ChatGPT sign-in through the Codex backend) is left out by default: pi-ai calls it legacy now that `openai` signs in with ChatGPT itself, and two OpenAI sign-ins would only ask which. Its login is not `openai`'s (another OAuth client, a token for `api.openai.com`), so moving over means signing in again.
- Built-in providers' model lists are live (`liveCatalogs`, default on). On refresh, at startup, every hour, and after a login (which waits for it before announcing itself, so clients listing models then see all of them) or logout, [models.dev](https://models.dev) decides which models are current: pi-ai's lists are generated from it, so a model it no longer lists has been retired and is hidden, even where the provider's own `/models` still names it. Current models pi-ai does not know are added: the ones the provider's OpenAI-style `/models` lists (asked with its key, then without, as OpenCode's refuses keys), or all of models.dev's when it has no such list. An added model is served like a known model on the same wire API; its request settings come from the same model at another built-in provider, else the known model with the nearest id, and its limits, prices, and inputs from models.dev. Without models.dev a provider keeps pi-ai's list. Radius keeps its own dynamic catalog. models.dev is read at most once an hour; catalogs are in memory only. A refresh that changed the models publishes `ModelsChanged`, which clients hear as `models-changed` on `llm.changes`.
- OpenAI signed in with ChatGPT lists the plan's models, as the Codex CLI and app do, rather than the API's (o1, gpt-4o, and the rest, which a plan does not serve). They come from `GET https://api.openai.com/v1/models` with the sign-in's token: the models it lists for pickers (`visibility: "list"`) that the API serves, in its order. It hides models newer than the Codex client it is told of, so Lemma asks as a client newer than any. A model pi-ai knows keeps pi-ai's entry; one it does not is served like the known model with the nearest id, named and sized by the list. When the list cannot be read, the one from the last refresh stands; with an API key, or signed out, the API's list returns.
- On disposal the plugin calls pi-ai's `cleanupSessionResources()`, releasing pooled Codex websockets so the process can exit. This cleanup is process-global in pi-ai.

## Testing

`makeLlmPlugin({ providers, authContext, fetch })` replaces the built-in provider list, the environment used for auth, and how live catalogs are fetched. Tests use it to register pi-ai's `fauxProvider`, isolate themselves from the developer's API keys, and keep catalogs offline.
