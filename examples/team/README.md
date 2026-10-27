# Team (an example of a plugin a team shares)

One file a team hands its members. It brings two things:

- the team's model gateway, as a provider: its models show in the model
  picker as `team/large` and `team/small`;
- the team's MCP server with its docs: its tools reach every thread.

Each member keeps their own key in `TEAM_GATEWAY_KEY`, or signs in to the
provider on Settings › Providers. Turning the plugin off takes both away.

It is a plugin file. [`team.ts`](team.ts) imports only packages the host
supplies (`effect`, `@lemma/core`, and the contracts of the llm and MCP
domains, `@lemma/llm` and `@lemma/mcp`), so it needs no install step. It is
written with promises (`@lemma/core/plain`).

| Shape | What it uses                                                                          |
| ----- | ------------------------------------------------------------------------------------- |
| Add   | `Providers` (`@lemma/llm`): the gateway; `McpServers` (`@lemma/mcp`): the docs server |

Its settings say where each one is:

| Setting   | Default                       | What it is                                          |
| --------- | ----------------------------- | --------------------------------------------------- |
| `gateway` | `https://llm.example.com/v1`  | The team's OpenAI-compatible model gateway          |
| `docs`    | `https://mcp.example.com/mcp` | The team's MCP server, reached over Streamable HTTP |

A member's own entry wins over the plugin's:

- a provider they add with the id `team` on the Providers page;
- a server named `team-docs` in their `mcp.json`.

To use it:

```sh
ln -s "$PWD/examples/team/team.ts" ~/.lemma-dev/plugins/team.ts   # or copy it, into ~/.lemma/plugins for an installed Lemma
```

`nix develop -c pnpm --filter @lemma/example-team test` checks what it adds,
as the llm and MCP plugins read it.
