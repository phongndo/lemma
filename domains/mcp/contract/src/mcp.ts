import { Context, Data, Effect, Schema } from "effect";
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
 * How Lemma signs in to a remote server that asks (OAuth), in the shape Claude Code's entries have. Needed only for a
 * server whose authorization server registers no clients itself (no Dynamic Client Registration), or that expects a
 * fixed address to come back to, or other scopes than it says it needs.
 */
export const McpOAuthConfig = Schema.Struct({
  /** A client registered with the server's authorization server ahead of time; Lemma registers one itself when absent. */
  clientId: Schema.optional(Schema.String),
  /** That client's secret, when it has one: write it as `${VAR}`, so the secret stays out of the file. */
  clientSecret: Schema.optional(Schema.String),
  /** The port of the address the browser comes back to, `http://localhost:<port>/callback`; any free port when absent. */
  callbackPort: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 65535 }))),
  /** The scopes to ask for, space-separated; those the server says it needs when absent. */
  scopes: Schema.optional(Schema.String),
});
export type McpOAuthConfig = typeof McpOAuthConfig.Type;

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
  /** How Lemma signs in to a remote server that asks, when the server's own word is not enough. */
  oauth: Schema.optional(McpOAuthConfig),
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
 *
 * @composition all servers, one per name; the user's `mcp.json` entry with the same name wins over a plugin's.
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

/**
 * `off`: disabled, or every tool hidden; `failed`: it could not connect, or its connection dropped (`error` says why);
 * `needs-sign-in`: a remote server that asks to be signed in to, with no sign-in it accepts (`auth` says how it stands).
 */
export const McpServerState = Schema.Literals(["off", "connecting", "connected", "failed", "needs-sign-in"]);
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

/**
 * Signing in to a remote server that asks (OAuth). `signed-out`: no sign-in, or one the server no longer accepts;
 * `signing-in`: waiting on the person's browser, at `url`; `signed-in`: Lemma holds a token the server accepts.
 */
export const McpAuthStatus = Schema.Struct({
  state: Schema.Literals(["signed-out", "signing-in", "signed-in"]),
  /** While signing in: the page to open in a browser and approve. */
  url: Schema.optional(Schema.String),
  /** Why the last sign-in failed. */
  error: Schema.optional(Schema.String),
});
export type McpAuthStatus = typeof McpAuthStatus.Type;

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
  /** Why it failed, or why it is off when it is not disabled; never a value a `${VAR}` holds. */
  error: Schema.optional(Schema.String),
  /**
   * How long until Lemma tries to connect again on its own (ms, from when this status was made): a remote server that
   * could not be reached. A span rather than a time, as the host's clock and a client's may differ.
   */
  retryIn: Schema.optional(Schema.Number),
  /** Signing in: a remote server Lemma signs in to, once it asked, or once Lemma holds a sign-in for it. */
  auth: Schema.optional(McpAuthStatus),
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

/**
 * `NotFound`: no server has that name; `Invalid`: an entry `put` was given cannot run, or a sign-in asked of a server
 * that takes none (`message` says why); `Failed`: the file could not be written, or a sign-in failed.
 */
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

/**
 * One server as an agent may read it: its state, what it is for, how many tools it offers, and how signing in to it
 * stands, without where it is or how it is reached, which a `${VAR}` can put a credential in.
 */
export const McpServerSummary = Schema.Struct({
  name: Schema.String,
  state: McpServerState,
  enabled: Schema.Boolean,
  description: Schema.optional(Schema.String),
  /** The tools it offered when it last connected that reach the model: a server that dropped, or needs signing in again, keeps them. */
  tools: Schema.Number,
  error: Schema.optional(Schema.String),
  retryIn: Schema.optional(Schema.Number),
  /** How signing in stands, for a server Lemma signs in to. */
  auth: Schema.optional(McpAuthStatus.fields.state),
});
export type McpServerSummary = typeof McpServerSummary.Type;

/** `state`'s servers as `McpServerSummary` has them. */
export const summarize = (state: McpState): readonly McpServerSummary[] =>
  state.servers.map((server) => ({
    name: server.name,
    state: server.state,
    enabled: server.enabled,
    ...(server.description === undefined ? {} : { description: server.description }),
    tools: server.tools.filter((tool) => tool.exposure !== "hidden").length,
    ...(server.error === undefined ? {} : { error: server.error }),
    ...(server.retryIn === undefined ? {} : { retryIn: server.retryIn }),
    ...(server.auth === undefined ? {} : { auth: server.auth.state }),
  }));

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
    /**
     * Starts signing in to a remote server that asks, replacing a sign-in under way: answers with the page to open in a
     * browser and approve. The sign-in finishes when the browser comes back to Lemma, or the address it lands on is
     * given to `finishSignIn`, and the server connects again. Fails `Invalid` for a server that takes no sign-in (a
     * local one, or one given its own `Authorization` header), and `Failed` when the server offers none Lemma can use.
     */
    readonly signIn: (server: string) => Effect.Effect<{ readonly url: string }, McpError>;
    /**
     * Finishes the sign-in under way with the address the browser landed on after approving (or the code it shows),
     * for a browser that could not reach Lemma: answers once the sign-in is stored. Fails `Invalid` with none under way.
     */
    readonly finishSignIn: (server: string, address: string) => Effect.Effect<void, McpError>;
    /** Stops the sign-in under way, if any, keeping the sign-in Lemma holds. */
    readonly cancelSignIn: (server: string) => Effect.Effect<void, McpError>;
    /** Forgets the sign-in Lemma holds for the server, stopping one under way, and connects again. */
    readonly signOut: (server: string) => Effect.Effect<void, McpError>;
  }
>()("lemma/Mcp") {}

const serverField = { server: Schema.String };

/** How clients reach `Mcp`, served by its provider (`serveMcp`). */
export const McpChannels = {
  state: defineChannel({
    kind: "call",
    id: "mcp.state",
    access: "secret",
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
    access: "secret",
    title: "MCP server changes",
    description: "Every MCP server now, then again whenever one changes",
    payload: Schema.Void,
    success: McpState,
  }),
  reconnect: defineChannel({
    kind: "call",
    id: "mcp.reconnect",
    access: "operate",
    title: "Reconnect an MCP server",
    description: "Closes a server's connection and connects again",
    payload: Schema.Struct(serverField),
    success: Schema.Void,
  }),
  configure: defineChannel({
    kind: "call",
    id: "mcp.configure",
    access: "change",
    title: "Configure an MCP server",
    description: "Turns a server on or off, or changes how its tools reach the model, in the user's mcp.json",
    payload: Schema.Struct({ ...serverField, change: McpServerChange }),
    success: Schema.Void,
  }),
  list: defineChannel({
    kind: "call",
    id: "mcp.list",
    access: "read",
    title: "MCP servers' states",
    description: "Each MCP server's state (connected, failed, needs-sign-in), what it is for, how many tools it offers, and how signing in to it stands",
    payload: Schema.Void,
    success: Schema.Array(McpServerSummary),
    repeatable: true,
  }),
  signIn: defineChannel({
    kind: "call",
    id: "mcp.sign-in",
    access: "operate",
    title: "Sign in to an MCP server",
    description:
      "Starts signing in to a remote MCP server that asks: answers with the page the person opens in a browser and approves, after which the server connects",
    payload: Schema.Struct(serverField),
    success: Schema.Struct({ url: Schema.String }),
  }),
  finishSignIn: defineChannel({
    kind: "call",
    id: "mcp.finish-sign-in",
    access: "secret",
    title: "Finish signing in to an MCP server",
    description: "Finishes the sign-in under way with the address the browser landed on after approving",
    payload: Schema.Struct({ ...serverField, address: Schema.String }),
    success: Schema.Void,
  }),
  cancelSignIn: defineChannel({
    kind: "call",
    id: "mcp.cancel-sign-in",
    access: "operate",
    title: "Stop signing in to an MCP server",
    description: "Stops the sign-in under way, keeping the sign-in Lemma holds",
    payload: Schema.Struct(serverField),
    success: Schema.Void,
  }),
  signOut: defineChannel({
    kind: "call",
    id: "mcp.sign-out",
    access: "change",
    title: "Sign out of an MCP server",
    description: "Forgets the sign-in Lemma holds for a server, and connects again",
    payload: Schema.Struct(serverField),
    success: Schema.Void,
  }),
  put: defineChannel({
    kind: "call",
    id: "mcp.put",
    access: "secret",
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
  serveChannel(McpChannels.list, () => Effect.map(mcp.state, summarize)),
  serveChannel(McpChannels.signIn, ({ server }) => mcp.signIn(server)),
  serveChannel(McpChannels.finishSignIn, ({ server, address }) => mcp.finishSignIn(server, address)),
  serveChannel(McpChannels.cancelSignIn, ({ server }) => mcp.cancelSignIn(server)),
  serveChannel(McpChannels.signOut, ({ server }) => mcp.signOut(server)),
];
