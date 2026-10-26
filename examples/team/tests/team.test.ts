import { Effect } from "effect";
import { describe, expect, test } from "vitest";
import { makeCore, Registries } from "@lemma/core";
import { Providers } from "@lemma/llm";
import { McpServers } from "@lemma/mcp";
import team from "../team.ts";

/** What the plugin adds to each registry, as the llm and MCP plugins read it. */
const added = (config: Record<string, unknown> = {}) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* makeCore([team], { configs: { team: config } });
        return yield* core.run(
          Effect.gen(function* () {
            const registries = yield* Registries;
            return { providers: yield* registries.items(Providers), servers: yield* registries.items(McpServers) };
          }),
        );
      }),
    ),
  );

describe("the team plugin", () => {
  test("adds the gateway as a provider, and the docs server, both its own", async () => {
    const { providers, servers } = await added();
    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({ pluginId: "team", item: { id: "team", api: "openai-completions", apiKey: { env: "TEAM_GATEWAY_KEY" } } });
    expect(providers[0]!.item.models.map((model) => model.id)).toEqual(["large", "small"]);
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({ pluginId: "team", item: { name: "team-docs", url: "https://mcp.example.com/mcp" } });
  });

  test("reaches them where its settings say", async () => {
    const { providers, servers } = await added({ gateway: "http://localhost:4000/v1", docs: "http://localhost:4001/mcp" });
    expect(providers[0]!.item.baseUrl).toBe("http://localhost:4000/v1");
    expect(servers[0]!.item.url).toBe("http://localhost:4001/mcp");
  });
});
