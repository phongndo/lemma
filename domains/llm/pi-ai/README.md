# llm.pi-ai

Provides `Llm` (`@lemma/llm`) by wrapping
[`@earendil-works/pi-ai`](https://github.com/earendil-works/pi), and serves its
`llm.*` channels to clients (`LlmChannels`, through `serveLlm` from [the
contract](../contract/src/llm.ts), which a replacement uses as well).

Every pi-ai built-in provider but the legacy OpenAI Codex is registered, with
the logins pi-ai offers: OpenAI (API key, or signing in with a ChatGPT plan),
Anthropic (API keys only), Google, Vertex, Bedrock, Mistral, Groq, xAI,
OpenRouter, GitHub Copilot, OpenCode Zen and Go, and the rest. Auth resolves the
way pi does. A credential stored by a login (the Providers page, or
`lemma login`) wins. Then come the provider's environment variables or ambient
config (AWS profiles, gcloud ADC).

## Config

All fields are optional.

```jsonc
{
  "plugins": {
    "llm.pi-ai": {
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
          // Authenticated proxy: key from the environment (or `"value"`), or stored by a login.
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

The web app's Providers page adds and removes these rows for you, through the
host's `add`/`remove` config edits. A key typed there is stored as a login's,
and the row reads `<ID>_API_KEY` instead of holding it.

- A custom provider needs `id` (no `/`), `api`, `baseUrl`, and `models`.
- `api` is one of pi-ai's wire APIs: `openai-completions`, `openai-responses`,
  `openai-codex-responses`, `azure-openai-responses`, `anthropic-messages`,
  `google-generative-ai`, `google-vertex`, `mistral-conversations`,
  `bedrock-converse-stream`, `pi-messages`.
- Model defaults follow pi's `models.json`: `name` = `id`, `reasoning: false`,
  `input: ["text"]`, 128k context, 16,384 output tokens, zero cost (USD per
  million tokens).
- `compat` (provider-wide, overridden per model field by field) and
  `thinkingLevelMap` pass to pi-ai unchanged; see pi-ai's "OpenAI Compatibility
  Settings".
- A custom provider with the id of a built-in replaces it.

A plugin adds a provider of the same shape to the contract's `Providers`
registry (`owner.add(Providers, { id, api, baseUrl, models })`): a company's
gateway, or a local server that comes with its own plugin. It is served while
that plugin runs, listed with `from` naming the plugin. One whose `api` is not
among those above, or whose id a built-in or the user's provider has, is left
out with a warning.

Without an `apiKey`, a custom provider counts as configured and sends a
placeholder key, because the OpenAI SDKs refuse an empty one and local servers
ignore it. A configured `apiKey.env` that is unset leaves the provider
unconfigured until a login stores a key.

## Behavior

- **Model refs** are `<provider>/<id>`. An unknown ref fails with `LlmError`
  `UnknownModel` before any request. `thinkingLevels` are pi-ai's, without pi's
  `max`, which the contract has no equivalent of. A request's `thinking` is
  clamped to the model's levels, and `"off"` sends no reasoning option.
- **Azure** keeps the provider id `azure-openai-responses`, which pi-ai renamed
  `azure`, so stored credentials, `include`/`exclude`, and saved model refs keep
  working.
- **Streams.** `stream` runs `LlmRequestHook` around pi-ai's `streamSimple` (the
  contract's `streamThroughHook`). A handler that hands `next` a changed request
  fails the stream with `LlmError` `Hook`, and nothing is sent, as the request
  is what its caller logged. Interrupting the stream aborts the provider
  request. Every stream has a `start` event and exactly one `done` or `error`,
  even where pi-ai's does not. pi's `pending` and `deferred` stop reasons become
  `error`. Missing auth, or a sign-in whose refresh fails, is an `error` event
  saying how to connect again, never a throw.
- **Retries.** pi-ai asks a failing provider again twice before a response
  starts, on a 408, 409, 429, 5xx, or lost connection. It waits the delay the
  provider names (`Retry-After`), up to a minute. Callers retry the rest (the
  agent does).
- **Failures.** What still fails ends with an `error` event carrying `failure`
  (`LlmFailure`), classified from the provider's wording, since pi reports
  failures as text:
  - `overflow` when pi-ai's `isContextOverflow` matches;
  - `fatal` for a leading 4xx status other than those retried, and for a request
    over a per-minute token limit (pi's test, finding a status anywhere in the
    text, could take these for a 5xx);
  - `transient` for Node's connection errors (`ECONNRESET`, `ETIMEDOUT`, …),
    which pi's test misses;
  - `transient`, or `rate-limit` when the text says so, when
    `isRetryableAssistantError` says asking again can help, with `retryAfterMs`
    when the provider asked for a longer wait than pi-ai sits out;
  - `fatal` otherwise (authentication, quota and billing limits).
- **Silent overflow.** A response cut off at its output limit having said
  nothing, its input filling the context window, is an `overflow`: some
  providers cut a request too long to fit instead of refusing it. A finished
  answer whose input exceeds the window is kept, as a wrong window in a model's
  metadata would turn good answers into failures.
- **Stalls.** A response that sends nothing for `streamTimeout` seconds fails at
  once as `transient`, and its request is aborted. A half-open connection would
  otherwise hold a turn forever.
- **Prompt cache.** `cacheRetention: "long"` suits turns whose tool calls
  outlast the short cache lifetime of about five minutes. Writing that cache
  costs more.
- **Classifiers and image models.** `classifiers` and `imageModels` are pi-ai's
  lists, which `models` (chat only) leaves out, and a live catalog never adds
  to. TypeSafe's Jev (`typesafe/jev-latest`) takes `TYPESAFE_API_KEY` or
  `lemma login typesafe`. `classify` and `generateImages` answer a provider's
  failure, missing auth included, as an error result.
- **Requests.** A model request sends
  `User-Agent: lemma (<os> <release>; <arch>)` in place of pi-ai's `pi (…)`,
  unless the model sets its own (Copilot requires its models to name Copilot
  Chat). Its other headers are its provider's `headers`. `providerOptions` pass
  on `temperature`, `samplingParams` (merged into an OpenAI-compatible request's
  body), and `metadata`. The stream's `provider` event carries the response's
  status and request id.

### Logins

- **Sign-ins.** `login` runs the provider's pi-ai flow as its `SignIn`
  (`makeSignIns`), so every client sees its steps and the first to answer wins.
  A login that fails fails `LoginFailed` with the provider's message, and one
  cancelled fails `Cancelled`. The catalog refresh and the notice that follow a
  stored credential run in the plugin's scope, so cancelling then cannot report
  a stored credential as cancelled.
- **From clients.** `llm.login` runs in the plugin's scope, so a client that
  reloads or drops mid-login leaves it running. A second call for the same
  provider and type joins it, and one of the other type fails `Busy`.
  `llm.cancel-login` stops it from any client, and every call waiting on it
  fails `Cancelled`. A client waiting when the plugin stops gets `Withdrawn` at
  once.
- **The way in.** A flow offering a code for a browser elsewhere takes it
  without asking when the client said its browser is elsewhere
  (`LoginOptions.browser`). A browser said to be local may not be (an SSH port
  forward looks local), so then, as when unsaid, the person picks.
- **A key that works.** A key is checked against the provider's model list
  before it is stored (`keycheck.ts`). A refusal (a 401, or Gemini's 400) asks
  for the key again with the provider's reason. Anything else (a 403, no list, a
  network failure) takes the key unchecked, as a key restricted from listing
  models can still chat.
- **Who signed in.** `ProviderInfo.account` and `plan` come from the stored
  credential (`account.ts`). Its tokens' JWT claims are read without checking a
  signature, only to show.
- **A sign-in that stops working.** A refresh the provider refuses (a 400, 401,
  or 403, `invalid_grant`) sets `ProviderInfo.expired` and publishes
  `ModelsChanged` (`watchRefresh`). A refresh that works, or a new sign-in,
  clears it. A network failure does not count.
- **Its page.** The page the provider sends the browser back to is Lemma's
  (`page.ts`), with **Return to Lemma** where the client named a way back
  (`LoginOptions.returnTo`). pi-ai has no hook for it
  ([pi#5372](https://github.com/earendil-works/pi/issues/5372)), so
  `patches/@earendil-works__pi-ai@1.4.0.patch` adds `setOAuthPageRenderer`. Redo
  or drop the patch on each pi-ai upgrade. The renderer is process-wide: the
  latest running plugin's shows.
- **Device ID.** OpenAI's ChatGPT sign-in gets its device ID from
  `<home>/device-id`, a UUID made on first use and kept, as the provider expects
  the same one at every login.

### Providers and catalogs

- Anthropic's subscription OAuth (Claude Pro/Max) is excluded by policy, so
  Anthropic takes API keys only.
- pi-ai's `openai-codex` is left out by default: pi-ai calls it legacy now that
  `openai` signs in with ChatGPT. Its login is another OAuth client's, so moving
  to `openai` means signing in again.
- **Live catalogs** (`liveCatalogs`) refresh at startup, every hour, and after a
  login or logout. [models.dev](https://models.dev) decides which models are
  current, since pi-ai's lists are generated from it: a model it no longer lists
  is hidden. Current models pi-ai does not know are added from the provider's
  OpenAI-style `/models`, else from models.dev. An added model takes its request
  settings from the same model at another built-in provider, else from the known
  model with the nearest id. Without models.dev a provider keeps pi-ai's list.
  Catalogs are in memory only.
- **`ModelsChanged`** (`models-changed` on `llm.changes`) follows a refresh that
  changed the models, and every login and logout. A login announces itself only
  once its refresh is done, so clients listing models then see all of them.
- **ChatGPT plans.** OpenAI signed in with ChatGPT lists the plan's models, as
  the Codex CLI does, from `GET https://api.openai.com/v1/models` with the
  sign-in's token. That list hides models newer than the client asking, so Lemma
  asks as a client newer than any. When it cannot be read, the last refresh's
  list stands.
- On disposal it calls pi-ai's process-global `cleanupSessionResources()`, so
  pooled Codex websockets let the process exit.

## Testing

`makeLlmPlugin({ providers, authContext, fetch })` replaces the built-in
provider list, the environment used for auth, and how live catalogs are fetched.
Tests use it to register pi-ai's `fauxProvider`, to keep the developer's API
keys out, and to keep catalogs offline.

The plugin also runs the `Llm` contract's suite,
[`llmConformance`](../../../packages/testing/README.md#conformance-suites),
against a `fauxProvider`.
