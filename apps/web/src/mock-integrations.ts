import type { McpServerChange, McpServerConfig, McpServerStatus, McpState } from "@lemma/mcp";

/*
 * What the mock host says of its MCP servers (`mcp.servers`): enough of their state for Settings › Integrations to show
 * every case, changed by their calls.
 */

const server = (status: Omit<McpServerStatus, "source" | "sourceKind" | "enabled" | "exposure" | "tools"> & Partial<McpServerStatus>): McpServerStatus => ({
  source: "~/.lemma/mcp.json",
  sourceKind: "file",
  enabled: true,
  exposure: "codemode",
  tools: [],
  ...status,
});

const SERVERS: readonly McpServerStatus[] = [
  server({
    name: "filesystem",
    state: "connected",
    transport: "stdio",
    target: "npx -y @modelcontextprotocol/server-filesystem .",
    entry: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."] },
    server: { name: "secure-filesystem-server", version: "0.2.0" },
    tools: [
      { name: "read_file", tool: "mcp__filesystem__read_file", exposure: "codemode", description: "Read a file" },
      { name: "list_directory", tool: "mcp__filesystem__list_directory", exposure: "codemode", description: "List a directory" },
    ],
  }),
  server({
    name: "docs",
    state: "failed",
    transport: "http",
    target: "https://docs.example.com/mcp",
    entry: { url: "https://docs.example.com/mcp", headers: { Authorization: "Bearer ${DOCS_TOKEN}" } },
    error: "${DOCS_TOKEN} is not set in the host's environment",
  }),
];

const targetOf = (entry: McpServerConfig) => entry.url ?? [entry.command ?? "", ...(entry.args ?? [])].join(" ").trim();

export const createIntegrationsMock = () => {
  let servers: McpServerStatus[] = [...SERVERS];
  const mcpListeners = new Set<(state: McpState) => void>();
  const mcpState = (): McpState => ({ file: "~/.lemma/mcp.json", servers });
  const mcpChanged = () => {
    for (const listener of mcpListeners) listener(mcpState());
  };
  return {
    mcpState,
    followMcp: (send: (state: McpState) => void) => {
      send(mcpState());
      mcpListeners.add(send);
      return () => void mcpListeners.delete(send);
    },
    configureServer: (name: string, change: McpServerChange) => {
      servers = servers.map((status) =>
        status.name !== name
          ? status
          : {
              ...status,
              ...(change.enabled === undefined ? {} : { enabled: change.enabled, state: change.enabled ? "connected" : "off" }),
              ...(change.exposure === undefined ? {} : { exposure: change.exposure }),
            },
      );
      mcpChanged();
    },
    putServer: (name: string, entry: McpServerConfig | null) => {
      if (entry === null) servers = servers.filter((status) => status.name !== name);
      else {
        const next = server({
          name,
          state: entry.enabled === false ? "off" : "connected",
          enabled: entry.enabled !== false,
          transport: entry.url === undefined ? "stdio" : "http",
          target: targetOf(entry),
          entry,
          ...(entry.description === undefined ? {} : { description: entry.description }),
        });
        servers = servers.some((status) => status.name === name)
          ? servers.map((status) =>
              status.name === name ? { ...next, tools: status.tools, ...(status.server === undefined ? {} : { server: status.server }) } : status,
            )
          : [...servers, next].sort((a, b) => a.name.localeCompare(b.name));
      }
      mcpChanged();
    },
  };
};
