import { Data, Schema } from "effect";
import type { Effect } from "effect";
import { Event, Registry } from "@lemma/core";
import { ConfigScope } from "./host.ts";

/**
 * MCP (Model Context Protocol) servers: programs and services that offer the
 * model tools. The `mcp` plugin connects to them and registers their tools;
 * clients manage them through the first `McpManagers` contribution.
 */

/** How a server is reached: a command run on the host (`stdio`), or a URL (`http`, or the older `sse`). */
export const McpTransport = Schema.Literal("stdio", "http", "sse");
export type McpTransport = typeof McpTransport.Type;

/**
 * A server as it is configured. `${NAME}` in `command`, `args`, `env`, `cwd`,
 * `url`, and `headers` reads a secret stored for the server, else the host's
 * environment variable (`${NAME:-fallback}` gives a fallback), so the config
 * never needs to hold a key.
 */
export const McpServerSpec = Schema.Struct({
  /** Letters, digits, `_` and `-`; it prefixes the model's names for the server's tools. */
  id: Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/)),
  /** What the app calls it; the id when absent. */
  name: Schema.optional(Schema.String),
  /** Inferred when absent: `stdio` with a `command`, `http` with a `url`. */
  type: Schema.optional(McpTransport),
  command: Schema.optional(Schema.String),
  args: Schema.optional(Schema.Array(Schema.String)),
  /** Set over the host's own environment. */
  env: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  /** Where the command runs; the host's directory when absent. */
  cwd: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  /** Default true. */
  enabled: Schema.optional(Schema.Boolean),
  /** Tools, by the server's names, the model is not offered. */
  disabledTools: Schema.optional(Schema.Array(Schema.String)),
  /** How long a tool call may go without a result or reported progress, in milliseconds. */
  toolTimeoutMs: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
  /** How long connecting may take, in milliseconds. */
  startupTimeoutMs: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
  /**
   * Signing in to a URL server that asks for it. Without `clientId` Lemma
   * registers itself with the server's authorization server; `callbackPort`
   * fixes the local port a pre-registered client's redirect URI names.
   */
  oauth: Schema.optional(
    Schema.Struct({
      clientId: Schema.optional(Schema.String),
      /** Usually `${NAME}`, a stored secret. */
      clientSecret: Schema.optional(Schema.String),
      scopes: Schema.optional(Schema.Array(Schema.String)),
      callbackPort: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.between(1, 65535))),
    }),
  ),
});
export type McpServerSpec = typeof McpServerSpec.Type;

/**
 * Stands for a value the host does not send to clients: an `env` or `headers`
 * value whose name looks like a credential (`API_KEY`, `Authorization`). Sent
 * back in a save, it keeps the value the config holds.
 */
export const MCP_HIDDEN = "<hidden>";

/** What a server says of a tool's behavior. Hints from the server, not guarantees. */
export const McpToolHints = Schema.Struct({
  readOnly: Schema.optional(Schema.Boolean),
  destructive: Schema.optional(Schema.Boolean),
  idempotent: Schema.optional(Schema.Boolean),
  openWorld: Schema.optional(Schema.Boolean),
});
export type McpToolHints = typeof McpToolHints.Type;

export const McpToolInfo = Schema.Struct({
  /** The server's name for it. */
  name: Schema.String,
  /** The name the model calls it by. */
  tool: Schema.String,
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  /** Offered to the model: not in the server's `disabledTools`. */
  enabled: Schema.Boolean,
  hints: McpToolHints,
});
export type McpToolInfo = typeof McpToolInfo.Type;

/**
 * `off`: turned off. `starting`: connecting. `ready`: connected, its tools
 * registered. `auth`: the server wants a sign-in (`login`). `error`: it could
 * not connect or it stopped; `retryAt` says when it is tried again.
 */
export const McpStatus = Schema.Literal("off", "starting", "ready", "auth", "error");
export type McpStatus = typeof McpStatus.Type;

export const McpServerInfo = Schema.Struct({
  id: Schema.String,
  /** As configured, with credential-like values as `MCP_HIDDEN`. */
  spec: McpServerSpec,
  type: McpTransport,
  /** The config file it is saved in. */
  scope: ConfigScope,
  status: McpStatus,
  /** Why it is in `error` or `auth`. */
  error: Schema.optional(Schema.String),
  /** Epoch ms of the next connection attempt. */
  retryAt: Schema.optional(Schema.Number),
  /** Epoch ms it entered its status. */
  since: Schema.Number,
  /** How the server describes itself, once connected. */
  server: Schema.optional(Schema.Struct({ name: Schema.String, version: Schema.String, title: Schema.optional(Schema.String) })),
  /** The protocol revision agreed on. */
  protocol: Schema.optional(Schema.String),
  /** What the server tells clients about using it. */
  instructions: Schema.optional(Schema.String),
  tools: Schema.Array(McpToolInfo),
  /** How many resources and resource templates, and prompts, it offers. */
  resources: Schema.Number,
  prompts: Schema.Number,
  /** For a URL server: whether a sign-in is stored. */
  signedIn: Schema.optional(Schema.Boolean),
  /** Names of the secrets stored for it (never their values). */
  secrets: Schema.Array(Schema.String),
  /** `${NAME}`s it uses that neither a stored secret nor the host's environment sets. */
  missing: Schema.Array(Schema.String),
});
export type McpServerInfo = typeof McpServerInfo.Type;

/** A line a server wrote to stderr (or stdout, outside the protocol), or a log message it sent, or what the host noted about it. */
export const McpLogEntry = Schema.Struct({
  /** Epoch ms. */
  at: Schema.Number,
  source: Schema.Literal("stderr", "stdout", "server", "host"),
  /** For `server`: the MCP log level. */
  level: Schema.optional(Schema.String),
  text: Schema.String,
});
export type McpLogEntry = typeof McpLogEntry.Type;

/**
 * `NotFound`: no server has the id. `Invalid`: the spec is refused. `Auth`: a
 * sign-in failed. `Cancelled`: the person dismissed a question. `Failed`:
 * anything else (saving the config, a refused reload).
 */
export class McpError extends Data.TaggedError("McpError")<{
  readonly server?: string;
  readonly reason: "NotFound" | "Invalid" | "Auth" | "Cancelled" | "Failed";
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** The servers changed: one was added, removed, or reconfigured, connected or lost, or its tools changed. Losable. */
export const McpChanged = Event.make<{ readonly servers: readonly McpServerInfo[] }>("lemma/mcp.changed");

/**
 * Who manages MCP servers: the first contribution by order answers clients.
 * The `mcp` plugin is the bundled one. With none, the transport's `Mcp.*`
 * calls fail `Unavailable` and nothing else stops: the transport reads this
 * rather than requiring it, so MCP can be turned off.
 */
export interface McpManager {
  /** By convention its plugin's id. */
  readonly id: string;
  readonly servers: Effect.Effect<readonly McpServerInfo[]>;
  /**
   * Adds a server, or replaces the one with its id, in the config file the
   * plugin's config comes from (or `scope`). `secrets` are stored for the
   * server, not in the config; `null` removes one.
   */
  readonly save: (
    spec: McpServerSpec,
    options?: { readonly secrets?: Readonly<Record<string, string | null>>; readonly scope?: ConfigScope },
  ) => Effect.Effect<void, McpError>;
  /** Removes it from the config, with its secrets and sign-in. */
  readonly remove: (id: string) => Effect.Effect<void, McpError>;
  readonly setEnabled: (id: string, enabled: boolean) => Effect.Effect<void, McpError>;
  /** Offers or withholds one of its tools, by the server's name for it. */
  readonly setTool: (id: string, tool: string, enabled: boolean) => Effect.Effect<void, McpError>;
  /** Disconnects and connects again, retrying one that gave up. */
  readonly restart: (id: string) => Effect.Effect<void, McpError>;
  /** Signs in to a URL server through `Interaction` and notices; resolves once its tools are back. */
  readonly login: (id: string) => Effect.Effect<void, McpError>;
  readonly logout: (id: string) => Effect.Effect<void, McpError>;
  /** What it printed and logged recently, oldest first. */
  readonly logs: (id: string) => Effect.Effect<readonly McpLogEntry[], McpError>;
}

export const McpManagers = Registry.make<McpManager>("lemma/mcp-managers", { key: (manager) => manager.id });
