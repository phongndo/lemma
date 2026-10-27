# Redact (an example of changing a tool's result)

Keeps secrets out of what the model reads. A tool can come across a secret: a
command prints an environment, or `read` opens a `.env` file. This plugin
replaces each one in the tool's result with `[redacted]` before the model, a
script, or the transcript sees it.

It is a plugin file. [`redact.ts`](redact.ts) imports only packages the host
supplies (`effect`, `@lemma/core`, and the tools domain's contract,
`@lemma/tools`), so it needs no install step. It is written with promises
(`@lemma/core/plain`).

| Shape     | What it uses                                                                    |
| --------- | ------------------------------------------------------------------------------- |
| Intercept | `ToolExecuteHook`: after `next` runs the tool, it changes the result it returns |

It redacts:

- AWS access key ids;
- GitHub tokens;
- OpenAI and Anthropic API keys;
- Slack tokens;
- private keys in PEM form.

`patterns` in its row's `config` adds regular expressions of your own.

To use it:

```sh
ln -s "$PWD/examples/redact/redact.ts" ~/.lemma-dev/plugins/redact.ts   # or copy it, into ~/.lemma/plugins for an installed Lemma
```

The model never sees a redacted secret. So an `edit` whose text spans one
fails to match, and the edit tool says so. A secret can also still reach the
model another way, such as a prompt you write. Redacting what a tool returns is
a net, not a guarantee.

`nix develop -c pnpm --filter @lemma/example-redact test` runs it around real
tool calls, through the tools registry.
