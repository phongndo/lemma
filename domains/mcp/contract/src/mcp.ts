import { Context, Data, Schema } from "effect";
import type { Effect } from "effect";
import { Event, Registry } from "@lemma/core";
import type { Events } from "@lemma/core";
import { defineChannel, eventFeed, serveChannel } from "@lemma/contracts";
import type { Channel } from "@lemma/contracts";

/**
 * How a server's tools reach the model. `codemode`: only a tool that runs others (`codemode`) calls them, so the model
 * is not sent their declarations and finds them by searching (`nested` in `@lemma/tools`); `direct`: declared to the
 * model like a built-in tool; `hidden`: not added at all.
 */
export const Exposure = Schema.Literals(["codemode", "direct", "hidden"]);
export type Exposure = typeof Exposure.Type;

/**
 * One server, in the shape other MCP clients' `mcpServers` entries have, so an entry copied from one works here.
 * `command` (with `args`, `env`, `cwd`) starts a local server that speaks over stdin and stdout; `url` (with `headers`)
 * reaches a remote one over Streamable HTTP. `${VAR}` and `${VAR:-default}` in those values read the host's
 * environment. An entry with neither changes only `enabled` and exposure of a server a plugin adds with that name.
 */
export const McpServerConfig = Schema.Struct({
  /** `stdio` or `http` (`streamable-http`); optional, since `command` or `url` says which. `sse` is not supported. */
  type: Schema.optional(Schema.Literals(["stdio", "http", "streamable-http"])),
  command: Schema.optional(Schema.String),
  args: Schema.optional(Schema.Array(Schema.String)),
  /** Added to a minimal environment (`HOME`, `PATH`, `SHELL`, `TERM`, `USER`, `LOGNAME`): a server gets no other variable unless named here. */
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  cwd: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /** What the server offers, in a sentence: the model reads it in the system prompt's list of servers. */
  description: Schema.optional(Schema.String),
  /** `false` keeps the entry without connecting to it. */
  enabled: Schema.optional(Schema.Boolean),
  /** How its tools reach the model; `codemode` when absent. */
  exposure: Schema.optional(Exposure),
  /** Per tool, by the server's name for it or a pattern where `*` matches anything: an exact name wins, then the first pattern. */
  toolExposure: Schema.optional(Schema.Record(Schema.String, Exposure)),
  /** Seconds a request may take; 60 when absent, and at most about 24 days. Progress the server reports restarts it. */
  timeout: Schema.optional(Schema.Number.check(Schema.isGreaterThan(0))),
  /** Lemma's own: an image's address (`https:`, or a `data:image/` URL) for its icon, over the one the server declares. */
  icon: Schema.optional(Schema.String),
});
export type McpServerConfig = typeof McpServerConfig.Type;

/** A server a plugin adds to `McpServers`: an entry of the file's shape, with its name. */
export interface McpServer extends McpServerConfig {
  /** Letters, digits, `_`, and `-`: its tools are named `mcp__<name>__<tool>`. */
  readonly name: string;
}

/** Server names: what other clients accept, and what stays readable in a tool's name. */
export const SERVER_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * Servers plugins add, beside the user's `mcp.json`: `PluginContext.add(McpServers, { name, command, … })`. A server
 * belongs to the plugin that added it and is disconnected when it leaves; the file's entry with the same name wins.
 */
export const McpServers = Registry.make<McpServer>("lemma/mcp.servers", {
  key: (server) => server.name,
  unique: true,
  check: (value) => {
    const server = value as Partial<McpServer> | null;
    if (typeof server !== "object" || server === null) return "An MCP server is an object";
    if (typeof server.name !== "string" || !SERVER_NAME.test(server.name)) return "An MCP server needs a name of letters, digits, _, and -";
    return typeof server.command === "string" || typeof server.url === "string" ? undefined : `MCP server "${server.name}" needs a command or a url`;
  },
});

/** `off`: disabled, or every tool hidden; `failed`: it could not connect, or its connection dropped (`error` says why). */
export const McpServerState = Schema.Literals(["off", "connecting", "connected", "failed"]);
export type McpServerState = typeof McpServerState.Type;

export const McpToolInfo = Schema.Struct({
  /** The server's name for it. */
  name: Schema.String,
  /** The name Lemma's tools have it under, `mcp__<server>__<tool>`; absent while it is hidden. */
  tool: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  exposure: Exposure,
  /** The exposure the user's file gives it by its own name: what `configure` sets for it. */
  own: Schema.optional(Exposure),
  /** The `toolExposure` key its exposure comes from, its own name or a pattern; absent: it has its server's. */
  rule: Schema.optional(Schema.String),
});
export type McpToolInfo = typeof McpToolInfo.Type;

/** One server as clients see it. */
export const McpServerStatus = Schema.Struct({
  name: Schema.String,
  state: McpServerState,
  /** Where it is defined: the file's path, or the id of the plugin that added it. */
  source: Schema.String,
  sourceKind: Schema.Literals(["file", "plugin"]),
  transport: Schema.Literals(["stdio", "http"]),
  /** The command line or the URL, with `${VAR}` references as written (never their values). */
  target: Schema.String,
  enabled: Schema.Boolean,
  exposure: Exposure,
  description: Schema.optional(Schema.String),
  /** Why it failed, or why it is off when it is not disabled. */
  error: Schema.optional(Schema.String),
  /** The end of what a local server printed to stderr. */
  stderr: Schema.optional(Schema.String),
  /** What the server says it is, once connected. */
  server: Schema.optional(Schema.Struct({ name: Schema.String, version: Schema.optional(Schema.String), title: Schema.optional(Schema.String) })),
  protocolVersion: Schema.optional(Schema.String),
  /** Its icon's address: the entry's `icon`, else the one the server declares about itself once connected. */
  icon: Schema.optional(Schema.String),
  /** The server's own instructions for using it, once connected. */
  instructions: Schema.optional(Schema.String),
  /** What it offered when it last connected. */
  tools: Schema.Array(McpToolInfo),
  /** The file's entry for it, as written (`${VAR}` references and all): what a client edits and `put` writes back. */
  entry: Schema.optional(McpServerConfig),
});
export type McpServerStatus = typeof McpServerStatus.Type;

/**
 * A change to one server's entry. `null` in `tools` removes the exposure the file gives that tool by its name, so it
 * has what it would without it: a pattern's, the plugin's that adds the server, or the server's.
 */
export const McpServerChange = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  exposure: Schema.optional(Exposure),
  tools: Schema.optional(Schema.Record(Schema.String, Schema.NullOr(Exposure))),
});
export type McpServerChange = typeof McpServerChange.Type;

/** `NotFound`: no server has that name; `Invalid`: an entry `put` was given cannot run (`message` says why); `Failed`: the file could not be written. */
export class McpError extends Data.TaggedError("McpError")<{
  readonly reason: "NotFound" | "Invalid" | "Failed";
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Every server, and the user's file they are configured in. */
export const McpState = Schema.Struct({
  /** The user's servers file, `<home>/mcp.json`: where servers are added. */
  file: Schema.String,
  /** Why the file could not be read; the servers it had are kept as they were. */
  fileError: Schema.optional(Schema.String),
  /** By name. */
  servers: Schema.Array(McpServerStatus),
});
export type McpState = typeof McpState.Type;

/** Published whenever a server's state, entry, or tools change, or the file does. Losable: `Mcp.state` is the record. */
export const McpChanged = Event.make<McpState>("lemma/mcp.changed");

/** The MCP servers and their connections. Its provider serves it to clients too: it adds `serveMcp` to `Channels`. */
export class Mcp extends Context.Service<
  Mcp,
  {
    /** Every server, configured or added by a plugin, and the file. */
    readonly state: Effect.Effect<McpState>;
    /** Closes the server's connection, if any, and connects again. Fails `NotFound` for a name no server has. */
    readonly reconnect: (server: string) => Effect.Effect<void, McpError>;
    /**
     * Writes the change to the user's `mcp.json` and applies it: into the server's entry, or into an entry of its own
     * name for a server a plugin adds, which then changes only what it names (its `toolExposure` added to the plugin's).
     */
    readonly configure: (server: string, change: McpServerChange) => Effect.Effect<void, McpError>;
    /**
     * Writes the server's whole entry to the user's `mcp.json` (adding it, or replacing what is there), or removes it
     * (`null`), keeping the rest of the file, and applies it. Fails `Invalid` for a name or an entry that cannot run.
     */
    readonly put: (server: string, entry: McpServerConfig | null) => Effect.Effect<void, McpError>;
  }
>()("lemma/Mcp") {}

const serverField = { server: Schema.String };

/** How clients reach `Mcp`, served by its provider (`serveMcp`). */
export const McpChannels = {
  state: defineChannel({
    kind: "call",
    id: "mcp.state",
    title: "MCP servers",
    description: "Every MCP server, with its state, where it is defined, and its tools",
    payload: Schema.Void,
    success: McpState,
    repeatable: true,
  }),
  /** The state now, then again after each change. A client that falls behind gets the latest. */
  changes: defineChannel({
    kind: "stream",
    id: "mcp.changes",
    title: "MCP server changes",
    description: "Every MCP server now, then again whenever one changes",
    payload: Schema.Void,
    success: McpState,
  }),
  reconnect: defineChannel({
    kind: "call",
    id: "mcp.reconnect",
    title: "Reconnect an MCP server",
    description: "Closes a server's connection and connects again",
    payload: Schema.Struct(serverField),
    success: Schema.Void,
  }),
  configure: defineChannel({
    kind: "call",
    id: "mcp.configure",
    title: "Configure an MCP server",
    description: "Turns a server on or off, or changes how its tools reach the model, in the user's mcp.json",
    payload: Schema.Struct({ ...serverField, change: McpServerChange }),
    success: Schema.Void,
  }),
  put: defineChannel({
    kind: "call",
    id: "mcp.put",
    title: "Add, replace, or remove an MCP server",
    description: "Writes a server's whole entry to the user's mcp.json, or removes it with null",
    payload: Schema.Struct({ ...serverField, entry: Schema.NullOr(McpServerConfig) }),
    success: Schema.Void,
  }),
} as const;

/** `McpChannels` served from `mcp`: what a provider of `Mcp` adds to `Channels`. */
export const serveMcp = (mcp: Context.Service.Shape<typeof Mcp>, events: Context.Service.Shape<typeof Events>): readonly Channel[] => [
  serveChannel(McpChannels.state, () => mcp.state),
  // Only the latest state matters, at the source and the client.
  serveChannel(McpChannels.changes, () => eventFeed(mcp.state, [events.stream(McpChanged, { buffer: 1 })], 1)),
  serveChannel(McpChannels.reconnect, ({ server }) => mcp.reconnect(server)),
  serveChannel(McpChannels.configure, ({ server, change }) => mcp.configure(server, change)),
  serveChannel(McpChannels.put, ({ server, entry }) => mcp.put(server, entry)),
];
