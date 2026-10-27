import { Effect, Schema } from "effect";
import { definePlugin } from "@lemma/core/plain";
import { Providers } from "@lemma/llm";
import { McpServers } from "@lemma/mcp";

/**
 * What a team shares, as one plugin: the model gateway its members reach models through (`Providers`), and the MCP
 * server with its docs (`McpServers`). Each member drops this file into `~/.lemma/plugins/`, and has the gateway's
 * models in the model picker and the server's tools in every thread, with no setup of their own. Both leave when the
 * plugin is turned off.
 *
 * A plugin file, written the way a user writes one. It imports only packages the host supplies, and is written with
 * promises (`@lemma/core/plain`).
 */

const Config = Schema.Struct({
  gateway: Schema.String.pipe(Schema.withDecodingDefaultType(Effect.sync(() => "https://llm.example.com/v1"))).annotate({
    title: "Gateway",
    description: "The address of the team's OpenAI-compatible model gateway.",
  }),
  docs: Schema.String.pipe(Schema.withDecodingDefaultType(Effect.sync(() => "https://mcp.example.com/mcp"))).annotate({
    title: "Docs server",
    description: "The address of the team's MCP server, reached over Streamable HTTP.",
  }),
});

export default definePlugin({
  id: "team",
  version: "0.1.0",
  uses: ["lemma/llm@3", "lemma/mcp@1"],
  config: Config,
  setup: (_deps, { add, config }) => {
    add(Providers, {
      id: "team",
      name: "Team gateway",
      api: "openai-completions",
      baseUrl: config.gateway,
      // Each member's own key, from their environment; signing in on the Providers page wins over it.
      apiKey: { env: "TEAM_GATEWAY_KEY" },
      models: [
        { id: "large", name: "Team Large", contextWindow: 200_000, reasoning: true },
        { id: "small", name: "Team Small", contextWindow: 128_000 },
      ],
    });
    add(McpServers, {
      name: "team-docs",
      url: config.docs,
      description: "The team's internal docs: search them, and read a page.",
    });
  },
});
