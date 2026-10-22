import { svgSource } from "@lemma/look";
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

/** An icon of the user's own, an SVG file written into the entry as the add form does. */
const NOTES_ICON = svgSource(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect x="3" y="2" width="18" height="20" rx="4" fill="#f5b83d"/><path d="M7 8h10M7 12h10M7 16h6" stroke="#7a4a00" stroke-width="2" stroke-linecap="round"/></svg>',
);

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
    name: "github",
    state: "connected",
    transport: "http",
    target: "https://api.githubcopilot.com/mcp/",
    entry: { url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: "Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}" } },
    server: { name: "github-mcp-server", version: "1.4.0" },
    tools: [
      { name: "search_issues", tool: "mcp__github__search_issues", exposure: "codemode", description: "Search issues and pull requests" },
      { name: "get_file_contents", tool: "mcp__github__get_file_contents", exposure: "codemode", description: "Read a file in a repository" },
      { name: "create_pull_request", tool: "mcp__github__create_pull_request", exposure: "direct", own: "direct", description: "Open a pull request" },
    ],
  }),
  server({
    name: "notes",
    state: "connected",
    transport: "stdio",
    target: "node ~/notes/server.js",
    entry: { command: "node", args: ["~/notes/server.js"], icon: NOTES_ICON },
    icon: NOTES_ICON,
    tools: [{ name: "search", tool: "mcp__notes__search", exposure: "codemode", description: "Search the notes" }],
  }),
  // A plugin's server: the file has no entry for it, so it is turned off or its tools changed, but not edited.
  server({
    name: "tickets",
    state: "connected",
    source: "examples.tickets",
    sourceKind: "plugin",
    transport: "stdio",
    target: "node tickets-server.js",
    tools: [{ name: "open_ticket", tool: "mcp__tickets__open_ticket", exposure: "codemode", description: "Open a ticket" }],
  }),
  server({
    name: "docs",
    state: "failed",
    transport: "http",
    target: "https://docs.example.com/mcp",
    entry: { url: "https://docs.example.com/mcp", headers: { Authorization: "Bearer ${DOCS_TOKEN}" } },
    error: "${DOCS_TOKEN} is not set in the host's environment",
  }),
  server({
    name: "tracker",
    state: "needs-sign-in",
    transport: "http",
    target: "https://tracker.example.com/mcp",
    entry: { url: "https://tracker.example.com/mcp" },
    auth: { state: "signed-out" },
  }),
];

const TRACKER_TOOLS: McpServerStatus["tools"] = [
  { name: "list_issues", tool: "mcp__tracker__list_issues", exposure: "codemode", description: "List the issues assigned to you" },
];

const targetOf = (entry: McpServerConfig) => entry.url ?? [entry.command ?? "", ...(entry.args ?? [])].join(" ").trim();

export const createIntegrationsMock = () => {
  let servers: McpServerStatus[] = [...SERVERS];
  const mcpListeners = new Set<(state: McpState) => void>();
  const mcpState = (): McpState => ({ file: "~/.lemma/mcp.json", servers });
  const mcpChanged = () => {
    for (const listener of mcpListeners) listener(mcpState());
  };
  const update = (name: string, fields: Partial<McpServerStatus>) => {
    servers = servers.map((status) => (status.name === name ? { ...status, ...fields } : status));
    mcpChanged();
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
    // Signing in: the page is an example's, and a paste of any address signs in.
    signIn: (name: string) => {
      const url = `https://tracker.example.com/authorize?client_id=lemma&state=${name}`;
      update(name, { auth: { state: "signing-in", url } });
      return { url };
    },
    finishSignIn: (name: string) => update(name, { state: "connected", auth: { state: "signed-in" }, tools: TRACKER_TOOLS }),
    cancelSignIn: (name: string) => update(name, { auth: { state: "signed-out" } }),
    signOut: (name: string) => update(name, { state: "needs-sign-in", auth: { state: "signed-out" }, tools: [] }),
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
          ...(entry.icon === undefined ? {} : { icon: entry.icon }),
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
