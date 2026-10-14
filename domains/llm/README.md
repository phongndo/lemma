# llm

Models and their providers: what the agent asks, and how a person connects one. Its contract is [`@lemma/llm`](contract/src/llm.ts), with the web app's side in `@lemma/llm/web`.

| Plugin                               | Halves | What it does                                                                                                    |
| ------------------------------------ | ------ | --------------------------------------------------------------------------------------------------------------- |
| [`llm.pi-ai`](pi-ai/README.md)       | host   | Provides `Llm` over pi-ai's providers, the user's own, and those plugins add; serves it as the `llm.*` channels |
| [`llm.commands`](commands/README.md) | host   | The model providers' commands: log out of one                                                                   |
| [`llm.client`](client/)              | web    | Providers and models as the host reports them, and this browser's choices: provides `Models`                    |
| [`llm.model-picker`](model-picker/)  | web    | The model and reasoning pickers                                                                                 |
| [`llm.providers`](providers/)        | web    | Settings › Providers: connecting providers, and adding your own                                                 |
| [`llm.cli`](cli/README.md)           | host   | The `lemma` command's `models`, `providers`, `login`, `logout`, and a check for `lemma doctor`                  |

## Extending it

What the contract offers in each of the [five shapes](../../docs/plugins.md#the-five-shapes):

| Shape     | What the contract offers                                                                                                                                                                                                                                                                                         |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add       | `Providers`: a provider (an endpoint speaking a protocol the llm plugin knows, and its models). In the web app, the Providers page's parts                                                                                                                                                                       |
| Intercept | `LlmRequestHook`: a model request and its stream; `LlmProviderHeadersHook`: the headers a provider sends it with (`ProviderLogoPart` and `ProviderRowPart` take over how a provider shows; `ComposerModelPart`, the composer's model control, which the agent picker takes over to offer every harness's models) |
| Observe   | `ModelsChanged`: what `providers` and `models` list changed; `LlmProviderResponse`: a provider answered; `LlmProviderStreamEvent`: a provider's raw events, when its plugin is told to publish them                                                                                                              |
| Call      | `Llm`: stream, models, providers, logins; clients call `LlmChannels`; in the web app, `Models`                                                                                                                                                                                                                   |
| Serve     | `Llm`, with `serveLlm`: a plugin providing it replaces `llm.pi-ai`                                                                                                                                                                                                                                               |
