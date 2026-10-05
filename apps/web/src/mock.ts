import type { ConnectionStatus, Host } from "@lemma/client";
import { Schema } from "effect";
import { HostError, MCP_HIDDEN, configValues, describeConfig, emptyUsage, joinCommandLine, looksSecret, secret } from "@lemma/contracts";
import { fuzzy } from "./model/palette.ts";
import type {
  AssistantMessage,
  EventData,
  HostEvent,
  InteractionAnswer,
  InteractionRequest,
  McpLogEntry,
  McpServerInfo,
  McpServerSpec,
  McpStatus,
  McpToolHints,
  McpToolInfo,
  ModelInfo,
  PluginStatus,
  PromptContent,
  QueuedPrompt,
  ProviderInfo,
  SessionEvent,
  SessionInfo,
  StreamEvent,
  TurnOptions,
  UiComposition,
  Usage,
} from "@lemma/contracts";

/**
 * Dev-only in-browser fake of the host (`?mock`, or `?mock=fresh` for a first
 * run with no sessions). Every provider starts logged out, so the fake never
 * looks like real credentials; its login flow only pretends. Not shipped:
 * `main.tsx` imports it only in dev.
 */

const HOME = "/home/dev";
const CWD = `${HOME}/code/lemma`;
/** What the mock host's plugins let you look into, as a real host's `Inspectors` would. */
const MOCK_INSPECTORS = [
  {
    id: "tools.registered",
    title: "Tools",
    description: "Every tool the model can call, the plugin that registered it, and the guards that check calls",
    source: "tools",
    snapshot: () => ({
      tools: ["read", "write", "edit", "bash", "codemode"].map((name) => ({ name, plugin: name, description: `The ${name} tool` })),
      guards: [],
    }),
  },
  {
    id: "agent.turns",
    title: "Running turns",
    description: "Each session with a turn running now, and how long it has run",
    source: "agent",
    snapshot: () => [],
  },
];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let idSeq = 0;
const id = (prefix: string) => `${prefix}${(++idSeq).toString(36)}`;

const usage = (input: number, output: number, cacheRead = 0): Usage => ({
  ...emptyUsage,
  input,
  output,
  cacheRead,
  totalTokens: input + output + cacheRead,
  cost: {
    input: input * 3e-6,
    output: output * 15e-6,
    cacheRead: cacheRead * 0.3e-6,
    cacheWrite: 0,
    total: input * 3e-6 + output * 15e-6 + cacheRead * 0.3e-6,
  },
});

const assistant = (
  content: AssistantMessage["content"],
  u: Usage,
  stopReason: AssistantMessage["stopReason"] = "stop",
  errorMessage?: string,
  /** The model that answered; the seeded history's is Claude Sonnet 4.5. */
  by: Pick<ModelInfo, "api" | "provider" | "id"> = { api: "anthropic-messages", provider: "anthropic", id: "claude-sonnet-4-5" },
): AssistantMessage => ({
  role: "assistant",
  content,
  api: by.api,
  provider: by.provider,
  model: by.id,
  usage: u,
  stopReason,
  timestamp: Date.now(),
  ...(errorMessage === undefined ? {} : { errorMessage }),
});

const MODELS: ModelInfo[] = [
  {
    ref: "anthropic/claude-sonnet-4-5",
    provider: "anthropic",
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    api: "anthropic-messages",
    reasoning: true,
    thinkingLevels: ["off", "low", "medium", "high"],
    input: ["text", "image"],
    contextWindow: 200_000,
    maxTokens: 64_000,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  },
  {
    ref: "anthropic/claude-haiku-4-5",
    provider: "anthropic",
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    api: "anthropic-messages",
    reasoning: false,
    thinkingLevels: [],
    input: ["text", "image"],
    contextWindow: 200_000,
    maxTokens: 64_000,
    cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  },
  {
    ref: "openai/gpt-5",
    provider: "openai",
    id: "gpt-5",
    name: "GPT-5",
    api: "openai-responses",
    reasoning: true,
    thinkingLevels: ["minimal", "low", "medium", "high"],
    input: ["text", "image"],
    contextWindow: 400_000,
    maxTokens: 128_000,
    cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  },
  {
    ref: "openai/gpt-5-mini",
    provider: "openai",
    id: "gpt-5-mini",
    name: "GPT-5 mini",
    api: "openai-responses",
    reasoning: true,
    thinkingLevels: ["minimal", "low", "medium", "high"],
    input: ["text"],
    contextWindow: 400_000,
    maxTokens: 128_000,
    cost: { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0 },
  },
  // From OpenCode's catalogs, so connecting either one shows models as the real host does.
  ...(
    [
      ["opencode", "claude-sonnet-4-5", "Claude Sonnet 4.5", "anthropic-messages", 200_000, 3, 15],
      ["opencode", "gpt-5", "GPT-5", "openai-responses", 400_000, 1.25, 10],
      // OpenCode Go's current models as of 2026-09-29 (its /models, less what models.dev has retired).
      ["opencode-go", "minimax-m3", "MiniMax-M3", "anthropic-messages", 1000000, 0.3, 1.2],
      ["opencode-go", "minimax-m2.7", "MiniMax-M2.7", "anthropic-messages", 204800, 0.3, 1.2],
      ["opencode-go", "kimi-k3", "Kimi K3", "openai-completions", 1048576, 3, 15],
      ["opencode-go", "kimi-k2.7-code", "Kimi K2.7 Code", "openai-completions", 262144, 0.95, 4],
      ["opencode-go", "kimi-k2.6", "Kimi K2.6", "openai-completions", 262144, 0.95, 4],
      ["opencode-go", "longcat-2.0", "LongCat-2.0", "openai-completions", 1000000, 0.3, 1.2],
      ["opencode-go", "glm-5.2", "GLM-5.2", "openai-completions", 1000000, 1.4, 4.4],
      ["opencode-go", "glm-5.3-flash", "GLM-5.3-Flash", "openai-completions", 1000000, 0.15, 0.5],
      ["opencode-go", "glm-5.3", "GLM-5.3", "openai-completions", 1000000, 1.4, 4.4],
      ["opencode-go", "deepseek-v4-pro", "DeepSeek V4 Pro (New)", "openai-completions", 1000000, 0.66, 1.98],
      ["opencode-go", "deepseek-v4-flash", "DeepSeek V4 Flash", "openai-completions", 1000000, 0.15, 0.6],
      ["opencode-go", "deepseek-v4.1-flash", "DeepSeek V4.1 Flash", "openai-completions", 1000000, 0.15, 0.6],
      ["opencode-go", "deepseek-v4-flash-vision-exp", "DeepSeek V4 Flash Vision Exp", "openai-completions", 1000000, 0.15, 0.6],
      ["opencode-go", "qwen3.7-max", "Qwen3.7 Max", "openai-completions", 1000000, 2.5, 7.5],
      ["opencode-go", "qwen3.8-max", "Qwen3.8 Max", "openai-completions", 1000000, 2, 6],
      ["opencode-go", "qwen3.8-flash", "Qwen3.8 Flash", "anthropic-messages", 1000000, 0.15, 0.47],
      ["opencode-go", "qwen3.7-plus", "Qwen3.7 Plus", "openai-completions", 1000000, 0.4, 1.6],
      ["opencode-go", "qwen3.6-plus", "Qwen3.6 Plus", "openai-completions", 1000000, 0.5, 3],
      ["opencode-go", "mimo-v2.6-pro", "MiMo-V2.6-Pro", "openai-completions", 1048576, 0.435, 0.87],
      ["opencode-go", "mimo-v2.6-flash", "MiMo-V2.6-Flash", "openai-completions", 1048576, 0.14, 0.28],
      ["opencode-go", "space-bunny-free", "Space Bunny Free", "openai-completions", 1048576, 0, 0],
      ["opencode-go", "longcat-2.5-preview-free", "LongCat 2.5 Preview Free", "openai-completions", 1000000, 0, 0],
      ["opencode-go", "mimo-v2.5-pro", "MiMo V2.5 Pro", "openai-completions", 1048576, 0.435, 0.87],
      ["opencode-go", "mimo-v2.5", "MiMo V2.5", "openai-completions", 1000000, 0.14, 0.28],
      ["opencode-go", "hy4-preview", "Hy4 preview", "openai-completions", 1024000, 0.834, 2.501],
      ["opencode-go", "hy3", "Hy3", "openai-completions", 256000, 0.14, 0.58],
      ["opencode-go", "gpt-5.6-luna", "GPT-5.6 Luna", "openai-responses", 1050000, 0.2, 1.2],
      ["opencode-go", "grok-4.5", "Grok 4.5", "openai-responses", 500000, 2, 6],
      ["opencode-go", "grok-4.7", "Grok 4.7", "openai-responses", 500000, 2, 6],
      ["opencode-go", "grok-4.6", "Grok 4.6", "openai-responses", 500000, 2, 6],
      ["opencode-go", "muse-spark-1.3-contributor", "Muse Spark 1.3 Contributor", "openai-responses", 1048576, 0.1, 0.2],
      ["opencode-go", "muse-spark-1.2-contributor", "Muse Spark 1.2 Contributor", "openai-responses", 1048576, 0.1, 0.2],
      ["opencode-go", "gpt-6-luna", "GPT-6 Luna", "openai-responses", 1050000, 0.1, 0.5],
    ] as const
  ).map(([provider, id, name, api, contextWindow, input, output]): ModelInfo => ({
    ref: `${provider}/${id}`,
    provider,
    id,
    name,
    api,
    reasoning: true,
    thinkingLevels: ["low", "medium", "high"],
    input: ["text"],
    contextWindow,
    maxTokens: 32_000,
    cost: { input, output, cacheRead: 0, cacheWrite: 0 },
  })),
];

const MOCK_COMMANDS = [
  {
    id: "workspace.new-branch",
    title: "Create branch…",
    category: "Git",
    description: "Create a branch from HEAD and switch to it",
    source: "commands-workspace",
  },
  {
    id: "workspace.checkout",
    title: "Switch branch…",
    category: "Git",
    description: "Check out another branch in the working directory",
    source: "commands-workspace",
  },
  { id: "host.reload", title: "Reload config", category: "Host", description: "Re-read the config files and apply them", source: "commands-host" },
];

/** What the fake MCP servers offer once connected: who they say they are, and their tools. */
interface McpCatalog {
  readonly server: { readonly name: string; readonly title?: string; readonly version: string };
  readonly instructions?: string;
  readonly resources?: number;
  readonly prompts?: number;
  /** Name, title, description, and hints. */
  readonly tools: readonly (readonly [string, string | undefined, string, McpToolHints])[];
}
const read: McpToolHints = { readOnly: true };
const write: McpToolHints = { readOnly: false, destructive: false };
const MCP_CATALOG: Readonly<Record<string, McpCatalog>> = {
  playwright: {
    server: { name: "Playwright", version: "0.0.41" },
    tools: [
      ["browser_navigate", "Navigate to a URL", "Navigate to a URL", { ...write, openWorld: true }],
      ["browser_navigate_back", "Go back", "Go back to the previous page", write],
      ["browser_snapshot", "Page snapshot", "Capture accessibility snapshot of the current page, this is better than screenshot", read],
      ["browser_click", "Click", "Perform click on a web page", write],
      ["browser_type", "Type text", "Type text into editable element", write],
      ["browser_press_key", "Press a key", "Press a key on the keyboard", write],
      ["browser_hover", "Hover mouse", "Hover over element on page", read],
      ["browser_drag", "Drag mouse", "Perform drag and drop between two elements", write],
      ["browser_select_option", "Select option", "Select an option in a dropdown", write],
      ["browser_fill_form", "Fill form", "Fill multiple form fields", write],
      ["browser_file_upload", "Upload files", "Upload one or multiple files", write],
      ["browser_handle_dialog", "Handle a dialog", "Handle a dialog", write],
      [
        "browser_evaluate",
        "Evaluate JavaScript",
        "Evaluate JavaScript expression on page or element. Returns the result of the expression, serialized as JSON; a function receives the element when one is given, and anything it logs shows in browser_console_messages.",
        { destructive: true },
      ],
      ["browser_console_messages", "Get console messages", "Returns all console messages", read],
      ["browser_network_requests", "List network requests", "Returns all network requests since loading the page", read],
      [
        "browser_take_screenshot",
        "Take a screenshot",
        "Take a screenshot of the current page. You can't perform actions based on the screenshot, use browser_snapshot for actions. Full-page screenshots of long pages are scaled down to fit the model's image limits.",
        read,
      ],
      ["browser_tabs", "Manage tabs", "List, create, close, or select a browser tab.", write],
      ["browser_wait_for", "Wait for", "Wait for text to appear or disappear or a specified time to pass", read],
      ["browser_resize", "Resize browser window", "Resize the browser window", write],
      ["browser_close", "Close browser", "Close the page", { destructive: true }],
    ],
  },
  github: {
    server: { name: "github-mcp-server", title: "GitHub MCP Server", version: "0.13.0" },
    instructions:
      "The GitHub MCP Server provides tools to interact with GitHub.\n\n- Use `search_issues` before `create_issue` to avoid duplicates.\n- Prefer `get_file_contents` over cloning to read a file.\n- Pull requests are reviewed by people: do not merge without being asked.",
    resources: 4,
    prompts: 2,
    tools: [
      ["get_me", "Get my user profile", "Get details of the authenticated GitHub user.", { ...read, openWorld: true }],
      ["search_repositories", "Search repositories", "Search for GitHub repositories by name, description, topic, or owner.", { ...read, openWorld: true }],
      [
        "get_file_contents",
        "Get file or directory contents",
        "Get the contents of a file or directory from a GitHub repository.",
        { ...read, openWorld: true },
      ],
      [
        "search_issues",
        "Search issues",
        "Search for issues in GitHub repositories using issues search syntax already scoped to is:issue.",
        { ...read, openWorld: true },
      ],
      [
        "list_issues",
        "List issues",
        "List issues in a GitHub repository. For pagination, use the 'endCursor' from the previous response.",
        { ...read, openWorld: true },
      ],
      ["get_issue", "Get issue details", "Get details of a specific issue in a GitHub repository.", { ...read, openWorld: true }],
      ["create_issue", "Create issue", "Create a new issue in a GitHub repository.", { ...write, openWorld: true }],
      ["add_issue_comment", "Add comment to issue", "Add a comment to a specific issue in a GitHub repository.", { ...write, openWorld: true }],
      ["update_issue", "Edit issue", "Update an existing issue in a GitHub repository.", { ...write, openWorld: true }],
      ["list_pull_requests", "List pull requests", "List pull requests in a GitHub repository.", { ...read, openWorld: true }],
      ["create_pull_request", "Open new pull request", "Create a new pull request in a GitHub repository.", { ...write, openWorld: true }],
      ["merge_pull_request", "Merge pull request", "Merge a pull request in a GitHub repository.", { destructive: true, openWorld: true }],
    ],
  },
  linear: {
    server: { name: "Linear", version: "1.4.2" },
    tools: [
      ["list_issues", "List issues", "List issues in the user's Linear workspace, filtered by team, assignee, state, or label.", { ...read, openWorld: true }],
      [
        "get_issue",
        "Get issue",
        "Retrieve a Linear issue by its id or identifier (LIN-123), with its attachments and branch name.",
        { ...read, openWorld: true },
      ],
      ["create_issue", "Create issue", "Create a new Linear issue.", { ...write, openWorld: true }],
      ["update_issue", "Update issue", "Update an existing Linear issue.", { ...write, openWorld: true }],
      ["create_comment", "Create comment", "Create a comment on a Linear issue.", { ...write, openWorld: true }],
      ["list_teams", "List teams", "List teams in the user's Linear workspace.", { ...read, openWorld: true }],
      ["list_projects", "List projects", "List projects in the user's Linear workspace.", { ...read, openWorld: true }],
      ["search_documentation", "Search documentation", "Search Linear's documentation to learn about features and usage.", { ...read, openWorld: true }],
    ],
  },
  filesystem: {
    server: { name: "secure-filesystem-server", version: "0.6.2" },
    tools: [
      ["read_text_file", undefined, "Read the complete contents of a file from the file system as text.", read],
      ["write_file", undefined, "Create a new file or completely overwrite an existing file with new content.", { destructive: true }],
      ["list_directory", undefined, "Get a detailed listing of all files and directories in a specified path.", read],
      ["search_files", undefined, "Recursively search for files and directories matching a pattern.", read],
    ],
  },
  generic: {
    server: { name: "mcp-server", version: "1.0.0" },
    tools: [
      ["search", undefined, "Search the service for documents matching a query.", { ...read, openWorld: true }],
      ["fetch", undefined, "Fetch a document by its id.", { ...read, openWorld: true }],
    ],
  },
};
/** Programs the fake host can start; any other command is "not found". */
const MCP_RUNNERS = new Set(["npx", "uvx", "node", "bunx", "deno", "docker", "python", "python3", "pnpm"]);
/** Services whose fake servers want a sign-in. */
const MCP_AUTH_HOSTS = /linear\.app|notion\.com|atlassian\.com|sentry\.dev|asana\.com/;

export const createMockHost = (): Host => {
  const fresh = new URLSearchParams(location.search).get("mock") === "fresh";
  const key = { type: "api_key", name: "API key", interactive: true } as const;
  const oauth = (name: string) => ({ type: "oauth", name, interactive: true }) as const;
  /** The real llm plugin's providers (pi-ai's built-ins), as `Llm.providers` reports them. */
  const providers: ProviderInfo[] = [
    ["amazon-bedrock", "Amazon Bedrock", [key]],
    ["ant-ling", "Ant Ling", [key]],
    // As in the real llm plugin: Anthropic's subscription OAuth (Claude Pro/Max) is excluded by policy.
    ["anthropic", "Anthropic", [key]],
    ["azure-openai-responses", "Azure OpenAI", [key]],
    ["baseten", "Baseten", [key]],
    ["cerebras", "Cerebras", [key]],
    ["cloudflare-workers-ai", "Cloudflare Workers AI", [key]],
    ["deepseek", "DeepSeek", [key]],
    ["fireworks", "Fireworks", [key]],
    ["github-copilot", "GitHub Copilot", [oauth("GitHub Copilot"), key]],
    ["google", "Google", [key]],
    ["google-vertex", "Google Vertex AI", [key]],
    ["groq", "Groq", [key]],
    ["huggingface", "Hugging Face", [key]],
    ["kimi-coding", "Kimi For Coding", [oauth("Kimi Code (subscription)"), key]],
    ["meta", "Meta", [oauth("Meta (Muse subscription)"), key]],
    ["minimax", "MiniMax", [key]],
    ["mistral", "Mistral", [key]],
    ["moonshotai", "Moonshot AI", [key]],
    ["nvidia", "NVIDIA", [key]],
    // As in the real llm plugin: OpenAI signs in with ChatGPT itself, and the legacy OpenAI Codex is left out.
    ["openai", "OpenAI", [key, oauth("Sign in with ChatGPT")]],
    ["opencode", "OpenCode Zen", [key]],
    ["opencode-go", "OpenCode Go", [key]],
    ["openrouter", "OpenRouter", [oauth("OpenRouter OAuth"), key]],
    ["qwen-token-plan", "Qwen Token Plan", [key]],
    ["radius", "Radius", [oauth("Radius"), key]],
    ["together", "Together", [key]],
    ["vercel-ai-gateway", "Vercel AI Gateway", [key]],
    ["xai", "xAI", [oauth("xAI (Grok/X subscription)"), key]],
    ["xiaomi", "Xiaomi", [key]],
    ["zai", "Z.AI", [key]],
  ].map(([id, name, auth]) => ({ id: id as string, name: name as string, auth: auth as ProviderInfo["auth"], configured: false }));
  const bundled = (id: string, extra: Partial<PluginStatus> = {}): PluginStatus => ({
    id,
    version: "0.1.0",
    source: "bundled",
    enabled: true,
    provides: [],
    requires: [],
    state: "active",
    ...extra,
  });
  const needed = "Needed by transport";
  // Mirrors of real config Schemas, so the Plugins page shows settings forms.
  const configs: Record<string, Schema.Schema.AnyNoContext> = {
    agent: Schema.Struct({
      defaultModel: Schema.optional(Schema.String).annotations({
        description: "<provider>/<model> for turns that name none. Absent: the first available model.",
      }),
      systemPrompt: Schema.optional(Schema.String).annotations({ description: "Replaces the default base prompt; the environment section is still added." }),
      maxSteps: Schema.optionalWith(Schema.Int.pipe(Schema.positive()), { default: () => 200 }).annotations({
        description: "Model calls allowed in one turn before it ends with max-steps.",
      }),
    }),
    tools: Schema.Struct({
      maxResultChars: Schema.optionalWith(Schema.Int.pipe(Schema.positive()), { default: () => 100_000 }).annotations({
        description: "Total text characters one result may carry to the model.",
      }),
    }),
    "file-search": Schema.Struct({
      idleMinutes: Schema.optionalWith(Schema.Number.pipe(Schema.positive()), { default: () => 15 }).annotations({
        title: "Keep an index for",
        description: "Minutes a directory's index stays in memory after its last search; the next search opens it again.",
      }),
    }),
    transport: Schema.Struct({
      port: Schema.optionalWith(Schema.Number.pipe(Schema.int(), Schema.between(0, 65535)), { default: () => 7433 }).annotations({
        description: "0 asks the OS for a free port.",
      }),
      token: Schema.optional(Schema.NonEmptyString).annotations({ ...secret, description: "When absent, read from <home>/token, created at the first start." }),
    }),
  };
  const configRows: Record<string, Record<string, unknown>> = { transport: { token: "mock-token" } };
  const withConfig = (plugin: PluginStatus): PluginStatus => {
    const schema = configs[plugin.id];
    if (schema === undefined) return plugin;
    const fields = describeConfig(schema);
    return { ...plugin, configFields: fields, config: configValues(schema, configRows[plugin.id] ?? {}, fields) };
  };
  const plugins: PluginStatus[] = [
    bundled("host", { provides: ["lemma/Paths", "lemma/HostControl"], locked: "Reads the config files and loads every other plugin" }),
    bundled("interaction", { provides: ["lemma/Interaction"], locked: needed }),
    bundled("credentials", { provides: ["lemma/Credentials"], requires: ["lemma/Paths"], locked: needed }),
    bundled("llm", { provides: ["lemma/Llm"], requires: ["lemma/Credentials", "lemma/Interaction"], locked: needed }),
    bundled("tools", { provides: ["lemma/Tools"], locked: needed }),
    bundled("read", { requires: ["lemma/Tools"] }),
    bundled("write", { requires: ["lemma/Tools"] }),
    bundled("edit", { requires: ["lemma/Tools"] }),
    bundled("bash", { requires: ["lemma/Tools"] }),
    bundled("codemode", { requires: ["lemma/Tools"] }),
    bundled("mcp", {
      requires: ["lemma/Tools", "lemma/Credentials", "lemma/Interaction", "lemma/HostControl", "lemma/Paths"],
      contributes: [{ name: "lemma/mcp-managers", items: 1, keys: ["mcp"] }],
    }),
    bundled("sessions", { provides: ["lemma/Sessions"], requires: ["lemma/Paths"], locked: needed }),
    bundled("agent", { provides: ["lemma/Agent"], requires: ["lemma/Sessions", "lemma/Llm", "lemma/Tools", "lemma/HostControl"], locked: needed }),
    bundled("compaction", { requires: ["lemma/Sessions", "lemma/Llm"] }),
    bundled("project-context", { requires: ["lemma/Paths"] }),
    bundled("workspace", { provides: ["lemma/Workspace"], requires: ["lemma/Paths"], locked: needed }),
    bundled("file-search", { contributes: [{ name: "lemma/file-searchers", items: 1, keys: ["file-search"] }] }),
    bundled("commands", { provides: ["lemma/Commands"], locked: needed }),
    bundled("commands-host", { requires: ["lemma/Commands", "lemma/Interaction", "lemma/HostControl"] }),
    bundled("commands-llm", { requires: ["lemma/Commands", "lemma/Interaction", "lemma/Llm"] }),
    bundled("commands-workspace", { requires: ["lemma/Commands", "lemma/Interaction", "lemma/Workspace"] }),
    bundled("transport", {
      requires: ["lemma/Paths", "lemma/Sessions", "lemma/Agent", "lemma/Llm", "lemma/HostControl", "lemma/Workspace", "lemma/Commands"],
      locked: "Serves the web app and the CLI; replace it with another transport plugin instead of turning it off",
    }),
  ];
  // Wiring as the kernel reports it, so the inspector has hooks and observers to show.
  const wiring: Record<string, Partial<PluginStatus>> = {
    compaction: { hooks: [{ name: "lemma/agent.request", order: 0 }] },
    "project-context": { hooks: [{ name: "lemma/agent.request", order: 10 }] },
    bash: { hooks: [{ name: "lemma/tool.execute", order: 0 }] },
    agent: { hooks: [{ name: "lemma/agent.request", order: 0 }] },
    transport: {
      hooks: [{ name: "lemma/interaction.request", order: 0 }],
      observes: [
        "lemma/agent.turn.started",
        "lemma/agent.turn.ended",
        "lemma/session.appended",
        "lemma/session.changed",
        "lemma/notice",
        "lemma/plugins.changed",
      ],
    },
  };
  for (const [index, plugin] of plugins.entries()) plugins[index] = withConfig({ ...plugin, ...wiring[plugin.id] });
  let ui: UiComposition = { plugins: {}, enabledIn: {}, configIn: {}, files: [] };
  // Like the host: an enabled provider wins over a disabled one with the same capability.
  const providerOf = (key: string) =>
    plugins.find((plugin) => plugin.enabled && plugin.provides.includes(key)) ?? plugins.find((plugin) => plugin.provides.includes(key));
  const halted = () => {
    for (const plugin of plugins) {
      if (!plugin.enabled) continue;
      const missing = plugin.requires.map(providerOf).find((provider) => provider !== undefined && provider.state === "disabled");
      if (missing !== undefined) plugins[plugins.indexOf(plugin)] = { ...plugin, state: "disabled", haltedBy: missing.id };
      else if (plugin.state === "disabled") plugins[plugins.indexOf(plugin)] = { ...plugin, state: "active", haltedBy: undefined };
    }
  };
  const sessions = new Map<string, { info: SessionInfo; events: SessionEvent[] }>();
  const listeners = new Set<(event: HostEvent) => void>();
  const emit = (event: HostEvent) => {
    for (const listener of listeners) listener(event);
  };
  const pendingAnswers = new Map<string, (answer: InteractionAnswer | undefined) => void>();
  const openRequests = new Map<string, InteractionRequest>();
  const cancelled = new Set<string>();
  const running = new Set<string>();
  /** Prompts sent while a turn ran, as the agent queues them: steers join it after its tool step, follow-ups run next. */
  const queues = new Map<string, { readonly prompt: QueuedPrompt; readonly done: () => void; readonly fail: (error: Error) => void }[]>();
  const queueOf = (sessionId: string) => queues.get(sessionId) ?? [];
  /** Each change to a queue moves the mock's one revision on, which keeps each session's growing. */
  let queueRevision = 0;
  const queueChanged = (sessionId: string) =>
    emit({ type: "queue-changed", sessionId, queue: queueOf(sessionId).map((queued) => queued.prompt), revision: ++queueRevision });

  const create = (cwd = CWD, at = Date.now()): SessionInfo => {
    const info: SessionInfo = { id: id("s"), cwd, createdAt: at, updatedAt: at, lastSeq: 0 };
    sessions.set(info.id, { info, events: [] });
    return info;
  };
  const append = (sessionId: string, data: EventData, at = Date.now(), quiet = false): SessionEvent => {
    const session = sessions.get(sessionId)!;
    const event: SessionEvent = { seq: session.events.length + 1, id: id("e"), parent: session.info.leaf ?? null, at, data };
    session.events.push(event);
    session.info = {
      ...session.info,
      leaf: event.id,
      lastSeq: event.seq,
      updatedAt: at,
      ...(data.type === "title" ? { title: data.title } : {}),
    };
    if (!quiet) {
      emit({ type: "session-appended", sessionId, event });
      emit({ type: "session-changed", info: session.info });
    }
    return event;
  };

  // Seed history.
  if (!fresh) {
    const t0 = Date.now() - 3 * 3600_000;
    const s = create(CWD, t0).id;
    let t = t0;
    const at = (ms = 400) => (t += ms);
    append(s, { type: "title", title: "Fix flaky session log test" }, at(), true);
    append(s, { type: "turn-start", turnId: "t1" }, at(), true);
    append(
      s,
      {
        type: "message",
        turnId: "t1",
        message: {
          role: "user",
          timestamp: t,
          content: [{ type: "text", text: "The session-log test fails randomly on CI. Can you find out why and fix it?" }],
        },
      },
      at(),
      true,
    );
    append(s, { type: "step-start", turnId: "t1", stepId: "p1" }, at(), true);
    append(
      s,
      {
        type: "attempt",
        turnId: "t1",
        stepId: "p1",
        message: assistant([], usage(0, 0), "error", "529 overloaded_error: Overloaded"),
        timing: { startedAt: t, endedAt: at(900) },
      },
      t,
      true,
    );
    const callA = { type: "toolCall" as const, id: "c1", name: "bash", arguments: { command: "pnpm --filter @lemma/client test -- --reporter=dot" } };
    const callB = {
      type: "toolCall" as const,
      id: "c2",
      name: "read",
      arguments: { path: `${CWD}/packages/client/tests/session-log.test.ts`, offset: 30, limit: 40 },
    };
    append(
      s,
      {
        type: "message",
        turnId: "t1",
        stepId: "p1",
        timing: { startedAt: t, firstTokenAt: t + 700, endedAt: at(3200) },
        message: assistant(
          [
            {
              type: "thinking",
              thinking:
                "The test uses setTimeout(0) to wait for the repair fetch. If the fetch resolves later than a macrotask, the assertion races.\nLet me run it and look at the test.",
            },
            { type: "text", text: "Let me run the tests and look at the file." },
            callA,
            callB,
          ],
          usage(4200, 180, 12000),
          "toolUse",
        ),
      },
      t,
      true,
    );
    append(
      s,
      {
        type: "message",
        turnId: "t1",
        stepId: "p1",
        timing: { startedAt: t, endedAt: at(2400) },
        details: { exitCode: 1 },
        message: {
          role: "toolResult",
          toolCallId: "c1",
          toolName: "bash",
          isError: true,
          timestamp: t,
          content: [
            {
              type: "text",
              text: " ✓ mergeEvents (3)\n ✓ rpcUrl (1)\n × SessionLog > holds events beyond a gap\n   AssertionError: expected [ 1, 2 ] to deeply equal [ 1, 2, 3, 4, 5 ]\n\n Test Files  1 failed (1)\n      Tests  1 failed | 11 passed (12)",
            },
          ],
        },
      },
      t,
      true,
    );
    append(
      s,
      {
        type: "message",
        turnId: "t1",
        stepId: "p1",
        timing: { startedAt: t, endedAt: at(40) },
        message: {
          role: "toolResult",
          toolCallId: "c2",
          toolName: "read",
          isError: false,
          timestamp: t,
          content: [{ type: "text", text: '  it("holds events beyond a gap", async () => {\n    const file = range(1, 2);\n    ...\n    await settle();\n' }],
        },
      },
      t,
      true,
    );
    append(s, { type: "step-end", turnId: "t1", stepId: "p1" }, at(), true);
    const callC = {
      type: "toolCall" as const,
      id: "c3",
      name: "edit",
      arguments: {
        path: `${CWD}/packages/client/tests/session-log.test.ts`,
        oldText: "await settle();",
        newText: "await vi.waitFor(() => expect(s.calls).toHaveLength(2));",
      },
    };
    append(
      s,
      {
        type: "message",
        turnId: "t1",
        stepId: "p2",
        timing: { startedAt: t, firstTokenAt: t + 500, endedAt: at(2600) },
        message: assistant(
          [
            {
              type: "text",
              text: "The repair fetch is awaited with a single `setTimeout(0)`, which races when the fake fetch takes more than one macrotask. I'll wait for the call instead:",
            },
            callC,
          ],
          usage(5100, 240, 16200),
          "toolUse",
        ),
      },
      t,
      true,
    );
    append(
      s,
      {
        type: "message",
        turnId: "t1",
        stepId: "p2",
        timing: { startedAt: t, endedAt: at(30) },
        details: {
          diff: "--- a/packages/client/tests/session-log.test.ts\n+++ b/packages/client/tests/session-log.test.ts\n@@ -88,7 +88,7 @@\n     log.apply(ev(5));\n     expect(seqs(log.events)).toEqual([1, 2]);\n-    await settle();\n+    await vi.waitFor(() => expect(s.calls).toHaveLength(2));\n     expect(s.calls).toEqual([undefined, 2]);\n",
        },
        message: {
          role: "toolResult",
          toolCallId: "c3",
          toolName: "edit",
          isError: false,
          timestamp: t,
          content: [{ type: "text", text: "Edited packages/client/tests/session-log.test.ts" }],
        },
      },
      t,
      true,
    );
    append(
      s,
      {
        type: "message",
        turnId: "t1",
        stepId: "p3",
        timing: { startedAt: t, firstTokenAt: t + 400, endedAt: at(1800) },
        message: assistant(
          [
            {
              type: "text",
              text: "Fixed. The test now waits for the repair fetch explicitly:\n\n```ts\nawait vi.waitFor(() => expect(s.calls).toHaveLength(2));\n```\n\n- **Cause:** a timing assumption (`setTimeout(0)`) in the test, not a bug in `SessionLog`.\n- **Check:** ran the suite 50× locally with no failures.",
            },
          ],
          usage(5600, 120, 21000),
        ),
      },
      t,
      true,
    );
    append(s, { type: "turn-end", turnId: "t1", reason: "done" }, at(100), true);

    // A thread that used MCP servers' tools, as the chat titles them.
    const s3 = create(CWD, t0 - 5 * 3600_000).id;
    t = t0 - 5 * 3600_000;
    append(s3, { type: "title", title: "File the login redirect bug" }, at(), true);
    append(s3, { type: "turn-start", turnId: "m1" }, at(), true);
    append(
      s3,
      {
        type: "message",
        turnId: "m1",
        message: {
          role: "user",
          timestamp: t,
          content: [{ type: "text", text: "Check the login page drops ?next= after signing in, and file an issue if nobody has." }],
        },
      },
      at(),
      true,
    );
    const mcpCalls = [
      { type: "toolCall" as const, id: "m-c1", name: "mcp__playwright__browser_navigate", arguments: { url: "http://localhost:5173/login?next=/settings" } },
      { type: "toolCall" as const, id: "m-c2", name: "mcp__github__search_issues", arguments: { query: "repo:lemma-dev/lemma is:open login redirect next" } },
      {
        type: "toolCall" as const,
        id: "m-c3",
        name: "mcp__github__create_issue",
        arguments: {
          owner: "lemma-dev",
          repo: "lemma",
          title: "Login drops ?next= after signing in",
          body: "Signing in from /login?next=/settings lands on /.\n\nSteps: open /login?next=/settings, sign in.",
        },
      },
    ];
    const mcpResults = [
      "Navigated to http://localhost:5173/login?next=/settings\nAfter signing in: http://localhost:5173/",
      "No open issues match.",
      "Created issue #431: https://github.com/lemma-dev/lemma/issues/431",
    ];
    for (const [index, call] of mcpCalls.entries()) {
      append(
        s3,
        {
          type: "message",
          turnId: "m1",
          stepId: `m-p${index}`,
          timing: { startedAt: t, firstTokenAt: t + 300, endedAt: at(1400) },
          message: assistant([call], usage(3800 + index * 600, 90, 9000), "toolUse"),
        },
        t,
        true,
      );
      append(
        s3,
        {
          type: "message",
          turnId: "m1",
          stepId: `m-p${index}`,
          timing: { startedAt: t, endedAt: at(900) },
          message: {
            role: "toolResult",
            toolCallId: call.id,
            toolName: call.name,
            isError: false,
            timestamp: t,
            content: [{ type: "text", text: mcpResults[index]! }],
          },
        },
        t,
        true,
      );
    }
    append(
      s3,
      {
        type: "message",
        turnId: "m1",
        stepId: "m-p9",
        timing: { startedAt: t, firstTokenAt: t + 400, endedAt: at(1600) },
        message: assistant(
          [{ type: "text", text: "Confirmed: signing in from `/login?next=/settings` lands on `/`. Nobody had reported it, so I filed **#431**." }],
          usage(6400, 70, 14000),
        ),
      },
      t,
      true,
    );
    append(s3, { type: "turn-end", turnId: "m1", reason: "done" }, at(100), true);

    const s2 = create(`${HOME}/code/website`, t0 - 86400_000 * 2).id;
    append(s2, { type: "title", title: "Landing page copy" }, t0 - 86400_000 * 2, true);
    create(CWD, t0 - 86400_000);
  }

  const status: ConnectionStatus = { state: "connected", generation: 1, attempts: 0 };

  // ---------------------------------------------------------------- MCP servers
  /** A server as the fake `mcp` plugin keeps it: its spec with nothing hidden, its secrets, and its connection. */
  interface MockMcp {
    spec: McpServerSpec;
    readonly scope: "user" | "project";
    secrets: Record<string, string>;
    signedIn: boolean;
    status: McpStatus;
    since: number;
    error?: string | undefined;
    retryAt?: number | undefined;
    /** Seconds before the next retry after a failure; doubles each time. */
    backoff: number;
    catalog?: McpCatalog | undefined;
    protocol?: string | undefined;
    logs: McpLogEntry[];
    timer?: ReturnType<typeof setTimeout> | undefined;
  }
  /** The host's own environment, as `${NAME}` would read it. */
  const hostEnv = new Set(["HOME", "PATH", "USER", "SHELL"]);
  const mcpTransport = (spec: McpServerSpec) => spec.type ?? (spec.command !== undefined ? "stdio" : "http");
  const catalogFor = (spec: McpServerSpec): McpCatalog => {
    const target = `${spec.command ?? ""} ${(spec.args ?? []).join(" ")} ${spec.url ?? ""}`;
    if (spec.id in MCP_CATALOG && spec.id !== "generic") return MCP_CATALOG[spec.id]!;
    if (target.includes("@playwright/mcp")) return MCP_CATALOG["playwright"]!;
    if (target.includes("server-filesystem")) return MCP_CATALOG["filesystem"]!;
    if (target.includes("githubcopilot")) return MCP_CATALOG["github"]!;
    if (target.includes("linear.app")) return MCP_CATALOG["linear"]!;
    return MCP_CATALOG["generic"]!;
  };
  const toolsOf = (id: string, catalog: McpCatalog | undefined, disabled: readonly string[] = []): McpToolInfo[] =>
    (catalog?.tools ?? []).map(([name, title, description, hints]) => ({
      name,
      tool: `mcp__${id}__${name}`,
      ...(title === undefined ? {} : { title }),
      description,
      enabled: !disabled.includes(name),
      hints,
    }));
  const hostLog = (text: string, at = Date.now()): McpLogEntry => ({ at, source: "host", text });
  /** What connecting to `spec` finds, as the fake sees it: a command it cannot run, a service wanting a sign-in, or tools. */
  const reach = (spec: McpServerSpec, signedIn: boolean): { status: "ready" | "auth" | "error"; error?: string; log: McpLogEntry[]; catalog?: McpCatalog } => {
    const at = Date.now();
    if (mcpTransport(spec) === "stdio") {
      const line = joinCommandLine([spec.command ?? "", ...(spec.args ?? [])]);
      const program = (spec.command ?? "").split("/").pop() ?? "";
      if (!MCP_RUNNERS.has(program)) {
        return {
          status: "error",
          error: `Command not found: ${spec.command}`,
          log: [hostLog(`Starting ${line}`, at - 40), hostLog(`spawn ${spec.command} ENOENT`, at)],
        };
      }
      const catalog = catalogFor(spec);
      return {
        status: "ready",
        catalog,
        log: [
          hostLog(`Starting ${line}`, at - 900),
          { at: at - 400, source: "stderr", text: `${catalog.server.title ?? catalog.server.name} MCP server running on stdio` },
          hostLog(`Connected: ${catalog.server.name} ${catalog.server.version}, ${catalog.tools.length} tools`, at),
        ],
      };
    }
    if (MCP_AUTH_HOSTS.test(spec.url ?? "") && !signedIn) {
      return {
        status: "auth",
        error: "401 Unauthorized: the server asks for a sign-in",
        log: [hostLog(`POST ${spec.url} → 401 Unauthorized`, at), hostLog("It names an authorization server: sign in to connect", at)],
      };
    }
    const catalog = catalogFor(spec);
    return {
      status: "ready",
      catalog,
      log: [hostLog(`POST ${spec.url} → 200, session started`, at - 300), hostLog(`Connected: ${catalog.server.name} ${catalog.server.version}`, at)],
    };
  };
  const references = (spec: McpServerSpec): string[] =>
    [...JSON.stringify(spec).matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g)].map((match) => match[1]!);
  /** As clients see it: credential-like literals hidden. */
  const hide = (values: Readonly<Record<string, string>> | undefined) =>
    values === undefined
      ? undefined
      : Object.fromEntries(Object.entries(values).map(([key, value]) => [key, looksSecret(key) && !value.includes("${") ? MCP_HIDDEN : value]));
  /** A saved spec with what came back hidden kept as it was. */
  const unhide = (values: Readonly<Record<string, string>> | undefined, before: Readonly<Record<string, string>> | undefined) =>
    values === undefined
      ? undefined
      : Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value === MCP_HIDDEN ? (before?.[key] ?? "") : value]));
  const mcpInfo = (entry: MockMcp): McpServerInfo => {
    const { spec } = entry;
    const type = mcpTransport(spec);
    const env = hide(spec.env);
    const headers = hide(spec.headers);
    return {
      id: spec.id,
      spec: { ...spec, ...(env === undefined ? {} : { env }), ...(headers === undefined ? {} : { headers }) },
      type,
      scope: entry.scope,
      status: entry.status,
      ...(entry.error === undefined ? {} : { error: entry.error }),
      ...(entry.retryAt === undefined ? {} : { retryAt: entry.retryAt }),
      since: entry.since,
      ...(entry.status === "ready" && entry.catalog !== undefined ? { server: entry.catalog.server, protocol: entry.protocol ?? "2025-06-18" } : {}),
      ...(entry.status === "ready" && entry.catalog?.instructions !== undefined ? { instructions: entry.catalog.instructions } : {}),
      tools: entry.status === "ready" ? toolsOf(spec.id, entry.catalog, spec.disabledTools) : [],
      resources: entry.status === "ready" ? (entry.catalog?.resources ?? 0) : 0,
      prompts: entry.status === "ready" ? (entry.catalog?.prompts ?? 0) : 0,
      ...(type === "stdio" ? {} : { signedIn: entry.signedIn }),
      secrets: Object.keys(entry.secrets),
      missing: [...new Set(references(spec))].filter((name) => !(name in entry.secrets) && !hostEnv.has(name)),
    };
  };
  const mcpEntries: MockMcp[] = [];
  const mcpChanged = () => emit({ type: "mcp-changed", servers: mcpEntries.map(mcpInfo) });
  const settle = (entry: MockMcp, patch: Partial<MockMcp>) => {
    if (patch.status !== undefined && patch.status !== entry.status) entry.since = Date.now();
    Object.assign(entry, { error: undefined, retryAt: undefined, ...patch });
  };
  /** Connects (again), as the plugin does after a change: starting, then ready, a sign-in, or a failure retried with backoff. */
  const connect = (entry: MockMcp, delay = 700) => {
    clearTimeout(entry.timer);
    if (entry.spec.enabled === false) {
      settle(entry, { status: "off" });
      entry.logs.push(hostLog("Turned off"));
      return mcpChanged();
    }
    settle(entry, { status: "starting" });
    mcpChanged();
    entry.timer = setTimeout(() => {
      if (!mcpEntries.includes(entry)) return;
      const found = reach(entry.spec, entry.signedIn);
      entry.logs.push(...found.log);
      if (found.status === "error") {
        const retryAt = Date.now() + entry.backoff * 1000;
        settle(entry, { status: "error", error: found.error, retryAt });
        entry.logs.push(hostLog(`Retrying in ${entry.backoff}s`));
        entry.timer = setTimeout(() => connect(entry), entry.backoff * 1000);
        entry.backoff = Math.min(entry.backoff * 2, 300);
      } else {
        settle(entry, { status: found.status, error: found.error, catalog: found.catalog, backoff: 30 });
      }
      mcpChanged();
    }, delay);
  };
  const seedMcp = (spec: McpServerSpec, extra: Partial<MockMcp> = {}) => {
    const entry: MockMcp = {
      spec,
      scope: "user",
      secrets: {},
      signedIn: false,
      status: "starting",
      since: Date.now() - 3600_000,
      backoff: 30,
      logs: [],
      ...extra,
    };
    const found = reach(spec, entry.signedIn);
    entry.logs.push(...found.log.map((line) => ({ ...line, at: line.at - 3600_000 })));
    if (spec.enabled === false) settle(entry, { status: "off" });
    else if (found.status === "error") {
      entry.logs.push(hostLog("Retrying in 30s"));
      settle(entry, { status: "error", error: found.error, retryAt: Date.now() + 30_000 });
      entry.timer = setTimeout(() => connect(entry), 30_000);
      entry.backoff = 60;
    } else settle(entry, { status: found.status, error: found.error, catalog: found.catalog });
    entry.since = Date.now() - 3600_000;
    mcpEntries.push(entry);
  };
  if (!fresh) {
    seedMcp({ id: "playwright", name: "Playwright", command: "npx", args: ["@playwright/mcp@0.0.41"] });
    // A token from the host's store, by reference: the config never holds it.
    seedMcp(
      {
        id: "github",
        name: "GitHub",
        url: "https://api.githubcopilot.com/mcp/",
        headers: { Authorization: "Bearer ${GITHUB_TOKEN}" },
        disabledTools: ["update_issue", "merge_pull_request"],
      },
      { secrets: { GITHUB_TOKEN: "ghp_mock" }, scope: "project" },
    );
    seedMcp({ id: "linear", name: "Linear", url: "https://mcp.linear.app/mcp" });
    // A password written into the config by hand, which clients see as `MCP_HIDDEN`, and a variable nothing sets.
    seedMcp({
      id: "postgres",
      name: "Postgres",
      command: "postgres-mcp",
      args: ["--access-mode=restricted"],
      env: { DATABASE_URI: "${DATABASE_URI}", DB_PASSWORD: "hunter2" },
    });
    seedMcp({ id: "notes", name: "Notes", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", `${HOME}/notes`], enabled: false });
  }
  const mcpReady = () => {
    if (plugins.find((plugin) => plugin.id === "mcp")?.state !== "active") {
      throw new HostError({ code: "Unavailable", message: "No plugin manages MCP servers: turn on the host's mcp plugin" });
    }
  };
  const mcpEntry = (serverId: string) => {
    mcpReady();
    const entry = mcpEntries.find((candidate) => candidate.spec.id === serverId);
    if (entry === undefined) throw new HostError({ code: "NotFound", subject: serverId, message: `No MCP server "${serverId}"` });
    return entry;
  };

  const stream = async (sessionId: string, turnId: string, stepId: string, message: AssistantMessage) => {
    emit({ type: "delta", sessionId, turnId, stepId, event: { type: "start" } });
    for (const [index, part] of message.content.entries()) {
      if (cancelled.has(sessionId)) return false;
      if (part.type === "text" || part.type === "thinking") {
        const text = part.type === "text" ? part.text : part.thinking;
        for (let i = 0; i < text.length; i += 6) {
          if (cancelled.has(sessionId)) return false;
          const delta = text.slice(i, i + 6);
          const event: StreamEvent = part.type === "text" ? { type: "text-delta", index, delta } : { type: "thinking-delta", index, delta };
          emit({ type: "delta", sessionId, turnId, stepId, event });
          await sleep(18);
        }
      } else if (part.type === "toolCall") {
        emit({ type: "delta", sessionId, turnId, stepId, event: { type: "toolcall-start", index, id: part.id, name: part.name } });
        const json = JSON.stringify(part.arguments);
        for (let i = 0; i < json.length; i += 8) {
          emit({ type: "delta", sessionId, turnId, stepId, event: { type: "toolcall-delta", index, delta: json.slice(i, i + 8) } });
          await sleep(15);
        }
        emit({ type: "delta", sessionId, turnId, stepId, event: { type: "toolcall-end", index, toolCall: part } });
      }
    }
    emit({ type: "delta", sessionId, turnId, stepId, event: { type: "done", message } });
    return true;
  };

  /** Answers as the model the turn names, else the first available one, as the host does. */
  const runTurn = async (sessionId: string, content: PromptContent, options?: TurnOptions, requestId?: string): Promise<void> => {
    const available = MODELS.filter((model) => providers.find((p) => p.id === model.provider)?.configured);
    const by = available.find((model) => model.ref === options?.model) ?? available[0] ?? MODELS[0]!;
    const turnId = id("t");
    const started = Date.now();
    append(sessionId, { type: "turn-start", turnId, model: by.ref });
    append(sessionId, { type: "message", turnId, message: { role: "user", content, timestamp: started }, ...(requestId === undefined ? {} : { requestId }) });
    emit({ type: "turn-started", sessionId, turnId });
    running.add(sessionId);
    const text = content.find((part) => part.type === "text")?.text ?? "(image)";
    let total = emptyUsage;
    /** Steers placed in this turn, answered when it ends. */
    const steered: (() => void)[] = [];
    const end = (reason: "done" | "cancelled") => {
      append(sessionId, { type: "turn-end", turnId, reason });
      emit({ type: "turn-ended", sessionId, turnId, usage: total, reason });
      running.delete(sessionId);
      cancelled.delete(sessionId);
      for (const done of steered) done();
      const [next, ...rest] = queueOf(sessionId);
      if (reason === "done" && next !== undefined) {
        queues.set(sessionId, rest);
        queueChanged(sessionId);
        void runTurn(sessionId, next.prompt.content, next.prompt.options, next.prompt.requestId).then(next.done, next.fail);
      }
    };
    const step1 = id("p");
    const startedAt = Date.now();
    const call = { type: "toolCall" as const, id: id("c"), name: "bash", arguments: { command: "ls -la packages" } };
    const m1 = assistant(
      [
        { type: "thinking", thinking: `The user said: "${text.slice(0, 60)}". I'll look around the repo first.` },
        { type: "text", text: "Let me look at the workspace layout first." },
        call,
      ],
      usage(3000, 90, 8000),
      "toolUse",
      undefined,
      by,
    );
    if (!(await stream(sessionId, turnId, step1, m1))) return end("cancelled");
    total = m1.usage;
    append(sessionId, { type: "message", turnId, stepId: step1, message: m1, timing: { startedAt, firstTokenAt: startedAt + 300, endedAt: Date.now() } });
    // The command prints as it runs, like the host's bash tool.
    for (const line of ["drwxr-xr-x client\n", "drwxr-xr-x contracts\n", "drwxr-xr-x core\n"]) {
      await sleep(300);
      emit({ type: "tool-output", sessionId, toolCallId: call.id, chunk: line });
    }
    if (cancelled.has(sessionId)) return end("cancelled");
    append(sessionId, {
      type: "message",
      turnId,
      stepId: step1,
      details: { exitCode: 0 },
      timing: { startedAt: Date.now() - 900, endedAt: Date.now() },
      message: {
        role: "toolResult",
        toolCallId: call.id,
        toolName: "bash",
        isError: false,
        timestamp: Date.now(),
        content: [{ type: "text", text: "drwxr-xr-x client\ndrwxr-xr-x contracts\ndrwxr-xr-x core" }],
      },
    });
    // Steers sent meanwhile join the turn here, between its steps.
    const steers = queueOf(sessionId).filter((queued) => queued.prompt.mode === "steer");
    if (steers.length > 0) {
      queues.set(
        sessionId,
        queueOf(sessionId).filter((queued) => queued.prompt.mode !== "steer"),
      );
      for (const steer of steers) {
        append(sessionId, {
          type: "message",
          turnId,
          requestId: steer.prompt.requestId,
          message: { role: "user", content: steer.prompt.content, timestamp: Date.now() },
        });
        steered.push(steer.done);
      }
      queueChanged(sessionId);
    }
    const step2 = id("p");
    const s2 = Date.now();
    const m2 = assistant(
      [
        {
          type: "text",
          text: `There are three packages: **client**, **contracts**, and **core**.\n\nYou asked: _${text.slice(0, 120)}_ — this is the mock host, so that's as far as I go. Try:\n\n1. The model picker (Ctrl+K)\n2. Esc to stop a turn\n3. Settings → Providers for the login flow, or from a shell:\n\n   \`\`\`sh\n   lemma models --all\n   \`\`\`\n\nHow they depend on each other:\n\n\`\`\`mermaid\ngraph LR\n  client --> contracts\n  core --> effect\n  contracts --> core\n\`\`\`\n\nAnd the entry point:\n\n\`\`\`ts\nimport { boot } from "./ui/boot.tsx";\n\nawait boot({ host, token, bundled, api, element, safe: false });\n\`\`\``,
        },
      ],
      usage(3300, 110, 11000),
      "stop",
      undefined,
      by,
    );
    if (!(await stream(sessionId, turnId, step2, m2))) return end("cancelled");
    total = { ...total, input: total.input + m2.usage.input, output: total.output + m2.usage.output };
    append(sessionId, { type: "message", turnId, stepId: step2, message: m2, timing: { startedAt: s2, firstTokenAt: s2 + 250, endedAt: Date.now() } });
    end("done");
    const info = sessions.get(sessionId)!.info;
    if (info.title === undefined) append(sessionId, { type: "title", title: text.slice(0, 48) });
  };

  const ask = (request: Parameters<typeof emit>[0] & { type: "interaction" }) =>
    new Promise<InteractionAnswer | undefined>((resolve) => {
      pendingAnswers.set(request.request.id, resolve);
      openRequests.set(request.request.id, request.request);
      emit(request);
    });

  const mockBranches = ["main", "harness", "composer-polish", "origin/release"];
  let currentBranch = "harness";
  const workspaceStatus = (path: string) => ({
    path,
    exists: true,
    git: { root: path, branch: currentBranch, head: "84c3bfc", changes: 3, upstream: `origin/${currentBranch}`, ahead: 1, behind: 0 },
  });

  const notFound = (sessionId: string) => new Error(`Session ${sessionId} not found`);

  /** Every project has these: the composer's `@` searches them. */
  const mockFiles = [
    "README.md",
    "package.json",
    "src/main.ts",
    "src/app.tsx",
    "src/components/Composer.tsx",
    "src/components/Sidebar.tsx",
    "src/lib/format.ts",
    "src/styles.css",
    "tests/app.test.ts",
    "flake.nix",
    "Dockerfile",
    ".gitignore",
    "scripts/release.sh",
    "tools/codegen.py",
  ];
  const mockEntries = [
    ...mockFiles.map((path) => ({ path, kind: "file" as const })),
    ...["src", "src/components", "src/lib", "tests"].map((path) => ({ path, kind: "directory" as const })),
  ];

  return {
    session: {
      list: async () => [...sessions.values()].map((s) => s.info).sort((a, b) => b.updatedAt - a.updatedAt),
      get: async (sessionId) => {
        const s = sessions.get(sessionId);
        if (!s) throw notFound(sessionId);
        return s.info;
      },
      create: async (cwd) => {
        const info = create(cwd);
        emit({ type: "session-changed", info });
        return info;
      },
      events: async (sessionId, after) => {
        await sleep(120);
        const s = sessions.get(sessionId);
        if (!s) throw notFound(sessionId);
        return s.events.filter((e) => e.seq > (after ?? 0));
      },
      checkout: async (sessionId) => sessions.get(sessionId)!.info,
      setTitle: async (sessionId, title) => {
        append(sessionId, { type: "title", title });
        return sessions.get(sessionId)!.info;
      },
      mark: async (sessionId, marks) => {
        const s = sessions.get(sessionId);
        if (!s) throw notFound(sessionId);
        const { pinned: _pinned, archived: _archived, ...rest } = s.info;
        const pinned = marks.pinned ?? s.info.pinned === true;
        const archived = marks.archived ?? s.info.archived === true;
        s.info = { ...rest, ...(pinned ? { pinned } : {}), ...(archived ? { archived } : {}) };
        emit({ type: "session-changed", info: s.info });
        return s.info;
      },
      remove: async (sessionId) => {
        if (!sessions.has(sessionId)) throw notFound(sessionId);
        if (running.has(sessionId)) throw new Error("A turn is running in this session; stop it before deleting");
        sessions.delete(sessionId);
        emit({ type: "session-removed", sessionId });
      },
    },
    agent: {
      prompt: async (sessionId, content, options, submit) => {
        if (!running.has(sessionId)) return runTurn(sessionId, content, options, submit?.requestId);
        const mode = submit?.whenBusy ?? "follow-up";
        if (mode === "reject") throw new HostError({ code: "Busy", subject: sessionId, message: "A turn is already running" });
        await new Promise<void>((resolve, reject) => {
          const prompt: QueuedPrompt = {
            requestId: submit?.requestId ?? id("r"),
            content,
            mode,
            at: Date.now(),
            ...(options === undefined ? {} : { options }),
          };
          queues.set(sessionId, [...queueOf(sessionId), { prompt, done: resolve, fail: reject }]);
          queueChanged(sessionId);
        });
      },
      cancel: async (sessionId) => {
        if (running.has(sessionId)) cancelled.add(sessionId);
      },
      running: async () => [...running],
      queue: async (sessionId) => queueOf(sessionId).map((queued) => queued.prompt),
      withdraw: async (sessionId, requestId) => {
        const found = queueOf(sessionId).find((queued) => queued.prompt.requestId === requestId);
        if (found === undefined) return false;
        queues.set(
          sessionId,
          queueOf(sessionId).filter((queued) => queued !== found),
        );
        found.fail(new HostError({ code: "Withdrawn", subject: sessionId, message: "The prompt was withdrawn from the queue" }));
        queueChanged(sessionId);
        return true;
      },
      view: async (sessionId) => ({ output: [], queue: queueOf(sessionId).map((queued) => queued.prompt), queueRevision }),
    },
    llm: {
      providers: async () => providers.slice(),
      models: async () => MODELS.filter((model) => providers.find((p) => p.id === model.provider)?.configured),
      login: async (provider, type) => {
        const p = providers.find((x) => x.id === provider)!;
        if (type === "api_key") {
          const answer = await ask({
            type: "interaction",
            request: { type: "ask", id: id("i"), origin: `login:${p.id}`, title: `${p.name} API key`, placeholder: "sk-…", secret: true },
          });
          if (answer === undefined || answer.type !== "ask" || answer.value === "") throw new Error("Login cancelled");
        } else {
          const answer = await ask({
            type: "interaction",
            request: {
              type: "select",
              id: id("i"),
              origin: `login:${p.id}`,
              title: `Log in to ${p.name}`,
              options: [
                { value: "browser", label: "Open browser", description: "Sign in on the provider's site" },
                { value: "device", label: "Device code", description: "Enter a code on another device" },
              ],
            },
          });
          if (answer === undefined) throw new Error("Login cancelled");
          emit({
            type: "notice",
            notice: {
              level: "info",
              source: "lemma/llm-pi-ai",
              message: `Enter this code to finish logging in to ${p.name}`,
              code: "WDJB-MJHT",
              links: [{ url: "https://github.com/login/device", label: "Open login page" }],
            },
          });
          await sleep(4000);
        }
        const i = providers.indexOf(p);
        providers[i] = { ...p, configured: true, source: type === "oauth" ? "OAuth" : "auth.json" };
        emit({ type: "notice", notice: { level: "info", source: "llm", message: `Logged in to ${p.name}` } });
      },
      logout: async (provider) => {
        const i = providers.findIndex((x) => x.id === provider);
        const { source: _source, ...rest } = providers[i]!;
        providers[i] = { ...rest, configured: false };
      },
      // Like the llm plugin: an id from the name, free among the providers; listed once "saved".
      addCustom: async (spec) => {
        await sleep(300);
        const base =
          spec.name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "") || "custom";
        let id = base;
        for (let n = 2; providers.some((provider) => provider.id === id); n++) id = `${base}-${n}`;
        providers.push({
          id,
          name: spec.name,
          auth: [{ type: "api_key", name: `${spec.name} API key`, interactive: true }],
          configured: spec.key !== true,
          ...(spec.key === true ? {} : { source: "no key required" }),
          custom: true,
        });
        return id;
      },
      removeCustom: async (provider) => {
        await sleep(300);
        const at = providers.findIndex((candidate) => candidate.id === provider && candidate.custom);
        if (at === -1) throw new HostError({ code: "LlmError", message: `No provider "${provider}" was added by the user`, subject: provider });
        providers.splice(at, 1);
      },
      setLogo: async (provider, svg) => {
        await sleep(200);
        const at = providers.findIndex((candidate) => candidate.id === provider && candidate.custom);
        if (at === -1) throw new HostError({ code: "LlmError", message: `No provider "${provider}" was added by the user`, subject: provider });
        const { logo: _logo, ...rest } = providers[at]!;
        providers[at] = svg === undefined ? rest : { ...rest, logo: svg };
      },
    },
    mcp: {
      servers: async () => {
        mcpReady();
        return mcpEntries.map(mcpInfo);
      },
      save: async (spec, options) => {
        mcpReady();
        await sleep(250);
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(spec.id))
          throw new HostError({ code: "Invalid", subject: spec.id, message: `"${spec.id}" is not a server id` });
        const before = mcpEntries.find((candidate) => candidate.spec.id === spec.id);
        const env = unhide(spec.env, before?.spec.env);
        const headers = unhide(spec.headers, before?.spec.headers);
        const saved: McpServerSpec = { ...spec, ...(env === undefined ? {} : { env }), ...(headers === undefined ? {} : { headers }) };
        const entry: MockMcp = before ?? {
          spec: saved,
          scope: "user",
          secrets: {},
          signedIn: false,
          status: "starting",
          since: Date.now(),
          backoff: 30,
          logs: [],
        };
        entry.spec = saved;
        for (const [name, value] of Object.entries(options?.secrets ?? {})) {
          if (value === null) delete entry.secrets[name];
          else entry.secrets[name] = value;
        }
        if (before === undefined) mcpEntries.push(entry);
        entry.logs.push(hostLog(before === undefined ? "Added" : "Saved; connecting again"));
        entry.backoff = 30;
        connect(entry);
      },
      remove: async (serverId) => {
        const entry = mcpEntry(serverId);
        clearTimeout(entry.timer);
        mcpEntries.splice(mcpEntries.indexOf(entry), 1);
        mcpChanged();
      },
      setEnabled: async (serverId, enabled) => {
        const entry = mcpEntry(serverId);
        const { enabled: _enabled, ...rest } = entry.spec;
        entry.spec = enabled ? rest : { ...rest, enabled: false };
        entry.backoff = 30;
        connect(entry);
      },
      setTool: async (serverId, tool, enabled) => {
        const entry = mcpEntry(serverId);
        const disabled = (entry.spec.disabledTools ?? []).filter((name) => name !== tool);
        const { disabledTools: _disabled, ...rest } = entry.spec;
        const next = enabled ? disabled : [...disabled, tool];
        entry.spec = next.length === 0 ? rest : { ...rest, disabledTools: next };
        mcpChanged();
      },
      restart: async (serverId) => {
        const entry = mcpEntry(serverId);
        entry.backoff = 30;
        entry.logs.push(hostLog("Restarting"));
        connect(entry);
      },
      // Like the plugin: the authorization page as a notice, and a question for where it sent you, in case its callback
      // cannot reach the host; the fake's callback arrives after a moment.
      login: async (serverId) => {
        const entry = mcpEntry(serverId);
        if (mcpTransport(entry.spec) === "stdio") throw new HostError({ code: "Invalid", subject: serverId, message: "Only URL servers sign in" });
        const name = entry.spec.name ?? entry.spec.id;
        const origin = new URL(entry.spec.url ?? "https://example.com").origin;
        emit({
          type: "notice",
          notice: {
            level: "info",
            source: `mcp:${serverId}`,
            message: `Open the page to sign in to ${name}`,
            links: [{ url: `${origin}/authorize?client_id=lemma-mock&redirect_uri=http%3A%2F%2F127.0.0.1%3A41733%2Fcallback`, label: "Sign in" }],
          },
        });
        const question: InteractionRequest = {
          type: "ask",
          id: id("i"),
          origin: `mcp:${serverId}`,
          title: "Paste the address the sign-in page sent you to, if it did not return here",
          placeholder: "http://127.0.0.1:41733/callback?code=…",
        };
        const callback = new Promise<"callback">((resolve) => setTimeout(() => resolve("callback"), 2500));
        const answered = await Promise.race([ask({ type: "interaction", request: question }), callback]);
        if (openRequests.has(question.id)) {
          pendingAnswers.delete(question.id);
          openRequests.delete(question.id);
          emit({ type: "interaction-closed", id: question.id });
        }
        if (answered === undefined) throw new HostError({ code: "Cancelled", subject: serverId, message: "Sign-in cancelled" });
        entry.signedIn = true;
        entry.logs.push(hostLog("Signed in"));
        connect(entry, 400);
        await sleep(500);
      },
      logout: async (serverId) => {
        const entry = mcpEntry(serverId);
        entry.signedIn = false;
        entry.logs.push(hostLog("Signed out"));
        connect(entry, 300);
      },
      logs: async (serverId) => mcpEntry(serverId).logs.slice(-200),
    },
    workspace: {
      status: async (path) => workspaceStatus(path),
      browse: async (partialPath) => {
        const parent = partialPath.endsWith("/") ? partialPath.replace(/\/+$/, "") || "/" : partialPath.slice(0, partialPath.lastIndexOf("/")) || "/";
        const needle = partialPath.endsWith("/") ? "" : partialPath.slice(partialPath.lastIndexOf("/") + 1).toLowerCase();
        const names = ["lemma", "dotfiles", "nix-config", "notes", "pi-extensions", "tau"];
        const entries = names
          .filter((name) => name.includes(needle))
          .map((name) => ({
            name,
            path: `${parent}/${name}`,
            git: name !== "notes",
            matches: needle === "" ? [] : Array.from({ length: needle.length }, (_, i) => name.indexOf(needle) + i),
          }));
        return { parent, entries, truncated: false };
      },
      createDirectory: async (path) => ({ path, exists: true }),
      createWorktree: async (path, options) => {
        await sleep(300);
        const tree = `${HOME}/worktrees/${path.split("/").pop()}/${options.branch.replace(/\//g, "-")}`;
        return { path: tree, exists: true, git: { root: tree, branch: options.branch, head: "84c3bfc", changes: 0, ahead: 0, behind: 0, worktreeOf: path } };
      },
      branches: async () =>
        mockBranches.map((name, index) => ({
          name,
          current: name === currentBranch,
          remote: name.startsWith("origin/"),
          updatedAt: Date.now() - index * 3_600_000,
        })),
      checkout: async (path, branch, options) => {
        await sleep(250);
        const name = branch.replace(/^origin\//, "");
        if (options?.create === true || !mockBranches.includes(name)) mockBranches.unshift(name);
        currentBranch = name;
        return workspaceStatus(path);
      },
    },
    files: {
      search: async (cwd, query, options) => {
        await sleep(40);
        const within = options?.within?.replace(/\/+$/, "");
        if (within !== undefined && !mockEntries.some((entry) => entry.kind === "directory" && entry.path === within)) {
          throw new HostError({ code: "NotFound", message: `"${cwd}/${within}" is not a folder in ${cwd}`, subject: `${cwd}/${within}` });
        }
        const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
        const ranked = mockEntries
          .filter((entry) => options?.kind === undefined || entry.kind === options.kind)
          .filter((entry) => within === undefined || entry.path.startsWith(`${within}/`))
          .flatMap((entry) => {
            let score = 0;
            for (const token of tokens) {
              const found = fuzzy(entry.path, token);
              if (found === undefined) return [];
              score += found.score;
            }
            return [{ entry, score }];
          })
          .sort((a, b) => b.score - a.score);
        const limit = options?.limit ?? 50;
        return { root: cwd, entries: ranked.slice(0, limit).map((item) => item.entry), truncated: ranked.length > limit };
      },
    },
    interaction: {
      list: async () => [...openRequests.values()],
      answer: async (interactionId, answer) => {
        pendingAnswers.get(interactionId)?.(answer);
        pendingAnswers.delete(interactionId);
        openRequests.delete(interactionId);
        emit({ type: "interaction-closed", id: interactionId });
      },
      dismiss: async (interactionId) => {
        pendingAnswers.get(interactionId)?.(undefined);
        pendingAnswers.delete(interactionId);
        openRequests.delete(interactionId);
        emit({ type: "interaction-closed", id: interactionId });
      },
    },
    commands: {
      list: async () => MOCK_COMMANDS.slice(),
      run: async (commandId) => {
        const cancelled = () => new HostError({ code: "Cancelled", message: "Cancelled", subject: commandId });
        switch (commandId) {
          case "host.reload":
            await sleep(400);
            return { message: "Config reloaded: restarted lemma/agent" };
          case "workspace.checkout": {
            const answer = await ask({
              type: "interaction",
              request: {
                type: "select",
                id: id("i"),
                title: "Switch to which branch?",
                options: mockBranches.filter((name) => name !== currentBranch).map((name) => ({ value: name, label: name })),
              },
            });
            if (answer?.type !== "select") throw cancelled();
            await sleep(250);
            currentBranch = answer.value.replace(/^origin\//, "");
            return { message: `Switched to ${currentBranch}` };
          }
          case "workspace.new-branch": {
            const answer = await ask({ type: "interaction", request: { type: "ask", id: id("i"), title: "New branch name", placeholder: "feature/name" } });
            if (answer?.type !== "ask") throw cancelled();
            mockBranches.unshift(answer.value);
            currentBranch = answer.value;
            return { message: `Created and switched to ${answer.value}` };
          }
          default:
            throw new HostError({ code: "NotFound", message: `No command "${commandId}"`, subject: commandId });
        }
      },
    },
    host: {
      info: async () => ({
        version: "0.1.0-mock",
        cwd: CWD,
        home: HOME,
        composition: { id: "c0ffee1234abcd", plugins: plugins.map((p) => ({ id: p.id, ...(p.version === undefined ? {} : { version: p.version }) })) },
      }),
      plugins: async () => plugins.slice(),
      inspectors: async () => MOCK_INSPECTORS.map(({ snapshot: _snapshot, ...info }) => info),
      inspect: async (id) => {
        const found = MOCK_INSPECTORS.find((inspector) => inspector.id === id);
        if (found === undefined) throw new HostError({ code: "NotFound", subject: id, message: `No inspector "${id}"` });
        return found.snapshot();
      },
      restartPlugin: async (pluginId) => {
        await sleep(600);
        const i = plugins.findIndex((p) => p.id === pluginId);
        plugins[i] = { ...plugins[i]!, state: "active", fault: undefined, haltedBy: undefined };
        emit({ type: "plugins-changed", plugins: plugins.slice() });
      },
      reload: async () => {
        await sleep(400);
        return { started: [], restarted: ["agent"], stopped: [] };
      },
      configure: async (rows, options) => {
        await sleep(500);
        const before = plugins.filter((plugin) => plugin.state !== "disabled").map((plugin) => plugin.id);
        for (const [id, row] of Object.entries(rows)) {
          const i = plugins.findIndex((p) => p.id === id);
          if (i < 0) throw new HostError({ code: "ReloadError", message: `error [${id}]: No plugin "${id}"`, subject: id });
          if (plugins[i]!.locked !== undefined && row.enabled === false) {
            throw new HostError({ code: "ReloadError", message: `error [${id}]: "${id}" cannot be turned off: ${plugins[i]!.locked}`, subject: id });
          }
          if (row.add !== undefined || row.remove !== undefined) return { started: [], restarted: [id], stopped: [] };
          if (row.values !== undefined) {
            const next = { ...configRows[id] };
            for (const [key, value] of Object.entries(row.values)) {
              if (value === null) delete next[key];
              else next[key] = value;
            }
            configRows[id] = next;
            plugins[i] = withConfig(plugins[i]!);
            // Like the host: the transport needs every configurable plugin here, so the change applies after the reply.
            setTimeout(() => emit({ type: "plugins-changed", plugins: plugins.slice() }), 300);
            return { started: [], restarted: [], stopped: [], deferred: true };
          }
          if (row.enabled === undefined) continue;
          if (row.enabled) {
            for (const other of plugins) {
              if (other.id !== id && other.enabled && other.provides.some((key) => plugins[i]!.provides.includes(key))) {
                plugins[plugins.indexOf(other)] = { ...other, enabled: false, state: "disabled", scope: options?.scope ?? "user" };
              }
            }
          }
          plugins[i] = {
            ...plugins[i]!,
            enabled: row.enabled,
            state: row.enabled ? "active" : "disabled",
            scope: row.enabled ? undefined : (options?.scope ?? "user"),
          };
        }
        halted();
        emit({ type: "plugins-changed", plugins: plugins.slice() });
        const after = plugins.filter((plugin) => plugin.state !== "disabled").map((plugin) => plugin.id);
        return { started: after.filter((id) => !before.includes(id)), restarted: [], stopped: before.filter((id) => !after.includes(id)) };
      },
    },
    ui: {
      composition: async () => ui,
      configure: async (rows, options) => {
        await sleep(200);
        const plugins = { ...ui.plugins };
        const enabledIn = { ...ui.enabledIn };
        const configIn = { ...ui.configIn };
        const scope = options?.scope ?? "user";
        for (const [id, row] of Object.entries(rows)) {
          const next: { enabled?: boolean; config?: Record<string, unknown> } = { ...(plugins[id] as { enabled?: boolean; config?: Record<string, unknown> }) };
          if (row.enabled !== undefined) {
            if (row.enabled) delete next.enabled;
            else next.enabled = false;
            if (row.enabled) delete enabledIn[id];
            else enabledIn[id] = scope;
          }
          if (row.values !== undefined) {
            const config = { ...next.config };
            for (const [key, value] of Object.entries(row.values)) {
              if (value === null) delete config[key];
              else config[key] = value;
            }
            if (Object.keys(config).length === 0) delete next.config;
            else next.config = config;
            if (next.config === undefined) delete configIn[id];
            else configIn[id] = scope;
          }
          if (Object.keys(next).length === 0) delete plugins[id];
          else plugins[id] = next;
        }
        ui = { ...ui, plugins, enabledIn, configIn };
        emit({ type: "ui-changed", ui });
        return ui;
      },
    },
    status: () => status,
    onStatus: (listener) => {
      listener(status);
      return () => {};
    },
    onEvent: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close: async () => {},
  };
};
