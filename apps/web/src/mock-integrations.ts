import { NATIVE_HARNESS } from "@lemma/agent";
import type { HarnessInfo } from "@lemma/agent";
import type { AcpAgentStatus, AcpState, AgentEntry, RegistryAgent } from "@lemma/agent/acp";
import type { McpServerChange, McpServerConfig, McpServerStatus, McpState } from "@lemma/mcp";

/*
 * What the mock host says of the agents a turn can run on (`agent.acp`), and of its MCP servers (`mcp.servers`): enough
 * of their state for Settings › Integrations and the composer's agent picker to show every case, changed by their calls.
 */

/** What an agent with no modes of its own offers: what Lemma keeps by answering its requests. */
const KEPT: AcpAgentStatus["access"] = [{ access: "supervised" }, { access: "auto-edits" }, { access: "full" }];

const preset = (
  agent: Omit<AcpAgentStatus, "source" | "enabled" | "mcp" | "authMethods" | "sessions" | "access"> & Partial<AcpAgentStatus>,
): AcpAgentStatus => ({
  source: "preset",
  enabled: true,
  mcp: true,
  authMethods: [],
  sessions: 0,
  access: KEPT,
  ...agent,
});

const AGENTS: readonly AcpAgentStatus[] = [
  preset({
    id: "claude",
    title: "Claude Code",
    description: "Anthropic's coding agent, through its ACP adapter",
    state: "ready",
    command: "npx",
    args: ["-y", "@agentclientprotocol/claude-agent-acp@0.90.0"],
    install: "Runs through npx. Sign in once with `claude` (Claude Code), or set ANTHROPIC_API_KEY.",
    docs: "https://github.com/agentclientprotocol/claude-agent-acp",
    agent: { name: "@agentclientprotocol/claude-agent-acp", version: "0.90.0", title: "Claude Agent" },
    authMethods: [{ id: "claude-login", name: "Log in with Claude", kind: "agent" }],
    access: [
      { access: "supervised", mode: "default" },
      { access: "auto-edits", mode: "acceptEdits" },
      { access: "auto", mode: "auto" },
      { access: "full", mode: "bypassPermissions" },
    ],
  }),
  preset({
    id: "codex",
    title: "Codex",
    description: "OpenAI's coding agent, through its ACP adapter",
    state: "ready",
    command: "npx",
    args: ["-y", "@agentclientprotocol/codex-acp@2.2.2"],
    install: "Runs through npx. Sign in once with `codex login`, or set OPENAI_API_KEY.",
  }),
  preset({
    id: "gemini",
    title: "Gemini CLI",
    description: "Google's coding agent",
    enabled: false,
    state: "off",
    command: "npx",
    args: ["-y", "@google/gemini-cli@0.63.0", "--acp"],
    entry: { enabled: false },
  }),
  preset({
    id: "opencode",
    title: "OpenCode",
    description: "The open source coding agent",
    state: "missing",
    detail: "`opencode` is not on the host's PATH. Install it from https://opencode.ai, so `opencode` is on PATH.",
    command: "opencode",
    args: ["acp"],
  }),
];

const REGISTRY: readonly RegistryAgent[] = [
  {
    id: "claude-acp",
    name: "Claude Agent",
    description: "ACP wrapper for Anthropic's Claude",
    version: "0.90.0",
    command: "npx",
    args: ["-y", "@agentclientprotocol/claude-agent-acp@0.90.0"],
    runnable: true,
  },
  {
    id: "qwen-code",
    name: "Qwen Code",
    description: "Alibaba's coding agent",
    version: "0.9.1",
    command: "npx",
    args: ["-y", "@qwen-code/qwen-code@0.9.1", "--acp"],
    runnable: true,
    website: "https://qwenlm.github.io",
  },
  {
    id: "fast-agent",
    name: "fast-agent",
    description: "Define and run MCP-enabled agents",
    version: "0.4.0",
    command: "uvx",
    args: ["fast-agent-acp@0.4.0"],
    runnable: false,
  },
];

const server = (
  status: Omit<McpServerStatus, "source" | "sourceKind" | "enabled" | "exposure" | "harnesses" | "tools"> & Partial<McpServerStatus>,
): McpServerStatus => ({
  source: "~/.lemma/mcp.json",
  sourceKind: "file",
  enabled: true,
  exposure: "codemode",
  harnesses: true,
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
  let agents: AcpAgentStatus[] = [...AGENTS];
  let servers: McpServerStatus[] = [...SERVERS];
  const acpListeners = new Set<(state: AcpState) => void>();
  const mcpListeners = new Set<(state: McpState) => void>();
  const harnessListeners = new Set<(harnesses: readonly HarnessInfo[]) => void>();
  const acpState = (): AcpState => ({ file: "~/.lemma/agents.json", agents });
  const mcpState = (): McpState => ({ file: "~/.lemma/mcp.json", servers });
  const harnesses = (): HarnessInfo[] => [
    { id: NATIVE_HARNESS, title: "Lemma", description: "Lemma's own agent, on the model you pick", source: "agent.loop", status: { state: "ready" } },
    ...agents
      .filter((agent) => agent.enabled)
      .map((agent): HarnessInfo => ({
        id: agent.id,
        title: agent.title,
        ...(agent.description === undefined ? {} : { description: agent.description }),
        source: "agent.acp",
        status:
          agent.state === "ready"
            ? { state: "ready", access: agent.access.map((level) => level.access) }
            : { state: "unavailable", ...(agent.detail === undefined ? {} : { detail: agent.detail }), access: agent.access.map((level) => level.access) },
      })),
  ];
  const acpChanged = () => {
    for (const listener of acpListeners) listener(acpState());
    for (const listener of harnessListeners) listener(harnesses());
  };
  const mcpChanged = () => {
    for (const listener of mcpListeners) listener(mcpState());
  };
  return {
    harnesses,
    followHarnesses: (send: (harnesses: readonly HarnessInfo[]) => void) => {
      send(harnesses());
      harnessListeners.add(send);
      return () => void harnessListeners.delete(send);
    },
    acpState,
    followAcp: (send: (state: AcpState) => void) => {
      send(acpState());
      acpListeners.add(send);
      return () => void acpListeners.delete(send);
    },
    putAgent: (id: string, entry: AgentEntry | null) => {
      const found = agents.find((agent) => agent.id === id);
      if (entry === null) {
        if (found?.source === "preset") agents = agents.map((agent) => (agent.id === id ? (AGENTS.find((original) => original.id === id) ?? agent) : agent));
        else agents = agents.filter((agent) => agent.id !== id);
      } else {
        const base: AcpAgentStatus = found ?? {
          id,
          title: id,
          source: "file",
          enabled: true,
          state: "ready",
          command: "",
          args: [],
          mcp: true,
          authMethods: [],
          sessions: 0,
          access: KEPT,
        };
        const enabled = entry.enabled !== false;
        const next: AcpAgentStatus = {
          ...base,
          ...(entry.title === undefined ? {} : { title: entry.title }),
          ...(entry.description === undefined ? {} : { description: entry.description }),
          ...(entry.command === undefined ? {} : { command: entry.command, args: [...(entry.args ?? [])] }),
          enabled,
          mcp: entry.mcp !== false,
          state: !enabled ? "off" : base.state === "off" ? "ready" : base.state,
          entry,
        };
        agents = found === undefined ? [...agents, next] : agents.map((agent) => (agent.id === id ? next : agent));
      }
      acpChanged();
    },
    agent: (id: string) => agents.find((agent) => agent.id === id),
    registry: () => REGISTRY,
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
          harnesses: entry.harnesses !== false,
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
