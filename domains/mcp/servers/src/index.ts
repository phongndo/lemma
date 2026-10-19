import { watch } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Effect, Schema, Stream } from "effect";
import type { Context } from "effect";
import { definePlugin, Events, Registries } from "@lemma/core";
import { Channels, Paths } from "@lemma/contracts";
import { PromptSections } from "@lemma/agent";
import { Mcp, MCP_CONTRACT, McpChanged, McpError, McpServers, serveMcp } from "@lemma/mcp";
import { ToolNamespaces, Tools } from "@lemma/tools";
import { Servers } from "./servers.ts";

const VERSION = "0.1.0";

const Config = Schema.Struct({
  maxOutputChars: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))
    .pipe(Schema.withDecodingDefaultType(Effect.sync(() => 40_000)))
    .annotate({
      title: "Output kept (characters)",
      description: "Text characters of a tool's result the model reads; the rest goes to a temp file the model can read.",
    }),
});

/**
 * What tells the model where its MCP tools are. True whether a request handler keeps the tool that runs them or not:
 * without it, the agent declares them (`declaredTools`), so none is missing from the tool list.
 */
const section = (servers: readonly { readonly name: string; readonly description?: string }[]): string =>
  [
    'MCP servers, whose tools are named `mcp__<server>__<tool>`. Those not in your tool list are called from scripts, as `tools.mcp__<server>__<tool>(args)`, found first with `await searchTools("<server> <what you need>")`.',
    ...servers.map(({ name, description }) => `- ${name}${description === undefined ? "" : `: ${description}`}`),
  ].join("\n");

const toMcpError = (cause: unknown) =>
  cause instanceof McpError ? cause : new McpError({ reason: "Failed", message: cause instanceof Error ? cause.message : String(cause), cause });

/**
 * Connects the MCP servers in `<home>/mcp.json`, and those plugins add (`McpServers`), and adds their tools to the
 * tools registry: by default only code mode calls them (`nested`), and the system prompt names the servers. Serves
 * `Mcp` to clients as the `mcp.*` channels, which its web half, Settings › MCP, draws.
 */
export default definePlugin({
  id: "mcp.servers",
  implements: [MCP_CONTRACT],
  version: VERSION,
  config: Config,
  requires: { paths: Paths },
  provides: { mcp: Mcp },
  setup: function* ({ paths }, owner) {
    const events = yield* Events;
    const registries = yield* Registries;
    const run = Effect.runPromiseWith(yield* Effect.context<never>());
    const file = join(paths.home, "mcp.json");

    const servers = new Servers(
      {
        addTool: async (tool) => {
          const remove = await run(owner.add(Tools, tool));
          return () => run(remove);
        },
        addNamespace: async (namespace) => {
          const remove = await run(owner.add(ToolNamespaces, namespace));
          return () => run(remove);
        },
        changed: (state) => void run(events.publish(McpChanged, state)).catch(() => {}),
        warn: (message) => void run(Effect.logWarning(`mcp: ${message}`)).catch(() => {}),
      },
      { file, maxOutputChars: owner.config.maxOutputChars, version: VERSION, env: process.env },
    );
    yield* Effect.addFinalizer(() => Effect.promise(() => servers.close()));
    yield* Effect.promise(async () =>
      servers.start(await run(Effect.map(registries.items(McpServers), (items) => items.map(({ item, pluginId }) => ({ item, pluginId }))))),
    );
    // Every list, the first too: one added before this stream started is in it.
    yield* owner.background(
      "plugin servers",
      Stream.runForEach(registries.changes(McpServers), (items) =>
        Effect.promise(() => servers.setPlugins(items.map(({ item, pluginId }) => ({ item, pluginId })))),
      ),
    );

    // The file, read again whenever it changes: its directory is watched, since editors replace a file to save it.
    yield* Effect.promise(() => mkdir(dirname(file), { recursive: true }));
    let pending: ReturnType<typeof setTimeout> | undefined;
    const watcher = watch(dirname(file), { signal: owner.signal }, (_, name) => {
      if (name !== basename(file)) return;
      clearTimeout(pending);
      pending = setTimeout(() => void servers.reload().catch(() => {}), 50);
    });
    watcher.on("error", () => {});
    owner.signal.addEventListener("abort", () => clearTimeout(pending));

    yield* owner.add(
      PromptSections,
      {
        id: "mcp-servers",
        // Only where a tool that runs others (code mode) is offered; without one, their tools are declared.
        text: ({ tools }) => {
          const listed = servers.codemodeServers();
          return listed.length === 0 || !tools.some((tool) => tool.nests === true) ? undefined : section(listed);
        },
      },
      // After the project's instructions, before the environment, whose date changes daily.
      { order: 600 },
    );

    const mcp: Context.Service.Shape<typeof Mcp> = {
      state: Effect.sync(() => servers.state()),
      reconnect: (name) => Effect.tryPromise({ try: () => servers.reconnect(name), catch: toMcpError }),
      configure: (name, change) => Effect.tryPromise({ try: () => servers.configure(name, change), catch: toMcpError }),
      put: (name, entry) => Effect.tryPromise({ try: () => servers.put(name, entry), catch: toMcpError }),
    };
    for (const channel of serveMcp(mcp, events)) yield* owner.add(Channels, channel);
    return { mcp };
  },
});
