import { Effect, Layer } from "effect";
import { definePlugin, Events, PluginContext } from "@lemma/core";
import { AgentRequestHook, Credentials, HostControl, Inspectors, Interaction, McpManagers, Paths, Tools } from "@lemma/contracts";
import type { SystemSection, ToolContribution } from "@lemma/contracts";
import { McpConfig } from "./config.ts";
import { makeServers } from "./servers.ts";

export { McpConfig } from "./config.ts";
export { Connection } from "./connection.ts";
export type { Launch } from "./connection.ts";
export { toContent, toToolResult } from "./content.ts";
export { MAX_TOOL_NAME, toolNames } from "./names.ts";
export { inheritedEnvironment, launchOf, masked, unmasked } from "./resolve.ts";
export { inputParameters } from "./schema.ts";
export { StdioTransport } from "./stdio.ts";

/** Reported to servers as the client's version, and the plugin's. */
export const VERSION = "0.1.0";

/** Before the agent's date-bearing `environment` section, so the cacheable prefix stays long (as project-context does). */
const insert = (sections: readonly SystemSection[], section: SystemSection): SystemSection[] => {
  const at = sections.findIndex((candidate) => candidate.id === "environment");
  return at === -1 ? [...sections, section] : [...sections.slice(0, at), section, ...sections.slice(at)];
};

/** After the handlers that add sections (order 0), before compaction (1000), which sizes the final request. */
const ORDER = 10;

const byName = (a: ToolContribution, b: ToolContribution) => (a.spec.name < b.spec.name ? -1 : a.spec.name > b.spec.name ? 1 : 0);

export default definePlugin({
  id: "mcp",
  version: VERSION,
  config: McpConfig,
  requires: [Tools, Credentials, Interaction, HostControl, Paths],
  layer: (config) =>
    Layer.scopedDiscard(
      Effect.gen(function* () {
        const owner = yield* PluginContext;
        const events = yield* Events;
        const [tools, credentials, interaction, control, paths] = yield* Effect.all([Tools, Credentials, Interaction, HostControl, Paths]);
        const servers = yield* makeServers({ config, owner, tools, credentials, control, interaction, events, cwd: paths.cwd, version: VERSION });

        // Clients manage servers through this; a failure to add it leaves MCP running, unmanaged.
        yield* owner.add(McpManagers, servers.manager).pipe(Effect.ignore);
        yield* owner
          .add(Inspectors, {
            id: "mcp.servers",
            title: "MCP servers",
            description: "Each MCP server, its connection, and its tools",
            snapshot: Effect.map(servers.infos, (list) =>
              list.map((server) => ({
                id: server.id,
                status: server.status,
                type: server.type,
                tools: `${server.tools.filter((tool) => tool.enabled).length}/${server.tools.length}`,
                error: server.error ?? "",
              })),
            ),
          })
          .pipe(Effect.ignore);

        yield* owner.on(
          AgentRequestHook,
          (draft, next) =>
            Effect.gen(function* () {
              // The first request after a start waits briefly for servers still connecting, so their tools are there.
              const waited = yield* servers.firstConnections;
              let listed = draft.tools;
              if (waited) {
                const have = new Set(listed.map((tool) => tool.spec.name));
                const added = (yield* tools.list).filter((tool) => tool.source === owner.id && !have.has(tool.spec.name));
                if (added.length > 0) listed = [...listed, ...added].sort(byName);
              }
              // Every MCP tool is reached through codemode, as this request offers it (a handler before this one may have
              // taken it out); without it, they are declared like any tool.
              const codemode = listed.some((tool) => tool.spec.name === "codemode");
              const reached = (tool: ToolContribution) => codemode && tool.source === owner.id;
              const text = servers.section(codemode);
              return yield* next({
                ...draft,
                tools: listed.filter((tool) => !reached(tool)),
                reachable: [...draft.reachable, ...listed.filter(reached)],
                ...(text === undefined ? {} : { sections: insert(draft.sections, { id: "mcp-servers", source: owner.id, text }) }),
              });
            }),
          // After project-context (order 0): the servers change more often than a project's instructions, so they sit later.
          { order: ORDER },
        );
      }),
    ),
});
