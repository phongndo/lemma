# @lemma/plugin-llm-pi-ai

Provides `Llm` (plugin id `llm`). Requires `Credentials`, `Interaction`, `HostControl`, and `Paths`.

Lemma owns the providers and their logins; [`@earendil-works/pi-ai`](https://github.com/earendil-works/pi) only sends requests (its wire APIs, called with the token Lemma resolves) and supplies the built-in model lists. The built-in providers:

| Provider     | Id            | Logins                                  | Environment        |
| ------------ | ------------- | --------------------------------------- | ------------------ |
| OpenAI       | `openai`      | API key, or Sign in with ChatGPT (plan) | `OPENAI_API_KEY`   |
| OpenCode Zen | `opencode`    | API key                                 | `OPENCODE_API_KEY` |
| OpenCode Go  | `opencode-go` | API key                                 | `OPENCODE_API_KEY` |

A credential stored by `/login` wins, whatever its type; without one, the provider's environment variable. One OpenCode key serves Zen and Go.

## Config

All fields are optional.

```jsonc
{
  "plugins": {
    "llm": {
      "config": {
        "include": ["openai", "opencode"], // built-ins to offer; default all
        "exclude": ["opencode-go"], // built-ins to leave out
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
- `stream` runs `LlmRequestHook` around the provider. The plugin resolves the provider's token, then sends through pi-ai's `streamSimple` for the model's wire API with that token. Interrupting the stream aborts the provider request. The plugin enforces the `StreamEvent` protocol even where pi-ai does not: it adds a `start` event when setup fails before one, emits exactly one `done`/`error`, and rebuilds the final message without pi-only fields such as diagnostics. pi's `pending` and `deferred` stop reasons become `error`. When auth is missing, or a sign-in cannot be renewed, the plugin returns an `error` event saying what to do (`/login <provider>`). It does not throw. OpenCode requests carry the session id in `x-opencode-session`, which OpenCode routes a conversation by.
- Auth is the plugin's own (`src/auth.ts`): `token(provider)` for requests, `status(provider)` for listing (no network), `login`, and `logout`. A provider declares how it authenticates: an API key login, a browser sign-in (`login`, `refresh`, `revoke`), and its environment variables. A stored API key entry without a key counts as nothing stored. A sign-in within five minutes of expiring is renewed before the request, under the credentials lock, re-checked there so concurrent requests and processes renew it once, and not interrupted, so a rotated refresh token is never lost. When renewing fails, a token that has not expired is still sent. A provider may name a time before which not to renew (`earliestRefreshAt`); until then a token that has not expired stands. `logout` revokes, under the lock, the sign-in stored then (not one a renewal has since replaced), then forgets it; when the provider cannot confirm, or the entry cannot be read, it is forgotten anyway and a warning `Notice` says to end the session in the account's settings.
- `login(provider, type)` asks for an API key through `Interaction.ask` (masked), or runs the sign-in. A model's configured headers are sent with every request, merged with Lemma's (later names win, whatever their case), since some wire APIs (`pi-messages`, Bedrock) send only the request's. A sign-in's links are published as `Notice` events, and a prompt it abandons (a paste prompt that loses the race to the browser's return) is withdrawn by interrupting the question. A dismissed prompt fails with `Cancelled`, and other failures with `LoginFailed` and the provider's message.
- Sign in with ChatGPT follows OpenAI's flow for open-source apps ([sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)), not the legacy Codex one: a public client with PKCE, whose token calls the Responses API at `api.openai.com` on the user's ChatGPT plan (`chatgpt.tokens.use.direct`, which the grant must include). The first sign-in registers a client named Lemma (`client_id=dynamic_agent_client`, `agent_name_hint=Lemma`); the issued client is kept in `<home>/chatgpt.json` with its account, past logout, so signing in again reuses it (with `login_hint`) rather than registering another. The installation is named by `ext_agent_host_id`, from `<home>/device-id`, a UUID made on first use and kept. The browser returns to `http://127.0.0.1:<free port>/auth/callback`, which answers nothing else (another path or host name, a request target that is not an address, another sign-in's state); from a host on another machine, the user pastes the address the browser ended on instead, and an address that is not this sign-in's asks again. The ID token's issuer, audience, authorized party, nonce, and expiry are checked, not its signature: it comes straight from the token endpoint over TLS, which OpenID Connect accepts in place of one (OpenAI's guide also checks it against its JWKS). A client belongs to one account: a sign-in that returns another account's tokens is refused, its tokens revoked, and the next sign-in registers anew. A sign-in that did not allow plan use fails, and the next one asks for consent again (`prompt=consent`). A client OpenAI no longer knows (`invalid_client`, as after removing Lemma from ChatGPT's settings) is forgotten, so the next sign-in registers anew; deleting `<home>/chatgpt.json` does the same by hand. Only a renewal the auth server refuses (HTTP 400 or 401) says to sign in again; other failures leave the next request to try again. A ChatGPT login made by pi-ai keeps working, renewed with its own client, which is registered under the name Pi until the next sign-in.
- Providers see Lemma, not pi. Model requests send `User-Agent: lemma (<os> <release>; <arch>)` in place of pi-ai's `pi (…)`, unless the model sets its own (a custom provider's `headers` may); the plugin's catalog and sign-in requests send it too.
- Built-in providers' model lists are live (`liveCatalogs`, default on). On refresh, at startup, every hour, and after a login (which waits for it before announcing itself, so clients listing models then see all of them) or logout, [models.dev](https://models.dev) decides which models are current: pi-ai's lists are generated from it, so a model it no longer lists has been retired and is hidden, even where the provider's own `/models` still names it. Current models pi-ai does not know are added: the ones the provider's OpenAI-style `/models` lists (asked with its token, then without, as OpenCode's refuses keys), or all of models.dev's when it has no such list. An added model is served like a known model on the same wire API; its request settings come from the same model at another built-in provider, else the known model with the nearest id, and its limits, prices, and inputs from models.dev. Without models.dev a provider keeps pi-ai's list. models.dev is read at most once an hour; catalogs are in memory only; one refresh runs at a time, and a provider whose token cannot be had just now (a sign-in that could not be renewed) keeps its list rather than being refreshed as signed out. A login or logout waits up to 20 seconds for its provider's refresh, which otherwise finishes in the background. A refresh that changed the models publishes `ModelsChanged`, which the transport forwards to clients as `models-changed`.
- OpenAI signed in with ChatGPT lists the plan's models, as the Codex CLI and app do, rather than the API's (o1, gpt-4o, and the rest, which a plan does not serve). They come from `GET https://api.openai.com/v1/models` with the sign-in's token: the models it lists for pickers (`visibility: "list"`) that the API serves, in its order. It hides models newer than the Codex client it is told of, so Lemma asks as a client newer than any. A model pi-ai knows keeps pi-ai's entry; one it does not is served like the known model with the nearest id, named and sized by the list. When the list cannot be read, the one from the last refresh stands; with an API key, or signed out, the API's list returns.
- On disposal the plugin calls pi-ai's `cleanupSessionResources()`, releasing pooled websockets so the process can exit. This cleanup is process-global in pi-ai.

## Testing

`makeLlmPlugin({ providers, env, fetch })` replaces the built-in providers, the environment read for API keys, and the network. Tests send through pi-ai's `fauxProvider` (a provider's `stream`) and isolate themselves from the developer's keys. `chatgptSignIn({ home, fetch })` runs against a fake auth server, with the real loopback callback.
