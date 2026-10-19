# llm.http

Provides `Llm` (`@lemma/llm`) by speaking providers' HTTP APIs itself, with `fetch` and no provider SDK, and serves its `llm.*` channels to clients (`LlmChannels`, through `serveLlm` from [the contract](../contract/src/llm.ts), which a replacement uses as well). Requires `Credentials`, `Interaction`, `HostControl`, and `Paths`.

It speaks three wire protocols: `anthropic-messages` (Anthropic's Messages API), `openai-responses` (OpenAI's Responses API), and `openai-completions` (Chat Completions, which most other servers copy). Its built-in providers:

| Provider           | Protocols                  | Login                                               |
| ------------------ | -------------------------- | --------------------------------------------------- |
| `anthropic`        | Anthropic                  | API key (`ANTHROPIC_API_KEY`)                       |
| `openai`           | Responses                  | API key (`OPENAI_API_KEY`), or Sign in with ChatGPT |
| `openrouter`       | Chat Completions           | API key (`OPENROUTER_API_KEY`)                      |
| `opencode` (Zen)   | Anthropic, Responses, Chat | API key (`OPENCODE_API_KEY`)                        |
| `opencode-go` (Go) | Anthropic, Responses, Chat | API key (`OPENCODE_API_KEY`)                        |

Any server on one of the three protocols is added as a provider of the user's (below): Ollama, LM Studio, vLLM, a company gateway, another vendor's OpenAI-compatible API. Auth resolves in this order: a credential stored by `/login`, then the config's key, then the provider's environment variable; a provider of the user's without an `apiKey` needs none.

It serves no classifiers or image models: `classifiers` and `imageModels` list none, and `classify` and `generateImages` fail `UnknownModel`. Anthropic's subscription sign-in (Claude Pro/Max) is not offered.

## Config

All fields are optional.

```jsonc
{
  "plugins": {
    "llm.http": {
      "config": {
        "include": ["anthropic", "openai"], // built-ins to register; default all
        "exclude": ["openrouter"], // built-ins to leave out
        "liveCatalogs": true, // read the models built-ins serve from models.dev every hour; false keeps this version's lists (a ChatGPT sign-in still lists its plan's)
        "streamTimeout": 300, // seconds a response may send nothing, not even a keep-alive, before it fails as stalled; 0 waits forever
        "cacheRetention": "short", // or "long": providers keep the prompt cache an hour where offered
        "providerEvents": false, // publish each provider stream event as sent (LlmProviderStreamEvent), for debugging
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

The web app's Providers page adds and removes these rows for you (through the host's `add`/`remove` config edits, which never read the list back); a key typed there is stored with `/login`, and the row reads `<ID>_API_KEY` instead of holding it. A provider of the user's needs `id` (no `/`), `api` (one of the three protocols; one on another is left out, with a warning), `baseUrl`, and `models`; one with a built-in's id replaces it. An Anthropic `baseUrl` leaves out `/v1` (`https://api.anthropic.com`); the others include it. Model defaults: `name` = `id`, `reasoning: false`, `input: ["text"]`, 128k context, 16,384 output tokens, zero cost (USD per million tokens). A reasoning model's `thinkingLevelMap` gives a level's value as the server names it (`"xhigh": "xhigh"`), or `null` for one it lacks; Anthropic's protocol thinks in a token budget, the others name an effort.

`compat` (provider-wide, overridden per model field by field) tells a Chat Completions server's differences, by the names pi's configs use: `supportsDeveloperRole`, `supportsStore`, `supportsReasoningEffort`, `maxTokensField` (`max_tokens` or `max_completion_tokens`), `thinkingFormat` (`openai`'s `reasoning_effort`, `openrouter`'s `reasoning` object, or `deepseek`'s `thinking` switch), `requiresReasoningContentOnAssistantMessages`, `cacheControlFormat: "anthropic"`, and `supportsUsageInStreaming`. Other fields are ignored. Unset, they are detected from the server: OpenRouter, OpenCode, and DeepSeek have their own; any other is taken to be OpenAI's.

A plugin adds a provider of the same shape to the contract's `Providers` registry (`owner.add(Providers, { id, api, baseUrl, models })`), and it is served while that plugin runs, listed with `from` naming the plugin. One on another protocol, or whose id a built-in or the user's provider has, is left out with a warning.

## Behavior

- Model refs are `<provider>/<id>`. An unknown ref fails with `LlmError` `UnknownModel` before any request.
- **Catalogs.** A built-in's models are [models.dev](https://models.dev)'s for that provider, on the protocols it serves: their limits, prices, inputs, whether they take a temperature, and how they think. `src/catalog.json` is the snapshot this version serves first (and offline); `node domains/llm/http/scripts/catalog.ts`, then `pnpm format`, refreshes it. With `liveCatalogs` on, models.dev is read at startup, every hour, and after a login or logout (read at most once an hour), and each built-in's list becomes what it lists now; out of reach, the list stands. A model without tool calls, or that makes no text, is left out. A refresh that changed the models publishes `ModelsChanged`, and so does every login and logout once its refresh is done, since what is configured and available has; clients hear it as `models-changed` on `llm.changes`.
- **Thinking levels.** A model's `thinkingLevels` are the efforts models.dev lists for it (`none` as `off`); an Anthropic model with a `max` effort thinks adaptively at the effort asked, and its others (and models on its protocol with a token budget) think in 1k to 16k tokens, from `minimal` to `high`, on top of the answer's own limit. A request's `thinking` is clamped to the model's levels, the nearest above first; absent, it is `off`. Off, an adaptive model is sent no thinking (one that always thinks would refuse it turned off), a budget model `thinking: disabled`, and an effort model its `none` where it has one. `thinkingFrom` leaves out the thinking made under another prefix for the adaptive models, which bind thinking to it.
- **History.** Each request is sent as its model can take it back: another model's thinking as text and its tool call ids as the protocol takes them; an answer that failed or was stopped left out; a tool call without a result given one saying so; images replaced by a placeholder for a model that takes none. A model's own opaque state goes back as it came: Anthropic's thinking signatures, OpenAI's encrypted reasoning items (requests are stateless, `store: false`) and message ids, and the reasoning fields and details a Chat Completions server streamed.
- **Tools.** A tool's input schema goes as it is, but to Anthropic, which refuses a union (`anyOf`, `oneOf`, `allOf`) at a schema's root: there the union is left out, its object's own properties kept.
- `stream` runs `LlmRequestHook` around the request (the contract's `streamThroughHook`): a handler that hands `next` a changed request fails the stream with `LlmError` `Hook`, naming it, and nothing is sent. Interrupting the stream aborts the provider request. Every stream starts with `start` and ends with exactly one `done` or `error`. When a provider cannot authenticate, the stream is `start` and an `error` telling the user to run `/login <provider>`; it does not throw.
- **Failures.** A refused request is asked again twice, before a response starts, where provider SDKs would (a 408, 409, 429, or 5xx, or a lost connection), waiting the delay the provider names (`retry-after-ms`, `Retry-After`) up to a minute, else backing off. What still fails ends with an `error` event carrying `failure` (`LlmFailure`): `overflow` when the provider says the request is too long for the context window; by HTTP status when it refused the request (a 429 `rate-limit`, with `retryAfterMs` when it asked for a longer wait than a minute; a 408, 409, or 5xx `transient`; another 4xx `fatal`, as is a quota or billing limit); by its wording when it failed mid-answer (overloaded, a server error, a lost connection, a stream that ended early: `transient`). A gateway's word for its provider's failure keeps what the provider said (OpenRouter's `metadata.raw`), so an overflow behind it is one. What cannot be told to pass is `fatal`. Callers retry the rest (the agent does).
- **Silent overflow.** A response cut off at its output limit having said nothing, its input filling the context window, ends as an `overflow` failure: some providers cut a request too long to fit instead of refusing it.
- **Stalls.** A response that sends nothing for `streamTimeout` seconds (its first bytes, or the next) ends at once as a `transient` failure, and its request is aborted: a half-open connection would otherwise hold a turn forever. Whatever arrives counts, a ping or a keep-alive comment as much as model output, so a model thinking in silence on a connection its provider keeps alive is not cut off.
- **Prompt cache.** Anthropic's protocol gets cache breakpoints on the system prompt, the last tool, and the last user turn, an hour long with `cacheRetention: "long"`; so do Anthropic's models behind OpenRouter. OpenAI's Responses API gets the session as its `prompt_cache_key`, kept a day with `long`.
- **What plugins add to a request.** Its headers run through `LlmProviderHeadersHook` (the model's own, the provider's, Lemma's `User-Agent`, then what handlers add, change, or drop), and go over the protocol's own, so a handler can replace even the key. `providerOptions` passes on `temperature` (not to a model that refuses one, nor to Anthropic with thinking on), `samplingParams` (merged into a Responses or Chat Completions body), and `metadata` (its `user_id` to Anthropic). When the provider answers with a response it streams, the stream's `provider` event says its status, its request id (`request-id`, `x-request-id`, and the like), and which plugin changed which header, and `LlmProviderResponse` publishes its status and headers; a refusal is the `error` event's, after a `provider` event that says only who changed which header.
- Providers see Lemma: requests send `User-Agent: lemma (<os> <release>; <arch>)`, unless the model sets its own. OpenCode routes a conversation by its session, sent as `x-opencode-session`; OpenRouter is sent it as `x-session-id`.
- **Logins.** `login(provider, "api_key")` asks for the key with `Interaction.ask` (masked) and stores it. `login("openai", "oauth")` signs in with ChatGPT: it publishes the sign-in link as a `sign-in` notice, waits for the browser's callback on `http://127.0.0.1:1455/auth/callback` while asking, as a `sign-in-code` question, for the redirect URL to be pasted instead, withdraws whichever loses, and stores the token with the client id OpenAI issued. The installation is named by its device ID, `<home>/device-id`, a UUID made on first use and kept, since OpenAI expects the same one at every login. A token that has expired is refreshed before a request, under the credential's lock (`Credentials.modify`), so two requests never refresh it twice; one that cannot be refreshed fails the request, telling the user to sign in again. Questions and notices carry the caller's `InteractionOrigin` (`login:<provider>` from `llm.login`), so a client shows them together; a login that fails or is cancelled publishes an `ended` notice. Once the credential is stored, `login` returns; the catalog refresh, `ModelsChanged`, and the `signed-in` notice that follow run in the plugin's scope, so cancelling the login then cannot report a stored credential as cancelled. A dismissed question fails with `Cancelled`, and other failures with `LoginFailed` and the reason.
- **Logins from clients.** `llm.login` runs the login in this plugin's scope, not the call's: a client that reloads or drops its connection mid-login leaves it running, its question waiting for a client to answer, and a second call for the same provider and type joins it, while one of the other type fails `Busy`. `llm.cancel-login` stops it from any client, withdrawing its question; every call waiting on it fails `Cancelled`. A login still running when the plugin stops ends with it, and a client waiting on it gets `Withdrawn` as the plugin starts stopping: calling again on the replacement starts another.
- OpenAI signed in with ChatGPT lists the plan's models, as the Codex CLI and app do, rather than the API's, which a plan does not all serve. They come from `GET https://api.openai.com/v1/models` with the sign-in's token: the models it lists for pickers (`visibility: "list"`) that the API serves, in its order, asked as a client newer than any (the list hides models newer than the Codex client it is told of). A model the API catalog has keeps its entry; one it does not is served like the known model with the nearest id. When the list cannot be read, the one from the last refresh stands; with an API key, or signed out, the API's list returns. Signed in with ChatGPT, requests leave out what the plan refuses (`max_output_tokens`, `temperature`, `prompt_cache_retention`), and a failure for its usage limit says where to check it.
- Stored credentials keep the shapes earlier versions of Lemma wrote (`api_key` with `key`; `oauth` with `access`, `refresh`, `expires`, and the provider's fields), as do the opaque parts of logged answers (a Responses tool call's id is `<call_id>|<item_id>`, a text block's signature its message item's id and phase, a thinking block's the reasoning item or the field it streamed in), so existing logins and sessions keep working.

## Testing

`makeLlmPlugin({ providers, env, fetch })` replaces the built-in provider list, the environment keys are read from, and how requests, sign-ins, and catalogs are fetched. Tests serve their own providers from a scripted `fetch` that answers with server-sent events, and keep catalogs offline. The plugin runs the `Llm` contract's suite, [`llmConformance`](../../../packages/testing/README.md#conformance-suites).
