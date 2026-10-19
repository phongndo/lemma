import type { ConnectionStatus, Host } from "@lemma/client";
import { Effect, Schema } from "effect";
import { HOST_API, HostError, configValues, describeConfig, providerOf, secret, wireCodec, withdrawnFrom } from "@lemma/contracts";
import { AgentChannels, ProfileChannels } from "@lemma/agent";
import { McpChannels } from "@lemma/mcp";
import { CommandChannels } from "@lemma/commands";
import { LlmChannels, emptyUsage } from "@lemma/llm";
import { branchOf, SessionChannels, searchLog, searchWords } from "@lemma/sessions";
import { matches, selectSpans, TraceChannels } from "@lemma/devtools";
import { compositionHistory } from "@lemma/composition";
import { FileChannels, WorkspaceChannels } from "@lemma/workspace";
import { SkillChannels } from "@lemma/skills";
import { fuzzy } from "@lemma/web/match";
import { createIntegrationsMock } from "./mock-integrations.ts";
import type {
  ChannelDeclaration,
  ChannelInfo,
  ConfigScope,
  InteractionAnswer,
  InteractionRequest,
  NoticePayload,
  PluginChange,
  PluginStatus,
  RuntimeEvent,
  SpanRecord,
  WebComposition,
} from "@lemma/contracts";
import type { AgentActivity, AgentView, PromptContent, PromptOutcome, QueuedPrompt, TurnOptions } from "@lemma/agent";
import type { AssistantMessage, LlmChange, ModelInfo, ProviderInfo, StreamEvent, Usage } from "@lemma/llm";
import type { EventData, SessionEvent, SessionInfo, SessionsChange } from "@lemma/sessions";

/**
 * Dev-only in-browser fake of the host (`?mock`, or `?mock=fresh` for a first
 * run with no sessions). It serves the bundled domains' channels as their
 * plugins do, streams included, and the runtime's own calls and events. Every
 * provider starts logged out, so the fake never looks like real credentials;
 * its login flow only pretends. Not shipped: `main.tsx` imports it only in dev.
 */

/**
 * The host plugins a real host bundles: every package in domains/ whose `lemma` manifest names a host half, by the id
 * its folder names (`domains/tools/bash` is `tools.bash`), as scripts/plugins.ts reads them.
 */
const HOST_PLUGINS = Object.entries(
  import.meta.glob<{ readonly lemma?: { readonly host?: string } }>("../../../domains/*/*/package.json", { eager: true, import: "default" }),
)
  .filter(([, manifest]) => manifest.lemma?.host !== undefined)
  .map(([path]) => path.split("/").slice(-3, -1).join("."))
  .sort();

const HOME = "/home/dev";
const CWD = `${HOME}/code/lemma`;
/** What the mock host's plugins let you look into, as a real host's `Inspectors` would. */
const MOCK_INSPECTORS = [
  {
    id: "tools.registered",
    title: "Tools",
    description: "Every tool the model can call, the plugin that registered it, and the guards that check calls",
    source: "tools.registry",
    snapshot: () => ({
      tools: ["read", "write", "edit", "bash", "codemode"].map((name) => ({ name, plugin: `tools.${name}`, description: `The ${name} tool` })),
      guards: [],
    }),
  },
  {
    id: "agent.turns",
    title: "Running turns",
    description: "Each session with a turn running now, and how long it has run",
    source: "agent.loop",
    snapshot: () => [],
  },
];

/**
 * The prompt that draws pages: a script (codemode) printing its calls as they settle and drawing a page from inside,
 * then a page the model draws itself (html_render), as the chat shows what tools draw, outside the fold.
 */
export const PAGE_PROMPT = "Draw a page";
/** A page's script reports what it can reach and the theme it has, each time the theme changes, for the UI check. */
const pageProbe = `<script>
const report = () => {
  let reach;
  try { reach = String(parent.document.title); } catch (error) { reach = error.name; }
  parent.postMessage({ type: "check-page", title: document.title, reach, bg: getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(), loaded: performance.timeOrigin }, "*");
};
new MutationObserver(report).observe(document.getElementById("lemma-theme"), { childList: true, characterData: true, subtree: true });
report();
</script>`;
const SCRIPT_PAGE = `<!doctype html><html><head><title>Commits</title></head><body><h3 style="margin:0 0 8px">Commits this week</h3><div style="display:flex;gap:6px;align-items:end;height:80px">${[
  40, 72, 28, 64, 50,
]
  .map((height, index) => `<div style="flex:1;height:${height}px;background:var(--chart-${index + 1});border-radius:4px"></div>`)
  .join("")}</div>${pageProbe}</body></html>`;
const MODEL_PAGE = `<!doctype html><html><head><title>Summary</title></head><body><h3 style="margin:0 0 8px">Summary</h3><div style="height:120px;padding:16px;box-sizing:border-box;background:var(--bg-raised);border-radius:var(--radius)">Three packages, one plugin each.</div>${pageProbe}</body></html>`;

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

/** The mock's tools and system prompt, as the agent logs them with a request. */
const MOCK_SPECS = ["bash", "read", "edit"].map((name) => ({ name, description: `The ${name} tool`, parameters: {} }));
const MOCK_SYSTEM = "You are an expert coding assistant.\n\nWorking directory: " + CWD;

/** A `request` event as the agent logs it: the prompt by source, and the handlers that shaped it (`AgentRequestHook`). */
const mockRequest = (turnId: string, stepId: string, model: string, handlers: Extract<EventData, { type: "request" }>["handlers"]): EventData => ({
  type: "request",
  turnId,
  stepId,
  model,
  composition: "mock-composition",
  system: MOCK_SYSTEM,
  tools: MOCK_SPECS,
  contributions: [
    { source: "agent.loop", kind: "system", label: "base", chars: MOCK_SYSTEM.length },
    ...MOCK_SPECS.map((spec) => ({ source: `tools.${spec.name}`, kind: "tool" as const, label: spec.name, chars: JSON.stringify(spec).length })),
  ],
  ...(handlers === undefined ? {} : { handlers }),
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

/** The skills every directory has, as `skills.files` finds them. */
const MOCK_SKILLS = [
  { name: "review", description: "Review a diff for bugs before it merges", path: "/home/me/.lemma/skills/review/SKILL.md", scope: "user" as const },
  {
    name: "release",
    description: "Cut a release: changelog, tag, and publish",
    path: "/home/me/project/.agents/skills/release/SKILL.md",
    scope: "project" as const,
  },
];

const MOCK_COMMANDS = [
  {
    id: "workspace.pull-request",
    title: "Open pull request…",
    category: "Git",
    description: "Open a pull request from the current branch",
    source: "workspace.commands",
  },
  {
    id: "workspace.new-branch",
    title: "Create branch…",
    category: "Git",
    description: "Create a branch from HEAD and switch to it",
    source: "workspace.commands",
  },
  {
    id: "workspace.checkout",
    title: "Switch branch…",
    category: "Git",
    description: "Check out another branch in the working directory",
    source: "workspace.commands",
  },
  { id: "host.reload", title: "Reload config", category: "Host", description: "Re-read the config files and apply them", source: "commands.host" },
  // What the mock's plugins say they add (`contributes`), so the palette and the Plugins page agree.
  { id: "host.restart-plugin", title: "Restart plugin…", category: "Host", description: "Restart a failed or halted plugin", source: "commands.host" },
  { id: "host.toggle-plugin", title: "Turn plugin on or off…", category: "Host", description: "Turn a plugin on or off", source: "commands.host" },
  { id: "llm.logout", title: "Log out of a provider…", category: "Providers", description: "Forget a provider's credentials", source: "llm.commands" },
];

const noChannel = (id: string) => new HostError({ code: "NotFound", subject: id, message: `No channel "${id}"` });

/** Listeners to one kind of what a plugin publishes, which its streams follow. */
const feed = <A>() => {
  const listeners = new Set<(value: A) => void>();
  return {
    publish: (value: A) => {
      for (const listener of listeners) listener(value);
    },
    subscribe: (listener: (value: A) => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
};

/**
 * A channel as the mock serves it, for the plugin `source`. A call that
 * `waits` on what its plugin leaving would end (a turn, a login, a command)
 * ends `Withdrawn` when that plugin restarts, as the host's do, and is made
 * again if it is `repeatable` (a prompt); a stream does whatever it is.
 */
type Served =
  | {
      readonly kind: "call";
      readonly declaration: ChannelDeclaration;
      readonly source: string;
      readonly waits?: boolean;
      readonly handle: (payload: any) => Promise<unknown>;
    }
  | {
      readonly kind: "stream";
      readonly declaration: ChannelDeclaration;
      readonly source: string;
      /** Sends what it sends, `subscribed` first; returns its stop. */
      readonly handle: (payload: any, send: (element: any) => void, fail: (error: HostError) => void) => () => void;
    };

const serveCall = <Payload, Success>(
  source: string,
  declaration: ChannelDeclaration<"call", Payload, Success>,
  handle: (payload: Payload) => Promise<Success>,
  options: { readonly waits?: boolean } = {},
): Served => ({ kind: "call", declaration, source, handle, ...options });

const serveStream = <Payload, Success>(
  source: string,
  declaration: ChannelDeclaration<"stream", Payload, Success>,
  handle: (payload: Payload, send: (element: Success) => void, fail: (error: HostError) => void) => () => void,
): Served => ({ kind: "stream", declaration, source, handle });

interface MockSpan {
  readonly id: string;
  readonly end: (status?: SpanRecord["status"]) => void;
}

/**
 * The host's trace as the mock keeps it (`devtools.trace`): spans for the turns it runs, made as the agent's work
 * makes them, and the composition's changes, from its start.
 */
const createMockTrace = (bundledIds: readonly string[]) => {
  const kept: SpanRecord[] = [];
  const listeners = new Set<(spans: readonly SpanRecord[]) => void>();
  let made = 0;
  const history = compositionHistory();
  history.applied("start", { started: bundledIds });
  return {
    begin: (name: string, attributes: SpanRecord["attributes"], parentId?: string): MockSpan => {
      const id = `mock-${++made}`;
      const start = Date.now();
      return {
        id,
        end: (status = "ok") => {
          const span: SpanRecord = {
            id,
            ...(parentId === undefined ? {} : { parentId }),
            traceId: "mock",
            name,
            start,
            ms: Date.now() - start,
            status,
            attributes,
          };
          kept.push(span);
          for (const listener of listeners) listener([span]);
        },
      };
    },
    spans: (): readonly SpanRecord[] => kept,
    subscribe: (listener: (spans: readonly SpanRecord[]) => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    history,
  };
};

export const createMockHost = (): Host => {
  const fresh = new URLSearchParams(location.search).get("mock") === "fresh";
  const key = { type: "api_key", name: "API key", interactive: true } as const;
  const oauth = (name: string) => ({ type: "oauth", name, interactive: true }) as const;
  /** The real llm plugin's providers (`llm.http`'s built-ins), as `Llm.providers` reports them. */
  const providers: ProviderInfo[] = [
    ["anthropic", "Anthropic", [key]],
    // As in the real llm plugin: OpenAI takes a key, or signs in with ChatGPT.
    ["openai", "OpenAI", [key, oauth("Sign in with ChatGPT")]],
    ["openrouter", "OpenRouter", [key]],
    ["opencode", "OpenCode Zen", [key]],
    ["opencode-go", "OpenCode Go", [key]],
    // Not `llm.http`'s: logins another provider of `Llm` can run, a device code and a question with documentation, so
    // the Providers page's ways of showing them stay checked (`ui:check`).
    ["github-copilot", "GitHub Copilot", [oauth("GitHub Copilot"), key]],
    ["amazon-bedrock", "Amazon Bedrock", [key]],
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
  // Mirrors of real config Schemas, so the Plugins page shows settings forms.
  const configs: Record<string, Schema.Codec<any, any>> = {
    "agent.loop": Schema.Struct({
      defaultModel: Schema.optional(Schema.String).annotate({
        description: "<provider>/<model> for turns that name none. Absent: the first available model.",
      }),
      systemPrompt: Schema.optional(Schema.String).annotate({ description: "Replaces the default base prompt; the environment section is still added." }),
      maxSteps: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)), Schema.withDecodingDefaultType(Effect.sync(() => 200))).annotate({
        description: "Model calls allowed in one turn before it ends with max-steps.",
      }),
      keepCancelled: Schema.Boolean.pipe(Schema.withDecodingDefaultType(Effect.sync(() => true))).annotate({
        description: "What the model wrote before the user stopped its reply stays in what it sees next.",
      }),
      maxRunning: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)), Schema.withDecodingDefaultType(Effect.sync(() => 16))).annotate({
        description: "Turns running at once, across sessions; another waits for one to end.",
      }),
    }),
    "tools.bash": Schema.Struct({
      timeout: Schema.Number.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)), Schema.withDecodingDefaultType(Effect.sync(() => 600))).annotate({
        title: "Default timeout",
        description: "Seconds a command may run when the model names no timeout; 0 for none.",
      }),
    }),
    "tools.registry": Schema.Struct({
      maxResultChars: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)), Schema.withDecodingDefaultType(Effect.sync(() => 100_000))).annotate({
        description: "Total text characters one result may carry to the model.",
      }),
    }),
    "workspace.search-fff": Schema.Struct({
      idleMinutes: Schema.Number.pipe(Schema.check(Schema.isGreaterThan(0)), Schema.withDecodingDefaultType(Effect.sync(() => 15))).annotate({
        title: "Keep an index for",
        description: "Minutes a directory's index stays in memory after its last search; the next search opens it again.",
      }),
    }),
    "transport.server": Schema.Struct({
      port: Schema.Number.pipe(
        Schema.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 65535 })),
        Schema.withDecodingDefaultType(Effect.sync(() => 7433)),
      ).annotate({
        description: "0 asks the OS for a free port.",
      }),
      token: Schema.optional(Schema.NonEmptyString).annotate({ ...secret, description: "When absent, read from <home>/token, created at the first start." }),
    }),
  };
  const configRows: Record<string, Record<string, unknown>> = { "transport.server": { token: "mock-token" } };
  const withConfig = (plugin: PluginStatus): PluginStatus => {
    const schema = configs[plugin.id];
    if (schema === undefined) return plugin;
    const fields = describeConfig(schema);
    return { ...plugin, configFields: fields, config: configValues(schema, configRows[plugin.id] ?? {}, fields) };
  };
  // What the host provides itself (`HostInfo.runtime`): no plugin, so no row.
  const runtime = ["lemma/Paths", "lemma/HostControl", "lemma/Interaction", "lemma/Trace", `lemma/api@${HOST_API}`];
  // Each host plugin as the real one reports itself: what it provides, requires, and adds. The plugins are the domains'
  // (`HOST_PLUGINS`); one not described here is a plugin that provides, requires, and adds nothing.
  const described: Readonly<Record<string, Partial<PluginStatus>>> = {
    "credentials.file": { provides: ["lemma/Credentials"], requires: ["lemma/Paths"] },
    "llm.http": { provides: ["lemma/Llm"], requires: ["lemma/Credentials", "lemma/Interaction"] },
    "llm.commands": {
      requires: ["lemma/Interaction", "lemma/Llm"],
      contributes: [{ name: "lemma/commands", items: 1, keys: ["llm.logout"] }],
    },
    "tools.registry": { provides: ["lemma/ToolRunner"] },
    "tools.read": { contributes: [{ name: "lemma/tools", items: 1, keys: ["read"] }] },
    "tools.write": { contributes: [{ name: "lemma/tools", items: 1, keys: ["write"] }] },
    "tools.edit": { contributes: [{ name: "lemma/tools", items: 1, keys: ["edit"] }] },
    "tools.patch": { contributes: [{ name: "lemma/tools", items: 1, keys: ["apply_patch"] }] },
    "tools.bash": { contributes: [{ name: "lemma/tools", items: 1, keys: ["bash"] }] },
    "tools.codemode": { requires: ["lemma/ToolRunner"], contributes: [{ name: "lemma/tools", items: 1, keys: ["codemode"] }] },
    "sessions.files": { provides: ["lemma/Sessions"], requires: ["lemma/Paths"] },
    "agent.loop": {
      provides: ["lemma/Agent"],
      requires: ["lemma/Sessions", "lemma/Llm", "lemma/ToolRunner", "lemma/HostControl"],
      contributes: [{ name: "lemma/agent.sections", items: 2, keys: ["agent.base", "agent.environment"] }],
    },
    "mcp.servers": { provides: ["lemma/Mcp"], requires: ["lemma/Paths"] },
    "context.compaction": { requires: ["lemma/Sessions", "lemma/Llm"] },
    "agent.profiles": { requires: ["lemma/Paths"], contributes: [{ name: "lemma/agent.sections", items: 1, keys: ["profile"] }] },
    "context.project": { requires: ["lemma/Paths"], contributes: [{ name: "lemma/agent.sections", items: 1, keys: ["project-context"] }] },
    "workspace.local": { provides: ["lemma/Workspace"], requires: ["lemma/Paths"] },
    "workspace.search-fff": { contributes: [{ name: "lemma/file-searchers", items: 1, keys: ["workspace.search-fff"] }] },
    "workspace.commands": {
      requires: ["lemma/Interaction", "lemma/Workspace"],
      contributes: [{ name: "lemma/commands", items: 2, keys: ["workspace.checkout", "workspace.new-branch"] }],
    },
    "commands.registry": { provides: ["lemma/CommandRunner"] },
    "commands.host": {
      requires: ["lemma/Interaction", "lemma/HostControl"],
      contributes: [{ name: "lemma/commands", items: 3, keys: ["host.reload", "host.restart-plugin", "host.toggle-plugin"] }],
    },
    "devtools.trace": { requires: ["lemma/Trace"] },
    "tools.ask": { requires: ["lemma/Interaction"], contributes: [{ name: "lemma/tools", items: 1, keys: ["ask_user"] }] },
    "tools.search-fff": { contributes: [{ name: "lemma/tools", items: 2, keys: ["grep", "find"] }] },
    // The `lemma` command's: the commands each domain adds reach it through its channels, so they require nothing.
    "cli.registry": { provides: ["lemma/CliRunner"] },
    "agent.cli": { contributes: [{ name: "lemma/cli-commands", items: 4 }] },
    "commands.cli": { contributes: [{ name: "lemma/cli-commands", items: 2 }] },
    "llm.cli": {
      contributes: [
        { name: "lemma/cli-commands", items: 4 },
        { name: "lemma/cli-checks", items: 1 },
      ],
    },
    "sessions.cli": { contributes: [{ name: "lemma/cli-commands", items: 6 }] },
    "workspace.cli": { contributes: [{ name: "lemma/cli-commands", items: 7 }] },
    // Pinned by the host, and needing the runtime only: nothing else is locked with it.
    "transport.server": {
      requires: ["lemma/Paths", "lemma/HostControl"],
      locked: "Serves the web app and the CLI; replace it with another transport plugin instead of turning it off",
    },
  };
  const strays = Object.keys(described).filter((id) => !HOST_PLUGINS.includes(id));
  if (strays.length > 0) throw new Error(`The mock host describes plugins no domain has: ${strays.join(", ")}`);
  const plugins: PluginStatus[] = HOST_PLUGINS.map((id) => bundled(id, described[id]));

  // Wiring as the kernel reports it, so the inspector has hooks and observers to show.
  const wiring: Record<string, Partial<PluginStatus>> = {
    "context.compaction": { hooks: [{ name: "lemma/agent.request", phase: "fit", rank: 1, order: 0 }] },
    "tools.bash": { hooks: [{ name: "lemma/tool.execute", order: 0 }] },
    "agent.loop": { hooks: [{ name: "lemma/agent.request", phase: "shape", rank: 0, order: 0 }] },
    "transport.server": {
      hooks: [{ name: "lemma/interaction.request", order: 0 }],
      observes: ["lemma/notice", "lemma/plugins.changed", "lemma/web.changed"],
    },
  };
  for (const [index, plugin] of plugins.entries()) plugins[index] = withConfig({ ...plugin, ...wiring[plugin.id] });
  let composition: WebComposition = { plugins: {}, enabledIn: {}, configIn: {}, files: [] };
  /** Writes rows as the host does into its config file, and tells the page, which plans its web halves from them. */
  const writeRows = (rows: Readonly<Record<string, PluginChange>>, scope: ConfigScope) => {
    const next = { ...composition.plugins };
    const enabledIn = { ...composition.enabledIn };
    const configIn = { ...composition.configIn };
    for (const [id, row] of Object.entries(rows)) {
      const entry: { enabled?: boolean; config?: Record<string, unknown> } = { ...(next[id] as { enabled?: boolean; config?: Record<string, unknown> }) };
      if (row.enabled !== undefined) {
        if (row.enabled) delete entry.enabled;
        else entry.enabled = false;
        if (row.enabled) delete enabledIn[id];
        else enabledIn[id] = scope;
      }
      if (row.values !== undefined) {
        const config = { ...entry.config };
        for (const [key, value] of Object.entries(row.values)) {
          if (value === null) delete config[key];
          else config[key] = value;
        }
        if (Object.keys(config).length === 0) delete entry.config;
        else entry.config = config;
        if (entry.config === undefined) delete configIn[id];
        else configIn[id] = scope;
      }
      if (Object.keys(entry).length === 0) delete next[id];
      else next[id] = entry;
    }
    composition = { ...composition, plugins: next, enabledIn, configIn };
    emit({ type: "web-changed", web: composition });
    const turned = (on: boolean) => Object.keys(rows).filter((id) => rows[id]!.enabled === on);
    mockTrace.history.applied("configure", { started: turned(true), stopped: turned(false) }, Object.keys(rows));
  };
  /** The `turn-started` events held back while the UI check holds them (`lemmaMock.holdTurnStarted`), or undefined. */
  let heldStarts: (() => void)[] | undefined;
  /** While the UI check holds them (`lemmaMock.holdSteers`), a turn waits here before placing the steers queued. */
  let heldSteers: { readonly released: Promise<void>; readonly release: () => void } | undefined;
  /** While the UI check holds it (`lemmaMock.holdScript`), the script that draws a page waits here after its first call. */
  let heldScript: { readonly released: Promise<void>; readonly release: () => void } | undefined;
  /** Prompts a plugin answers instead of placing them, by their text (`lemmaMock.answerPrompts`). */
  let answers = new Map<string, PromptOutcome>();
  /** Each worktree asked for, as asked (`lemmaMock.worktreesAsked`). */
  const worktreesAsked: unknown[] = [];
  const mockTrace = createMockTrace(plugins.map((plugin) => plugin.id));
  // For the UI check: web halves and stylesheets as the host would list them from `~/.lemma/plugins` (a `blob:` URL stands in for the served file).
  Object.assign(window, {
    lemmaMock: {
      setWebFiles: (files: WebComposition["files"]) => {
        composition = { ...composition, files };
        emit({ type: "web-changed", web: composition });
      },
      /** Holds each `turn-started` back until released: what a slow connection does to a prompt's acceptance. */
      holdTurnStarted: () => {
        heldStarts ??= [];
      },
      /** Publishes the `turn-started` events held back, and holds no more. */
      releaseTurnStarted: () => {
        const held = heldStarts ?? [];
        heldStarts = undefined;
        for (const start of held) start();
      },
      /** Holds a turn at the step where it places steers until released, so prompts queue and change meanwhile. */
      holdSteers: () => {
        if (heldSteers !== undefined) return;
        let release!: () => void;
        const released = new Promise<void>((resolve) => (release = resolve));
        heldSteers = { released, release };
      },
      /** Lets a held turn place its steers, and holds no more. */
      releaseSteers: () => {
        heldSteers?.release();
        heldSteers = undefined;
      },
      /** Holds the script that draws a page after its first call settles until released, so it shows running however slow the page. */
      holdScript: () => {
        if (heldScript !== undefined) return;
        let release!: () => void;
        const released = new Promise<void>((resolve) => (release = resolve));
        heldScript = { released, release };
      },
      /** Lets a held script make its next call, and holds no more. */
      releaseScript: () => {
        heldScript?.release();
        heldScript = undefined;
      },
      /** Answers a prompt whose text is a key as a plugin's `AgentInputHook` handler would, instead of placing it. */
      answerPrompts: (outcomes: Readonly<Record<string, PromptOutcome>>) => {
        answers = new Map(Object.entries(outcomes));
      },
      /** The worktrees the app has asked for, each as its call's payload. */
      worktreesAsked: () => worktreesAsked,
    },
  });
  const halted = () => {
    for (const plugin of plugins) {
      if (!plugin.enabled) continue;
      const missing = plugin.requires.map((key) => providerOf(plugins, key)).find((provider) => provider !== undefined && provider.state === "disabled");
      if (missing !== undefined) plugins[plugins.indexOf(plugin)] = { ...plugin, state: "disabled", haltedBy: missing.id };
      else if (plugin.state === "disabled") plugins[plugins.indexOf(plugin)] = { ...plugin, state: "active", haltedBy: undefined };
    }
  };
  const sessions = new Map<string, { info: SessionInfo; events: SessionEvent[] }>();
  /** The host's own events: the runtime's. Each domain's go to its streams, through the feeds below. */
  const listeners = new Set<(event: RuntimeEvent) => void>();
  const emit = (event: RuntimeEvent) => {
    for (const listener of listeners) listener(event);
  };
  const sessionChanges = feed<Exclude<SessionsChange, { type: "subscribed" }>>();
  /** Each append, and each session deleted, for `sessions.log`. */
  const logs = feed<{ readonly sessionId: string; readonly event?: SessionEvent }>();
  const activity = feed<Exclude<AgentActivity, { type: "subscribed" }>>();
  const modelChanges = feed<LlmChange>();
  /** The running turn per session as `agent.view` shows it: the step streaming now, and running tools' output so far. */
  const turns = new Map<
    string,
    {
      readonly turnId: string;
      draft?: { readonly stepId: string; seq: number; readonly blocks: AssistantMessage["content"][number][] };
      readonly output: Map<string, string>;
    }
  >();
  const pendingAnswers = new Map<string, (answer: InteractionAnswer | undefined) => void>();
  const openRequests = new Map<string, InteractionRequest>();
  /** Running logins, by provider, so `cancelLogin` can stop one. */
  const logins = new Map<string, AbortController>();
  /** Closes a question as if dismissed: its asker sees no answer. */
  const withdrawRequest = (requestId: string) => {
    pendingAnswers.get(requestId)?.(undefined);
    pendingAnswers.delete(requestId);
    openRequests.delete(requestId);
    emit({ type: "interaction-closed", id: requestId });
  };
  const cancelled = new Set<string>();
  const running = new Set<string>();
  /** Prompts sent while a turn ran, as the agent queues them: steers join it after its tool step, follow-ups run next. */
  const queues = new Map<string, { readonly prompt: QueuedPrompt; readonly done: () => void; readonly fail: (error: Error) => void }[]>();
  const queueOf = (sessionId: string) => queues.get(sessionId) ?? [];
  /** Each change to a queue moves the mock's one revision on, which keeps each session's growing. */
  let queueRevision = 0;
  const queueChanged = (sessionId: string) =>
    activity.publish({ type: "queue-changed", sessionId, queue: queueOf(sessionId).map((queued) => queued.prompt), revision: ++queueRevision });

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
      // What the log now holds leaves the running turn's view, as the agent's does.
      const turn = turns.get(sessionId);
      if (data.type === "message" && data.message.role === "toolResult") turn?.output.delete(data.message.toolCallId);
      else if ((data.type === "message" || data.type === "attempt") && data.stepId !== undefined && turn?.draft?.stepId === data.stepId) delete turn.draft;
      logs.publish({ sessionId, event });
      sessionChanges.publish({ type: "session-changed", info: session.info });
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
    // What the agent logs of each request: the prompt by source, and the handlers that shaped it.
    const request = (stepId: string, handlers: Extract<EventData, { type: "request" }>["handlers"]) => mockRequest("t1", stepId, MODELS[0]!.ref, handlers);
    // A call that failed and was asked again, as the agent logs it: the attempt closes its step, and the next asks again.
    append(s, { type: "step-start", turnId: "t1", stepId: "p0" }, at(), true);
    append(s, request("p0", [{ source: "context.compaction", ms: 0.31 }]), at(), true);
    append(
      s,
      {
        type: "attempt",
        turnId: "t1",
        stepId: "p0",
        message: assistant([], usage(0, 0), "error", "529 overloaded_error: Overloaded"),
        timing: { startedAt: t, endedAt: at(900) },
        failure: { kind: "transient" },
        retry: { reason: "failure", attempt: 1, at: t + 1200 },
      },
      t,
      true,
    );
    append(s, { type: "step-end", turnId: "t1", stepId: "p0" }, at(), true);
    append(s, { type: "step-start", turnId: "t1", stepId: "p1" }, at(), true);
    append(s, request("p1", [{ source: "context.compaction", ms: 0.27 }]), at(), true);
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
        credit: { handlers: [{ source: "tools.bash", ms: 0.12 }], checks: [{ source: "plan-mode", allowed: true, ms: 0.08 }] },
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
    append(s, { type: "step-end", turnId: "t1", stepId: "p1", decision: { result: "continue", why: "the model asked for tools" } }, at(), true);
    append(s, { type: "step-start", turnId: "t1", stepId: "p2" }, at(), true);
    append(s, request("p2", [{ source: "context.compaction", ms: 0.27 }]), at(), true);
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
        credit: { checks: [{ source: "plan-mode", allowed: true, ms: 0.06 }] },
      },
      t,
      true,
    );
    const edited = sessions.get(s)!.events.at(-1)!;
    append(s, { type: "step-end", turnId: "t1", stepId: "p2", decision: { result: "continue", why: "the model asked for tools" } }, at(), true);
    append(s, { type: "step-start", turnId: "t1", stepId: "p3" }, at(), true);
    // The history had grown past the compaction threshold: the request summarized what came before the edit.
    append(
      s,
      {
        type: "compaction",
        summary: "They asked why the session-log test fails on CI; the tests showed SessionLog > holds events beyond a gap failing.",
        firstKeptId: edited.id,
        tokensBefore: 18200,
        source: "context.compaction",
        turnId: "t1",
        usage: usage(18200, 140),
      },
      at(),
      true,
    );
    append(s, request("p3", [{ source: "context.compaction", ms: 1840.5, changed: ["+compaction"] }]), at(), true);
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
    append(s, { type: "step-end", turnId: "t1", stepId: "p3", decision: { result: "stop", why: "the model stopped (stop)" } }, at(), true);
    append(s, { type: "turn-end", turnId: "t1", reason: "done" }, at(100), true);

    const s2 = create(`${HOME}/code/website`, t0 - 86400_000 * 2).id;
    append(s2, { type: "title", title: "Landing page copy" }, t0 - 86400_000 * 2, true);
    // A turn whose model call failed, with the provider's response body in its message.
    t = t0 - 86400_000 * 2;
    const oauthError =
      'OAuth refresh failed for openai: OpenAI OAuth token request failed (400): { "error": "invalid_grant", "error_reason": "refresh_token_invalidated", "error_description": "The refresh token has been invalidated. A fresh sign-in is required." }. Run /login openai to sign in again.';
    append(s2, { type: "turn-start", turnId: "t1" }, at(), true);
    append(
      s2,
      { type: "message", turnId: "t1", message: { role: "user", timestamp: t, content: [{ type: "text", text: "Tighten the hero copy." }] } },
      at(),
      true,
    );
    append(s2, { type: "step-start", turnId: "t1", stepId: "p1" }, at(), true);
    append(
      s2,
      { type: "message", turnId: "t1", stepId: "p1", timing: { startedAt: t, endedAt: at(363) }, message: assistant([], usage(0, 0), "error", oauthError) },
      t,
      true,
    );
    append(s2, { type: "step-end", turnId: "t1", stepId: "p1" }, at(10), true);
    append(s2, { type: "turn-end", turnId: "t1", reason: "error", error: oauthError }, at(10), true);
    create(CWD, t0 - 86400_000);
  }

  // Sessions made while the page ran are kept across a reload, as a host keeps them: what it made before comes back,
  // and ids go on after theirs.
  const KEPT = "lemma.mock.sessions";
  const kept = new Set<string>();
  try {
    const saved = JSON.parse(sessionStorage.getItem(KEPT) ?? "[]") as { info: SessionInfo; events: SessionEvent[] }[];
    for (const session of saved) {
      sessions.set(session.info.id, session);
      kept.add(session.info.id);
      for (const made of [session.info.id, ...session.events.map((event) => event.id)]) idSeq = Math.max(idSeq, parseInt(made.slice(1), 36) || 0);
    }
  } catch {
    // Nothing kept: the seeded history alone.
  }
  const keepSessions = () => {
    try {
      sessionStorage.setItem(KEPT, JSON.stringify([...kept].flatMap((made) => sessions.get(made) ?? [])));
    } catch {
      // Storage off: a reload forgets them.
    }
  };
  addEventListener("pagehide", keepSessions);

  const status: ConnectionStatus = { state: "connected", generation: 1, attempts: 0 };

  /** Streams `message` as its step's deltas, numbered from 1 as the agent numbers them, keeping the draft `agent.view` shows. */
  const stream = async (sessionId: string, turnId: string, stepId: string, message: AssistantMessage) => {
    const draft = { stepId, seq: 0, blocks: [] as AssistantMessage["content"][number][] };
    const turn = turns.get(sessionId);
    if (turn !== undefined) turn.draft = draft;
    const delta = (event: StreamEvent) => {
      draft.seq++;
      const block = "index" in event ? draft.blocks[event.index] : undefined;
      if (event.type === "text-delta") draft.blocks[event.index] = { type: "text", text: (block?.type === "text" ? block.text : "") + event.delta };
      else if (event.type === "thinking-delta")
        draft.blocks[event.index] = { type: "thinking", thinking: (block?.type === "thinking" ? block.thinking : "") + event.delta };
      else if (event.type === "toolcall-start") draft.blocks[event.index] = { type: "toolCall", id: event.id, name: event.name, arguments: {} };
      else if (event.type === "toolcall-end") draft.blocks[event.index] = event.toolCall;
      activity.publish({ type: "delta", sessionId, turnId, stepId, seq: draft.seq, event });
    };
    delta({ type: "start" });
    for (const [index, part] of message.content.entries()) {
      if (cancelled.has(sessionId)) return false;
      if (part.type === "text" || part.type === "thinking") {
        const text = part.type === "text" ? part.text : part.thinking;
        for (let i = 0; i < text.length; i += 6) {
          if (cancelled.has(sessionId)) return false;
          const chunk = text.slice(i, i + 6);
          delta(part.type === "text" ? { type: "text-delta", index, delta: chunk } : { type: "thinking-delta", index, delta: chunk });
          await sleep(18);
        }
      } else if (part.type === "toolCall") {
        delta({ type: "toolcall-start", index, id: part.id, name: part.name });
        const json = JSON.stringify(part.arguments);
        for (let i = 0; i < json.length; i += 8) {
          delta({ type: "toolcall-delta", index, delta: json.slice(i, i + 8) });
          await sleep(15);
        }
        delta({ type: "toolcall-end", index, toolCall: part });
      }
    }
    delta({ type: "done", message });
    return true;
  };

  /** Answers as the model the turn names, else the first available one, as the host does. */
  const runTurn = async (sessionId: string, content: PromptContent, options?: TurnOptions, requestId?: string): Promise<void> => {
    const available = MODELS.filter((model) => providers.find((p) => p.id === model.provider)?.configured);
    const by = available.find((model) => model.ref === options?.model) ?? available[0] ?? MODELS[0]!;
    const turnId = id("t");
    const started = Date.now();
    const turnSpan = mockTrace.begin("agent.turn", { "session.id": sessionId, "turn.id": turnId, "turn.resumed": false, "plugin.id": "agent.loop" });
    /** Each step's number in the turn, which every span of its work carries, as the agent marks them. */
    const indexOf = new Map<string, number>();
    /** A step's spans as the agent makes them: the request and its handlers, then the model call while it streams. */
    const stepSpan = (stepId: string, index: number) => {
      indexOf.set(stepId, index);
      return mockTrace.begin(
        "agent.step",
        { "session.id": sessionId, "turn.id": turnId, "step.id": stepId, "step.index": index, "plugin.id": "agent.loop" },
        turnSpan.id,
      );
    };
    const asked = async (step: MockSpan, stepId: string, message: AssistantMessage) => {
      append(sessionId, { type: "step-start", turnId, stepId });
      append(sessionId, mockRequest(turnId, stepId, by.ref, [{ source: "context.compaction", ms: 0.29 }]));
      const where = { "session.id": sessionId, "turn.id": turnId, "step.id": stepId, "step.index": indexOf.get(stepId)! };
      const request = mockTrace.begin("agent.request", { ...where, "plugin.id": "agent.loop" }, step.id);
      for (const plugin of ["agent.loop", "context.compaction"]) {
        mockTrace.begin("core.hook", { ...where, "plugin.id": plugin, "hook.name": "lemma/agent.request", "hook.in.model": by.ref }, request.id).end();
      }
      request.end();
      const model = mockTrace.begin("agent.model", { ...where, "llm.model": by.ref, "plugin.id": "agent.loop" }, step.id);
      const ok = await stream(sessionId, turnId, stepId, message);
      model.end(ok ? "ok" : "interrupted");
      return ok;
    };
    const toolSpan = (step: MockSpan, stepId: string, call: { readonly id: string; readonly name: string }) =>
      mockTrace.begin(
        `tools.execute ${call.name}`,
        {
          "session.id": sessionId,
          "turn.id": turnId,
          "step.id": stepId,
          "step.index": indexOf.get(stepId)!,
          "tool.call.id": call.id,
          "tool.name": call.name,
          "plugin.id": "tools.registry",
        },
        step.id,
      );
    // As the agent does: the turn logs each plugin's choice for it (a thread's mode, `agent.profiles`).
    append(sessionId, { type: "turn-start", turnId, model: by.ref, ...(options?.plugins === undefined ? {} : { plugins: options.plugins }) });
    append(sessionId, { type: "message", turnId, message: { role: "user", content, timestamp: started }, ...(requestId === undefined ? {} : { requestId }) });
    running.add(sessionId);
    const turn = { turnId, output: new Map<string, string>() };
    turns.set(sessionId, turn);
    // Held when asked (`lemmaMock.holdTurnStarted`): the page has shown the turn running, but not yet seen it start.
    const publishStarted = () => activity.publish({ type: "turn-started", sessionId, turnId, requestIds: requestId === undefined ? [] : [requestId] });
    if (heldStarts !== undefined) heldStarts.push(publishStarted);
    else publishStarted();
    const text = content.find((part) => part.type === "text")?.text ?? "(image)";
    let total = emptyUsage;
    /** Steers placed in this turn, answered when it ends. */
    const steered: (() => void)[] = [];
    const end = (reason: "done" | "cancelled") => {
      turnSpan.end(reason === "done" ? "ok" : "interrupted");
      append(sessionId, { type: "turn-end", turnId, reason });
      turns.delete(sessionId);
      activity.publish({ type: "turn-ended", sessionId, turnId, usage: total, reason });
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
    if (text === PAGE_PROMPT) {
      // A script: its calls print as they settle, and the page it draws is kept in its result for the chat to show.
      const scriptStep = id("p");
      const scriptAt = Date.now();
      const script = {
        type: "toolCall" as const,
        id: id("c"),
        name: "codemode",
        arguments: {
          code: '// @options: {"timeout_ms": 60000}\nconst log = await tools.bash({ command: "git log --oneline -n 5" });\nawait tools.html_render({ title: "Commits", html: page(log.output) });\nreturn "drawn";',
        },
      };
      const scripted = assistant([{ type: "text", text: "I'll draw it with a script." }, script], usage(3000, 120, 8000), "toolUse", undefined, by);
      const scriptSpan = stepSpan(scriptStep, 1);
      if (!(await asked(scriptSpan, scriptStep, scripted))) return end("cancelled");
      append(sessionId, {
        type: "message",
        turnId,
        stepId: scriptStep,
        message: scripted,
        timing: { startedAt: scriptAt, firstTokenAt: scriptAt + 200, endedAt: Date.now() },
      });
      const running = toolSpan(scriptSpan, scriptStep, script);
      for (const [at, line] of ['✓ bash 12ms {"command":"git log --oneline -n 5"}\n', '✓ html_render 1ms {"title":"Commits"}\n'].entries()) {
        await sleep(400);
        const printed = turn.output.get(script.id) ?? "";
        turn.output.set(script.id, printed + line);
        activity.publish({ type: "tool-output", sessionId, toolCallId: script.id, chunk: line, offset: printed.length });
        if (at === 0 && heldScript !== undefined) await heldScript.released;
      }
      await sleep(400);
      if (cancelled.has(sessionId)) return end("cancelled");
      append(sessionId, {
        type: "message",
        turnId,
        stepId: scriptStep,
        details: {
          calls: [
            { name: "bash", args: '{"command":"git log --oneline -n 5"}', status: "ok", durationMs: 12 },
            { name: "html_render", args: '{"title":"Commits"}', status: "ok", durationMs: 1 },
          ],
          displays: [
            {
              name: "html_render",
              title: "Commits",
              content: [{ type: "text", text: 'Shown to the person as "Commits", above your reply.' }],
              details: { title: "Commits", html: SCRIPT_PAGE },
            },
          ],
        },
        timing: { startedAt: Date.now() - 1200, endedAt: Date.now() },
        message: {
          role: "toolResult",
          toolCallId: script.id,
          toolName: "codemode",
          isError: false,
          timestamp: Date.now(),
          content: [
            { type: "text", text: "Script completed\nWall time 1.2 seconds\nOutput:\n" },
            { type: "text", text: "drawn" },
          ],
        },
      });
      running.end();
      scriptSpan.end();
      append(sessionId, { type: "step-end", turnId, stepId: scriptStep, decision: { result: "continue", why: "the model asked for tools" } });
      // A page the model draws itself, and a script beside it that draws nothing, whose call shows nothing outside the fold.
      const drawStep = id("p");
      const drawAt = Date.now();
      const draw = { type: "toolCall" as const, id: id("c"), name: "html_render", arguments: { title: "Summary", html: MODEL_PAGE } };
      const quiet = { type: "toolCall" as const, id: id("c"), name: "codemode", arguments: { code: "return 2 + 2;" } };
      const drawing = assistant([draw, quiet], usage(3100, 400, 8000), "toolUse", undefined, by);
      const drawSpan = stepSpan(drawStep, 2);
      if (!(await asked(drawSpan, drawStep, drawing))) return end("cancelled");
      append(sessionId, {
        type: "message",
        turnId,
        stepId: drawStep,
        message: drawing,
        timing: { startedAt: drawAt, firstTokenAt: drawAt + 200, endedAt: Date.now() },
      });
      append(sessionId, {
        type: "message",
        turnId,
        stepId: drawStep,
        details: { title: "Summary", html: MODEL_PAGE },
        timing: { startedAt: Date.now() - 5, endedAt: Date.now() },
        message: {
          role: "toolResult",
          toolCallId: draw.id,
          toolName: "html_render",
          isError: false,
          timestamp: Date.now(),
          content: [{ type: "text", text: 'Shown to the person as "Summary", above your reply.' }],
        },
      });
      append(sessionId, {
        type: "message",
        turnId,
        stepId: drawStep,
        details: { calls: [] },
        timing: { startedAt: Date.now() - 5, endedAt: Date.now() },
        message: {
          role: "toolResult",
          toolCallId: quiet.id,
          toolName: "codemode",
          isError: false,
          timestamp: Date.now(),
          content: [
            { type: "text", text: "Script completed\nWall time 0.0 seconds\nOutput:\n" },
            { type: "text", text: "4" },
          ],
        },
      });
      drawSpan.end();
      append(sessionId, { type: "step-end", turnId, stepId: drawStep, decision: { result: "continue", why: "the model asked for tools" } });
      const answerStep = id("p");
      const answerAt = Date.now();
      const answered = assistant(
        [{ type: "text", text: "Both pages are above: the week's commits, and a summary." }],
        usage(3200, 30, 8000),
        "stop",
        undefined,
        by,
      );
      const answerSpan = stepSpan(answerStep, 3);
      if (!(await asked(answerSpan, answerStep, answered))) return end("cancelled");
      append(sessionId, {
        type: "message",
        turnId,
        stepId: answerStep,
        message: answered,
        timing: { startedAt: answerAt, firstTokenAt: answerAt + 150, endedAt: Date.now() },
      });
      answerSpan.end();
      append(sessionId, { type: "step-end", turnId, stepId: answerStep, decision: { result: "stop", why: "the model stopped (stop)" } });
      end("done");
      if (sessions.get(sessionId)!.info.title === undefined) append(sessionId, { type: "title", title: text });
      return;
    }
    const step1 = id("p");
    const startedAt = Date.now();
    const call = { type: "toolCall" as const, id: id("c"), name: "bash", arguments: { command: "ls -la packages" } };
    const m1 = assistant(
      [
        // Reasoning as some models return it: several parts in a row, each opening with a bold title.
        { type: "thinking", thinking: `**Reading the request**\n\nThe user said: "${text.slice(0, 60)}".` },
        { type: "thinking", thinking: "**Looking around the repo**\n\nI'll list the packages before answering." },
        { type: "text", text: "Let me look at the workspace layout first." },
        call,
      ],
      usage(3000, 90, 8000),
      "toolUse",
      undefined,
      by,
    );
    const span1 = stepSpan(step1, 1);
    if (!(await asked(span1, step1, m1))) return end("cancelled");
    total = m1.usage;
    append(sessionId, { type: "message", turnId, stepId: step1, message: m1, timing: { startedAt, firstTokenAt: startedAt + 300, endedAt: Date.now() } });
    // The command prints as it runs, like the host's bash tool.
    const listing = toolSpan(span1, step1, call);
    for (const line of ["drwxr-xr-x client\n", "drwxr-xr-x contracts\n", "drwxr-xr-x core\n"]) {
      await sleep(300);
      const printed = turn.output.get(call.id) ?? "";
      turn.output.set(call.id, printed + line);
      activity.publish({ type: "tool-output", sessionId, toolCallId: call.id, chunk: line, offset: printed.length });
    }
    if (cancelled.has(sessionId)) {
      // Stopped while the command ran: the call is answered as the host's tools answer one cut off, and its step ends.
      append(sessionId, {
        type: "message",
        turnId,
        stepId: step1,
        timing: { startedAt: Date.now() - 900, endedAt: Date.now() },
        message: {
          role: "toolResult",
          toolCallId: call.id,
          toolName: "bash",
          isError: true,
          timestamp: Date.now(),
          content: [{ type: "text", text: 'Tool "bash" was cancelled' }],
        },
      });
      listing.end("interrupted");
      span1.end("interrupted");
      append(sessionId, { type: "step-end", turnId, stepId: step1 });
      return end("cancelled");
    }
    append(sessionId, {
      type: "message",
      turnId,
      stepId: step1,
      details: { exitCode: 0 },
      credit: { handlers: [{ source: "tools.bash", ms: 0.11 }] },
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
    listing.end();
    span1.end();
    append(sessionId, { type: "step-end", turnId, stepId: step1, decision: { result: "continue", why: "the model asked for tools" } });
    // A second step: two more calls, which the chat gathers with the first under one line.
    const stepB = id("p");
    const sB = Date.now();
    const status = { type: "toolCall" as const, id: id("c"), name: "bash", arguments: { command: "git status --short" } };
    const readme = { type: "toolCall" as const, id: id("c"), name: "read", arguments: { path: `${CWD}/README.md` } };
    const mB = assistant(
      [{ type: "thinking", thinking: "**Checking the working tree**\n\nThen the README, for how the packages fit together." }, status, readme],
      usage(3100, 60, 8000),
      "toolUse",
      undefined,
      by,
    );
    const spanB = stepSpan(stepB, 2);
    if (!(await asked(spanB, stepB, mB))) return end("cancelled");
    append(sessionId, { type: "message", turnId, stepId: stepB, message: mB, timing: { startedAt: sB, firstTokenAt: sB + 200, endedAt: Date.now() } });
    for (const [done, output] of [
      [status, " M apps/web/src/plugins/chat/index.tsx"],
      [readme, "# Lemma\n\nA coding-agent harness in which every part is a plugin."],
    ] as const) {
      const running = toolSpan(spanB, stepB, done);
      await sleep(500);
      running.end();
      append(sessionId, {
        type: "message",
        turnId,
        stepId: stepB,
        ...(done.name === "bash" ? { details: { exitCode: 0 } } : {}),
        timing: { startedAt: Date.now() - 500, endedAt: Date.now() },
        message: {
          role: "toolResult",
          toolCallId: done.id,
          toolName: done.name,
          isError: false,
          timestamp: Date.now(),
          content: [{ type: "text", text: output }],
        },
      });
    }
    spanB.end();
    append(sessionId, { type: "step-end", turnId, stepId: stepB, decision: { result: "continue", why: "the model asked for tools" } });
    if (cancelled.has(sessionId)) return end("cancelled");
    if (heldSteers !== undefined) await heldSteers.released;
    if (cancelled.has(sessionId)) return end("cancelled");
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
          text: `There are three packages: **client**, **contracts**, and **core**.\n\nYou asked: _${text.slice(0, 120)}_ — this is the mock host, so that's as far as I go. Try:\n\n1. The model picker (Ctrl+K)\n2. Esc twice to stop a turn\n3. Settings → Providers for the login flow, or from a shell:\n\n   \`\`\`sh\n   lemma models --all\n   \`\`\`\n\nHow they depend on each other:\n\n\`\`\`mermaid\ngraph LR\n  client --> contracts\n  core --> effect\n  contracts --> core\n\`\`\`\n\nAnd the entry point:\n\n\`\`\`ts\nimport { boot } from "./ui/boot.tsx";\n\nawait boot({ host, token, bundled, api, element, safe: false });\n\`\`\``,
        },
      ],
      usage(3300, 110, 11000),
      "stop",
      undefined,
      by,
    );
    const span2 = stepSpan(step2, 3);
    if (!(await asked(span2, step2, m2))) return end("cancelled");
    total = { ...total, input: total.input + m2.usage.input, output: total.output + m2.usage.output };
    append(sessionId, { type: "message", turnId, stepId: step2, message: m2, timing: { startedAt: s2, firstTokenAt: s2 + 250, endedAt: Date.now() } });
    span2.end();
    append(sessionId, { type: "step-end", turnId, stepId: step2, decision: { result: "stop", why: "the model stopped (stop)" } });
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

  const notFound = (sessionId: string) => new HostError({ code: "NotFound", subject: sessionId, message: `Session ${sessionId} not found` });
  const sessionOf = (sessionId: string) => {
    const session = sessions.get(sessionId);
    if (session === undefined) throw notFound(sessionId);
    return session;
  };

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

  /** Each prompt by session and request id: sending one again waits for it rather than placing it twice, as the agent does. */
  const prompts = new Map<string, Promise<void>>();
  const prompt = (sessionId: string, content: PromptContent, options: TurnOptions | undefined, requestId: string, whenBusy: string): Promise<void> => {
    const key = `${sessionId} ${requestId}`;
    const known = prompts.get(key);
    if (known !== undefined) {
      // Told again, so a client sending it again sees it taken.
      if (queueOf(sessionId).some((queued) => queued.prompt.requestId === requestId)) queueChanged(sessionId);
      return known;
    }
    sessionOf(sessionId);
    if (running.has(sessionId) && whenBusy === "reject") throw new HostError({ code: "Busy", subject: sessionId, message: "A turn is already running" });
    const placed = running.has(sessionId)
      ? new Promise<void>((resolve, reject) => {
          const queued: QueuedPrompt = {
            requestId,
            content,
            mode: whenBusy === "steer" ? "steer" : "follow-up",
            at: Date.now(),
            ...(options === undefined ? {} : { options }),
          };
          queues.set(sessionId, [...queueOf(sessionId), { prompt: queued, done: resolve, fail: reject }]);
          queueChanged(sessionId);
        })
      : runTurn(sessionId, content, options, requestId);
    prompts.set(key, placed);
    return placed;
  };
  /** The session as a client joining now shows it, beyond its log (`Agent.view`). */
  const view = (sessionId: string): AgentView => {
    const turn = turns.get(sessionId);
    const draft = turn?.draft;
    return {
      ...(turn === undefined ? {} : { turnId: turn.turnId }),
      ...(draft === undefined
        ? {}
        : { draft: { stepId: draft.stepId, seq: draft.seq, blocks: draft.blocks.flatMap((block, index) => (block === undefined ? [] : [{ index, block }])) } }),
      output: [...(turn?.output ?? [])].map(([toolCallId, output]) => ({ toolCallId, output, length: output.length })),
      queue: queueOf(sessionId).map((queued) => queued.prompt),
      queueRevision,
    };
  };
  /** As the llm plugin does after saving a change to its providers: it restarts, once the call asking for it has answered. */
  const reloadLlm = () => setTimeout(() => restart("llm.http"), 50);
  const noCustom = (provider: string) =>
    new HostError({ code: "UnknownProvider", message: `No provider "${provider}" was added by the user`, subject: provider });

  /** What the bundled plugins serve, as they serve it (`serveSessions`, `serveAgent`, `serveLlm`, `serveWorkspace`, `serveFiles`, `serveCommands`). */
  const integrations = createIntegrationsMock();
  const served: Served[] = [
    // The bundled modes, as `agent.profiles` lists them for any directory.
    serveCall("agent.profiles", ProfileChannels.list, async () => ({
      profiles: [
        {
          name: "creator",
          description: "Customize Lemma through conversation, writing plugins that add features or UI, and modes of your own",
          source: "bundled" as const,
        },
        { name: "work", description: "Work with code, files, and information, searching, editing, and running commands as needed", source: "bundled" as const },
      ],
      default: "work",
    })),
    serveCall("sessions.files", SessionChannels.list, async ({ cwd }) =>
      [...sessions.values()]
        .map((session) => session.info)
        .filter((info) => cwd === undefined || info.cwd === cwd)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    ),
    serveCall("sessions.files", SessionChannels.search, async ({ query, limit }) => {
      await sleep(80);
      const words = searchWords(query);
      return [...sessions.values()]
        .sort((a, b) => b.info.updatedAt - a.info.updatedAt)
        .flatMap((session) => {
          const match = searchLog(session.info.id, branchOf(session.events, session.info.leaf), words);
          return match === undefined ? [] : [match];
        })
        .slice(0, limit ?? 20);
    }),
    serveCall("sessions.files", SessionChannels.get, async ({ sessionId }) => sessionOf(sessionId).info),
    serveCall("sessions.files", SessionChannels.create, async ({ cwd }) => {
      const info = create(cwd);
      kept.add(info.id);
      sessionChanges.publish({ type: "session-changed", info });
      return info;
    }),
    serveCall("sessions.files", SessionChannels.events, async ({ sessionId, after }) => {
      await sleep(120);
      return sessionOf(sessionId).events.filter((event) => event.seq > (after ?? 0));
    }),
    serveStream("sessions.files", SessionChannels.log, ({ sessionId, after }, send, fail) => {
      const session = sessions.get(sessionId);
      if (session === undefined) {
        fail(notFound(sessionId));
        return () => {};
      }
      send({ type: "subscribed", events: session.events.filter((event) => event.seq > (after ?? 0)) });
      return logs.subscribe((heard) => {
        if (heard.sessionId !== sessionId) return;
        if (heard.event === undefined) fail(new HostError({ code: "NotFound", subject: sessionId, message: `Session ${sessionId} was deleted` }));
        else send({ type: "appended", event: heard.event });
      });
    }),
    // Points the leaf at the event, as the host does: the next append branches from there.
    serveCall("sessions.files", SessionChannels.checkout, async ({ sessionId, eventId }) => {
      const session = sessionOf(sessionId);
      session.info = { ...session.info, leaf: eventId };
      sessionChanges.publish({ type: "session-changed", info: session.info });
      return session.info;
    }),
    serveCall("sessions.files", SessionChannels.setTitle, async ({ sessionId, title }) => {
      sessionOf(sessionId);
      append(sessionId, { type: "title", title });
      return sessionOf(sessionId).info;
    }),
    serveCall("sessions.files", SessionChannels.mark, async ({ sessionId, pinned: pin, archived: archive, kept: keep }) => {
      const session = sessionOf(sessionId);
      const { pinned: _pinned, archived: _archived, kept: _kept, ...rest } = session.info;
      const pinned = pin ?? session.info.pinned === true;
      const archived = archive ?? session.info.archived === true;
      const kept = keep ?? session.info.kept === true;
      session.info = { ...rest, ...(pinned ? { pinned } : {}), ...(archived ? { archived } : {}), ...(kept ? { kept } : {}) };
      sessionChanges.publish({ type: "session-changed", info: session.info });
      return session.info;
    }),
    serveCall("sessions.files", SessionChannels.relocate, async ({ sessionId, cwd }) => {
      const session = sessionOf(sessionId);
      if (session.events.length > 0)
        throw new HostError({ code: "NotEmpty", subject: sessionId, message: `Session ${sessionId} has events: only an empty session moves` });
      if (running.has(sessionId)) throw new HostError({ code: "Busy", subject: sessionId, message: "This session is in use" });
      session.info = { ...session.info, cwd };
      sessionChanges.publish({ type: "session-changed", info: session.info });
      return session.info;
    }),
    // The branch up to the event, copied into a new session in the same directory, as the host does.
    serveCall("sessions.files", SessionChannels.fork, async ({ sessionId, eventId }) => {
      const source = sessionOf(sessionId);
      if (!source.events.some((event) => event.id === eventId)) throw notFound(eventId);
      const info = create(source.info.cwd);
      const events = branchOf(source.events, eventId).map((event, index) => ({ ...event, seq: index + 1 }));
      const title = events.flatMap((event) => (event.data.type === "title" ? [event.data.title] : [])).at(-1);
      const forked = sessionOf(info.id);
      forked.events = events;
      forked.info = { ...info, leaf: eventId, lastSeq: events.length, ...(title === undefined ? {} : { title }) };
      sessionChanges.publish({ type: "session-changed", info: forked.info });
      return forked.info;
    }),
    serveCall("sessions.files", SessionChannels.delete, async ({ sessionId }) => {
      sessionOf(sessionId);
      if (running.has(sessionId))
        throw new HostError({ code: "Busy", subject: sessionId, message: "This session is in use, by a running turn or other work; stop it before deleting" });
      sessions.delete(sessionId);
      logs.publish({ sessionId });
      sessionChanges.publish({ type: "session-removed", sessionId });
    }),
    serveStream("sessions.files", SessionChannels.changes, (_, send) => {
      send({ type: "subscribed" });
      return sessionChanges.subscribe(send);
    }),

    serveCall(
      "agent.loop",
      AgentChannels.prompt,
      async ({ sessionId, content, options, requestId, whenBusy }): Promise<PromptOutcome> => {
        const answered = answers.get(content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""));
        if (answered !== undefined) return answered;
        await prompt(sessionId, content, options, requestId, whenBusy ?? "follow-up");
        return { kind: "placed" };
      },
      { waits: true },
    ),
    serveCall("agent.loop", AgentChannels.cancel, async ({ sessionId }) => {
      if (running.has(sessionId)) cancelled.add(sessionId);
    }),
    serveCall("agent.loop", AgentChannels.running, async () => [...running]),
    serveCall("agent.loop", AgentChannels.queue, async ({ sessionId }) => queueOf(sessionId).map((queued) => queued.prompt)),
    serveCall("agent.loop", AgentChannels.withdraw, async ({ sessionId, requestId }) => {
      const found = queueOf(sessionId).find((queued) => queued.prompt.requestId === requestId);
      if (found === undefined) return false;
      queues.set(
        sessionId,
        queueOf(sessionId).filter((queued) => queued !== found),
      );
      found.fail(new HostError({ code: "Retracted", subject: sessionId, message: "The prompt was withdrawn from the queue" }));
      queueChanged(sessionId);
      return true;
    }),
    serveCall("agent.loop", AgentChannels.promote, async ({ sessionId, requestId }) => {
      const found = queueOf(sessionId).find((queued) => queued.prompt.requestId === requestId);
      if (!running.has(sessionId) || found === undefined || found.prompt.mode !== "follow-up") return false;
      queues.set(
        sessionId,
        queueOf(sessionId).map((queued) => (queued === found ? { ...found, prompt: { ...found.prompt, mode: "steer" as const } } : queued)),
      );
      queueChanged(sessionId);
      return true;
    }),
    serveCall("agent.loop", AgentChannels.view, async ({ sessionId }) => view(sessionId)),
    serveStream("agent.loop", AgentChannels.activity, (_, send) => {
      send({ type: "subscribed", running: [...running] });
      return activity.subscribe(send);
    }),

    serveCall("llm.http", LlmChannels.providers, async () => providers.slice()),
    serveCall("llm.http", LlmChannels.models, async ({ available }) =>
      available === true ? MODELS.filter((model) => providers.find((p) => p.id === model.provider)?.configured) : MODELS.slice(),
    ),
    serveCall(
      "llm.http",
      LlmChannels.login,
      async ({ provider, type }) => {
        const p = providers.find((x) => x.id === provider);
        if (p === undefined) throw new HostError({ code: "UnknownProvider", subject: provider, message: `No provider "${provider}"` });
        const origin = `login:${p.id}`;
        const cancel = new AbortController();
        logins.set(p.id, cancel);
        const cancelled = () => new HostError({ code: "Cancelled", message: `${p.name} login was cancelled`, subject: p.id });
        /** Asks under the login's origin; a cancelled login withdraws the question. */
        const loginAsk = (request: InteractionRequest) => {
          const withdraw = () => withdrawRequest(request.id);
          cancel.signal.addEventListener("abort", withdraw, { once: true });
          return ask({ type: "interaction", request }).finally(() => cancel.signal.removeEventListener("abort", withdraw));
        };
        const notice = (notice: Omit<NoticePayload, "level" | "source" | "origin">) =>
          emit({ type: "notice", notice: { level: "info", source: "llm.http", origin, ...notice } });
        /** Resolves after `ms`, or rejects once the login is cancelled. */
        const wait = (ms: number) =>
          new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, ms);
            cancel.signal.addEventListener("abort", () => (clearTimeout(timer), reject(cancelled())), { once: true });
          });
        try {
          if (type === "api_key" && p.id === "amazon-bedrock") {
            // As Bedrock's does: documentation first, then a question that a blank answer also settles.
            notice({
              message: "Amazon Bedrock supports AWS profiles, IAM credentials, and role-based credentials.",
              links: [{ url: "https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-files.html", label: "AWS profiles" }],
            });
            const answer = await loginAsk({ type: "ask", id: id("i"), origin, title: "Enter AWS profile name (blank for default):", placeholder: "default" });
            if (answer === undefined) throw cancelled();
          } else if (type === "api_key") {
            const answer = await loginAsk({ type: "ask", id: id("i"), origin, title: `${p.name} API key`, placeholder: "sk-…", secret: true });
            if (answer === undefined || answer.type !== "ask" || answer.value === "") throw cancelled();
          } else if (p.id === "github-copilot") {
            // As GitHub's device flow does: a code to enter on github.com, then polling until it is approved.
            notice({
              kind: "device-code",
              message: `Enter code WDJB-MJHT at https://github.com/login/device to sign in to ${p.name}.`,
              code: "WDJB-MJHT",
              links: [{ url: "https://github.com/login/device", label: "Enter code" }],
            });
            await wait(8000);
            notice({ kind: "progress", message: "Enabling models..." });
            await wait(600);
          } else {
            // As ChatGPT's sign-in does: a link, and a paste-the-redirect prompt racing the loopback callback.
            notice({
              kind: "sign-in",
              message: "Complete sign-in in your browser. If the callback does not complete, paste the final redirect URL here.",
              links: [
                {
                  url: `https://auth.example.com/oauth/authorize?response_type=code&client_id=app_EMoamEEZ73f0CkXaXp7hrann&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid+profile+email+offline_access&code_challenge=${"x".repeat(43)}&state=${p.id}`,
                  label: `Sign in to ${p.name}`,
                },
              ],
            });
            const pasted = loginAsk({
              type: "ask",
              id: id("i"),
              origin,
              title: "Complete login in your browser, or paste the final redirect URL here:",
              placeholder: "http://localhost:1455/auth/callback",
              kind: "sign-in-code",
            });
            const callback = wait(12000).then(() => "callback" as const);
            const first = await Promise.race([pasted.then((answer) => ({ answer })), callback]);
            if (first === "callback") {
              // The browser reached the host: the paste prompt is no longer needed.
              const open = [...openRequests.values()].find((request) => request.origin === origin);
              if (open !== undefined) withdrawRequest(open.id);
            } else if (first.answer === undefined) throw cancelled();
            notice({ kind: "progress", message: "Exchanging authorization code for tokens..." });
            await wait(700);
          }
        } catch (error) {
          notice({ kind: "ended", message: cancel.signal.aborted ? `${p.name} login was cancelled` : `${p.name} login failed` });
          throw error;
        } finally {
          logins.delete(p.id);
        }
        const i = providers.indexOf(p);
        providers[i] = { ...p, configured: true, source: type === "oauth" ? "OAuth" : "auth.json" };
        modelChanges.publish({ type: "models-changed" });
        notice({ kind: "signed-in", message: `Logged in to ${p.name}` });
      },
      { waits: true },
    ),
    serveCall("llm.http", LlmChannels.cancelLogin, async ({ provider }) => {
      const running = logins.get(provider);
      running?.abort();
      return running !== undefined;
    }),
    serveCall("llm.http", LlmChannels.logout, async ({ provider }) => {
      const i = providers.findIndex((x) => x.id === provider);
      if (i === -1) throw new HostError({ code: "UnknownProvider", subject: provider, message: `No provider "${provider}"` });
      const { source: _source, ...rest } = providers[i]!;
      providers[i] = { ...rest, configured: false };
      modelChanges.publish({ type: "models-changed" });
    }),
    // Like the llm plugin: an id from the name, free among the providers; listed once its config has reloaded.
    serveCall("llm.http", LlmChannels.addCustom, async ({ spec }) => {
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
      reloadLlm();
      return id;
    }),
    serveCall("llm.http", LlmChannels.removeCustom, async ({ provider }) => {
      await sleep(300);
      const at = providers.findIndex((candidate) => candidate.id === provider && candidate.custom);
      if (at === -1) throw noCustom(provider);
      providers.splice(at, 1);
      reloadLlm();
    }),
    serveCall("llm.http", LlmChannels.setLogo, async ({ provider, svg }) => {
      await sleep(200);
      const at = providers.findIndex((candidate) => candidate.id === provider && candidate.custom);
      if (at === -1) throw noCustom(provider);
      const { logo: _logo, ...rest } = providers[at]!;
      providers[at] = svg === undefined ? rest : { ...rest, logo: svg };
      reloadLlm();
    }),
    serveStream("llm.http", LlmChannels.changes, (_, send) => {
      send({ type: "subscribed" });
      return modelChanges.subscribe(send);
    }),

    serveCall("workspace.local", WorkspaceChannels.status, async ({ path }) => workspaceStatus(path)),
    serveCall("workspace.local", WorkspaceChannels.browse, async ({ partialPath }) => {
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
    }),
    serveCall("workspace.local", WorkspaceChannels.createDirectory, async ({ path }) => ({ path, exists: true })),
    serveCall("workspace.local", WorkspaceChannels.createWorktree, async (asked) => {
      const { path, branch } = asked;
      worktreesAsked.push(asked);
      await sleep(300);
      const tree = `${HOME}/worktrees/${path.split("/").pop()}/${branch.replace(/\//g, "-")}`;
      return { path: tree, exists: true, git: { root: tree, branch, head: "84c3bfc", changes: 0, ahead: 0, behind: 0, worktreeOf: path } };
    }),
    serveCall("workspace.local", WorkspaceChannels.branches, async () =>
      mockBranches.map((name, index) => ({
        name,
        current: name === currentBranch,
        remote: name.startsWith("origin/"),
        updatedAt: Date.now() - index * 3_600_000,
      })),
    ),
    serveCall("workspace.local", WorkspaceChannels.checkout, async ({ path, branch, create }) => {
      await sleep(250);
      const name = branch.replace(/^origin\//, "");
      if (create === true || !mockBranches.includes(name)) mockBranches.unshift(name);
      currentBranch = name;
      return workspaceStatus(path);
    }),
    serveCall("skills.files", SkillChannels.list, async () => ({ skills: MOCK_SKILLS })),
    serveCall("workspace.local", FileChannels.search, async ({ cwd, query, limit = 50, kind, within: folder }) => {
      await sleep(40);
      const within = folder?.replace(/\/+$/, "");
      if (within !== undefined && !mockEntries.some((entry) => entry.kind === "directory" && entry.path === within)) {
        throw new HostError({ code: "NotFound", message: `"${cwd}/${within}" is not a folder in ${cwd}`, subject: `${cwd}/${within}` });
      }
      const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
      const ranked = mockEntries
        .filter((entry) => kind === undefined || entry.kind === kind)
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
      return { root: cwd, entries: ranked.slice(0, limit).map((item) => item.entry), truncated: ranked.length > limit };
    }),

    serveCall("commands.registry", CommandChannels.list, async () => MOCK_COMMANDS.slice()),
    serveCall(
      "commands.registry",
      CommandChannels.run,
      async ({ id: commandId }) => {
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
          case "workspace.pull-request": {
            // A form: its fields as a plugin's settings are described (`describeConfig`).
            const answer = await ask({
              type: "interaction",
              request: {
                type: "form",
                id: id("i"),
                title: "Open a pull request",
                detail: `From ${currentBranch}`,
                fields: [
                  { key: "title", title: "Title", type: "string", optional: false },
                  { key: "base", title: "Base", type: "enum", options: ["main", "develop"], optional: true, default: "main" },
                  { key: "draft", title: "Draft", type: "boolean", optional: true, default: false },
                ],
              },
            });
            if (answer?.type !== "form") throw cancelled();
            return {
              message: `Opened "${String(answer.value["title"])}" into ${String(answer.value["base"] ?? "main")}${answer.value["draft"] === true ? " as a draft" : ""}`,
            };
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
      { waits: true },
    ),
    serveStream("commands.registry", CommandChannels.changes, (_, send) => {
      send(MOCK_COMMANDS.slice());
      return () => {};
    }),
    serveCall("devtools.trace", TraceChannels.spans, async (query) => selectSpans(mockTrace.spans(), query)),
    serveStream("devtools.trace", TraceChannels.follow, ({ where }, send) =>
      mockTrace.subscribe((ended) => {
        const found = ended.filter((span) => matches(span, where));
        if (found.length > 0) send(found);
      }),
    ),
    serveCall("devtools.trace", TraceChannels.changes, async () => mockTrace.history.get()),

    serveCall("mcp.servers", McpChannels.state, async () => integrations.mcpState()),
    serveStream("mcp.servers", McpChannels.changes, (_, send) => integrations.followMcp(send)),
    serveCall("mcp.servers", McpChannels.reconnect, async () => {}),
    serveCall("mcp.servers", McpChannels.configure, async ({ server, change }) => integrations.configureServer(server, change)),
    serveCall("mcp.servers", McpChannels.put, async ({ server, entry }) => integrations.putServer(server, entry)),
  ];
  const channels = new Map(served.map((channel) => [channel.declaration.id, channel]));
  const infoOf = ({ declaration: { id, title, description }, kind, source }: Served): ChannelInfo => ({
    id,
    kind,
    source,
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
  });
  /**
   * Payloads and results cross as they do to and from the host: in the JSON
   * of their schemas (`wireCodec`), encoded by a client typed with the
   * declaration and decoded by the channel's, and the other way for results.
   */
  const wire = (schema: Schema.Top) => ({
    encode: (value: unknown) => Schema.encodeUnknownSync(wireCodec(schema))(value),
    decode: (value: unknown) => Schema.decodeUnknownSync(wireCodec(schema))(value),
  });
  /** What a request sends: a typed client encodes the payload, one calling by id sends it as it is. */
  const request = (target: string | ChannelDeclaration, channel: Served, payload: unknown) => {
    try {
      return wire(channel.declaration.payload).decode(typeof target === "string" ? payload : wire(target.payload).encode(payload));
    } catch (error) {
      throw new HostError({
        code: "InvalidPayload",
        subject: channel.declaration.id,
        message: `Invalid payload for "${channel.declaration.id}": ${String(error)}`,
      });
    }
  };
  const reply = (target: string | ChannelDeclaration, channel: Served, value: unknown) => {
    const json = wire(channel.declaration.success).encode(value);
    return typeof target === "string" ? json : wire(target.success).decode(json);
  };
  const failed = (id: string, error: unknown) =>
    error instanceof HostError ? error : new HostError({ code: "Failed", subject: id, message: error instanceof Error ? error.message : String(error) });
  /** Open streams, and calls that wait on their plugin, so its restart ends them `Withdrawn`. */
  const inFlight = new Set<{ readonly source: string; readonly withdraw: () => void }>();
  /** A plugin restarts, as a reload or the Plugins page restarts it: what it serves ends `Withdrawn`, to be asked again (by `call` itself, if repeatable). */
  const restart = (pluginId: string) => {
    for (const entry of inFlight) if (entry.source === pluginId) entry.withdraw();
    emit({ type: "channels-changed", channels: served.map(infoOf) });
  };

  /** One answer from a call, `Withdrawn` if it `waits` and its plugin restarts meanwhile. */
  const answer = (channel: Extract<Served, { readonly kind: "call" }>, decoded: unknown): Promise<unknown> => {
    const { id } = channel.declaration;
    const answered = channel.handle(decoded).catch((error: unknown) => Promise.reject(failed(id, error)));
    if (!channel.waits) return answered;
    return new Promise((resolve, reject) => {
      const entry = { source: channel.source, withdraw: () => reject(withdrawnFrom(id, "call")) };
      inFlight.add(entry);
      answered.then(resolve, reject).finally(() => inFlight.delete(entry));
    });
  };
  const call = async (target: string | ChannelDeclaration, payload?: unknown): Promise<unknown> => {
    const id = typeof target === "string" ? target : target.id;
    const channel = channels.get(id);
    if (channel === undefined || channel.kind !== "call") throw noChannel(id);
    const decoded = request(target, channel, payload);
    for (;;) {
      try {
        return reply(target, channel, await answer(channel, decoded));
      } catch (error) {
        // As the host does: a repeatable call its plugin's restart withdrew is made again, on the plugin started anew.
        if (!(channel.declaration.repeatable === true && error instanceof HostError && error.code === "Withdrawn")) throw error;
      }
    }
  };
  const open = (target: string | ChannelDeclaration, payload: unknown, onElement: (element: unknown) => void, onEnd?: (error?: HostError | Error) => void) => {
    const id = typeof target === "string" ? target : target.id;
    let live = true;
    let stop = () => {};
    let entry: { readonly source: string; readonly withdraw: () => void } | undefined;
    const end = (error?: HostError) => {
      if (!live) return;
      live = false;
      if (entry !== undefined) inFlight.delete(entry);
      stop();
      onEnd?.(error);
    };
    // As the host answers it: once the request has gone out.
    setTimeout(() => {
      if (!live) return;
      const channel = channels.get(id);
      if (channel === undefined || channel.kind !== "stream") return end(noChannel(id));
      try {
        const decoded = request(target, channel, payload);
        entry = { source: channel.source, withdraw: () => end(withdrawnFrom(id, "stream")) };
        inFlight.add(entry);
        const send = (element: unknown) => {
          if (!live) return;
          let sent: unknown;
          try {
            sent = reply(target, channel, element);
          } catch (error) {
            return end(failed(id, error));
          }
          onElement(sent);
        };
        stop = channel.handle(decoded, send, end);
      } catch (error) {
        end(failed(id, error));
      }
    }, 0);
    return () => {
      if (!live) return;
      live = false;
      if (entry !== undefined) inFlight.delete(entry);
      stop();
    };
  };

  return {
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
    channel: {
      list: async () => served.map(infoOf),
      call: call as Host["channel"]["call"],
      open: open as Host["channel"]["open"],
    },
    host: {
      info: async () => ({
        version: "0.1.0-mock",
        cwd: CWD,
        home: HOME,
        composition: { id: "c0ffee1234abcd", plugins: plugins.map((p) => ({ id: p.id, ...(p.version === undefined ? {} : { version: p.version }) })) },
        runtime,
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
        restart(pluginId);
        emit({ type: "plugins-changed", plugins: plugins.slice() });
      },
      reload: async () => {
        await sleep(400);
        setTimeout(() => restart("agent.loop"), 0);
        return { started: [], restarted: ["agent.loop"], stopped: [] };
      },
      configure: async (rows, options) => {
        await sleep(500);
        for (const [id, row] of Object.entries(rows)) {
          const locked = plugins.find((p) => p.id === id)?.locked;
          if (locked !== undefined && row.enabled === false) {
            throw new HostError({ code: "ReloadError", message: `error [${id}]: "${id}" cannot be turned off: ${locked}`, subject: id });
          }
        }
        // Every row is written, a web half's too: the page plans its halves from the same rows.
        writeRows(rows, options?.scope ?? "user");
        const before = plugins.filter((plugin) => plugin.state !== "disabled").map((plugin) => plugin.id);
        for (const [id, row] of Object.entries(rows)) {
          const i = plugins.findIndex((p) => p.id === id);
          if (i < 0) continue;
          if (plugins[i]!.locked !== undefined && row.enabled === false) {
            throw new HostError({ code: "ReloadError", message: `error [${id}]: "${id}" cannot be turned off: ${plugins[i]!.locked}`, subject: id });
          }
          if (row.add !== undefined || row.remove !== undefined) {
            setTimeout(() => restart(id), 0);
            return { started: [], restarted: [id], stopped: [] };
          }
          if (row.values !== undefined) {
            const next = { ...configRows[id] };
            for (const [key, value] of Object.entries(row.values)) {
              if (value === null) delete next[key];
              else next[key] = value;
            }
            configRows[id] = next;
            plugins[i] = withConfig(plugins[i]!);
            // Like the host: a change that restarts the transport serving this call applies after the reply; any other at once.
            if (id === "transport.server") {
              setTimeout(() => emit({ type: "plugins-changed", plugins: plugins.slice() }), 300);
              return { started: [], restarted: [], stopped: [], deferred: true };
            }
            restart(id);
            emit({ type: "plugins-changed", plugins: plugins.slice() });
            return { started: [], restarted: [id], stopped: [] };
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
    web: {
      composition: async () => composition,
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
