# @lemma/plugin-llm-pi-ai

Provides `Llm` (plugin id `llm`). Requires `Credentials`, `Interaction`, `HostControl`, and `Paths`.

Lemma owns the providers and their logins; [`@earendil-works/pi-ai`](https://github.com/earendil-works/pi) only sends requests (its wire APIs, called with the token Lemma resolves) and supplies the built-in model lists. The built-in providers:

| Provider     | Id            | Login                | Environment        | Models                   |
| ------------ | ------------- | -------------------- | ------------------ | ------------------------ |
| OpenAI       | `openai`      | Sign in with ChatGPT |                    | The ChatGPT plan's       |
| OpenAI API   | `openai-api`  | API key              | `OPENAI_API_KEY`   | The ones the key can use |
| OpenCode Zen | `opencode`    | API key              | `OPENCODE_API_KEY` | OpenCode Zen's           |
| OpenCode Go  | `opencode-go` | API key              | `OPENCODE_API_KEY` | OpenCode Go's            |

A credential stored by `/login` wins; without one, the provider's environment variable. One OpenCode key serves Zen and Go. OpenAI is two providers because a plan and a key serve different models and bill differently, and both can be set up at once.

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

The web app's Providers page adds and removes these rows; a key typed there is
stored with `/login`, and the row reads `<ID>_API_KEY` instead of holding it. A
custom provider needs `id` (no `/`), `api`, `baseUrl`, and `models`, and one
with a built-in's id replaces it. `api` is one of pi-ai's wire APIs
(`openai-completions`, `openai-responses`, `anthropic-messages`, …). Model
fields default as in pi's `models.json`, and `compat` and `thinkingLevelMap`
pass through to pi-ai unchanged; see pi-ai's "OpenAI Compatibility Settings".

Without an `apiKey`, a custom provider counts as configured and sends a
placeholder key, because the OpenAI SDKs refuse an empty one and local servers
ignore it. An `apiKey.env` that is unset leaves the provider unconfigured until
`/login` stores a key.

## Behavior

- **Models.** Refs are `<provider>/<id>`; an unknown ref fails `UnknownModel`
  before any request. A request's `thinking` is clamped to the levels the model
  supports, and `"off"` sends no reasoning option.
- **Requests** run `LlmRequestHook` around the provider and send through
  pi-ai's `streamSimple` with the token Lemma resolves. Missing auth, or a
  sign-in that cannot be renewed, ends the stream with an `error` event saying
  what to do (`/login <provider>`). Providers see `User-Agent: lemma (…)`
  unless a model sets its own.
- **Sign-ins** are renewed shortly before they expire, under the credentials
  lock, so concurrent requests and processes renew once. `logout` revokes the
  sign-in where the provider allows; when it cannot confirm, a warning says to
  end the session in the account's settings.
- **Sign in with ChatGPT** follows OpenAI's
  [flow for open-source apps](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
  and lists every model the plan's list offers, with the plan's context
  windows, as the Codex app does. Until the plan's list is read, the
  list is the models pi-ai knows plans serve, never the API's. The first sign-in
  registers a client named Lemma, kept in `<home>/chatgpt.json` so signing in
  again reuses it; delete that file to register anew. From a host on another
  machine, paste the address the browser ends on. [`src/chatgpt.ts`](src/chatgpt.ts)
  documents the checks.
- **Live model lists** (`liveCatalogs`, default on; off, every list stays
  pi-ai's). At startup, hourly, and after a login or logout,
  [models.dev](https://models.dev) decides which built-in models are current,
  and models the provider serves that pi-ai does not know are added. A model
  keeps pi-ai's request settings and takes its limits and prices from
  models.dev, which follows the provider's docs more closely than a pi-ai
  release can. Only models an agent can work with are listed: ones that call
  tools and answer in text, so embedding, image, and realtime models are left
  out. The OpenAI API lists only what its key can use (`/v1/models`). Without
  models.dev a provider keeps pi-ai's list. A change publishes `ModelsChanged`.
- **The OpenAI API speaks to pi-ai as `openai`**, the id pi-ai shapes OpenAI's
  requests for, while Lemma lists and logs it as `openai-api`.

## Testing

`makeLlmPlugin({ providers, env, fetch })` replaces the built-in providers, the environment read for API keys, and the network. Tests send through pi-ai's `fauxProvider` (a provider's `stream`) and isolate themselves from the developer's keys. `chatgptSignIn({ home, fetch })` runs against a fake auth server, with the real loopback callback.
