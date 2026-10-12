import { Client, SdkHttpError, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { Tool as McpTool } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { McpServerConfig } from "@lemma/mcp";
import type { CallResult } from "./tools.ts";

export type { McpTool };

/** How much of a local server's stderr is kept for clients to show (`McpServerStatus.stderr`). */
const STDERR_TAIL = 4096;
const DEFAULT_TIMEOUT_SECONDS = 60;
/** The longest a timer waits: past it, Node fires one at once. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

export interface ConnectionEvents {
  /** The state, the server's identity, or its stderr changed. */
  readonly changed: () => void;
  /** The server listed its tools: on connecting, and whenever it says they changed. */
  readonly tools: (tools: readonly McpTool[]) => void;
}

/** What went wrong, in words a person can act on. */
export function describe(error: unknown, config: McpServerConfig): string {
  if (error instanceof SdkHttpError && (error.status === 401 || error.status === 403))
    return `The server answered ${error.status}: it needs sign-in, which Lemma does not do yet. Give it an Authorization header in "headers".`;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT" && config.command !== undefined) return `Command not found: ${config.command}`;
  if (code === "ERR_INVALID_URL") return `Not a URL: ${config.url} (write it whole, as https://example.com/mcp)`;
  return error instanceof Error ? error.message : String(error);
}

/**
 * One server's connection: a local process over stdio, or a remote endpoint over Streamable HTTP, through the official
 * SDK, which speaks both the stateless protocol (2026-07-28) and the earlier ones, probing which a server speaks. It
 * connects once at a time; a call finding it closed or failed connects again.
 */
export class Connection {
  state: "connecting" | "connected" | "failed" | "closed" = "connecting";
  error: string | undefined;
  stderr = "";
  server: { readonly name: string; readonly version?: string; readonly title?: string } | undefined;
  protocolVersion: string | undefined;
  instructions: string | undefined;
  private client: Client | undefined;
  private connecting: Promise<Client> | undefined;
  /** Stops the connect under way: its probe, its handshake, and a local server's process. */
  private cancel: (() => void) | undefined;
  private closing = false;
  /** With its variables expanded. */
  readonly config: McpServerConfig;
  private readonly events: ConnectionEvents;
  private readonly clientVersion: string;

  constructor(config: McpServerConfig, events: ConnectionEvents, clientVersion: string) {
    this.config = config;
    this.events = events;
    this.clientVersion = clientVersion;
  }

  /** A timeout past what a timer can wait waits as long as one can, about 24 days. */
  get timeoutMs(): number {
    return Math.min((this.config.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000, MAX_TIMEOUT_MS);
  }

  /** The connected client, connecting first if it is not. */
  ready(): Promise<Client> {
    if (this.closing) return Promise.reject(new Error("The server was stopped"));
    if (this.client !== undefined && this.state === "connected") return Promise.resolve(this.client);
    this.connecting ??= this.open().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  /** Calls a tool, connecting first if need be. Progress the server reports restarts the timeout. */
  async call(name: string, args: unknown, signal: AbortSignal, progress?: (line: string) => void): Promise<CallResult> {
    const client = await this.ready();
    return (await client.callTool(
      { name, arguments: (args ?? {}) as Record<string, unknown> },
      {
        signal,
        timeout: this.timeoutMs,
        resetTimeoutOnProgress: true,
        ...(progress === undefined
          ? {}
          : {
              onprogress: ({ progress: done, total, message }) => {
                if (message !== undefined) progress(`${message}${total === undefined ? "" : ` (${done}/${total})`}\n`);
              },
            }),
      },
    )) as CallResult;
  }

  /** Stops it: a connect under way is cut off rather than waited for, so a server that never answers holds nothing up. */
  async close(): Promise<void> {
    this.closing = true;
    this.state = "closed";
    const client = this.client;
    this.client = undefined;
    this.cancel?.();
    await this.connecting?.catch(() => {});
    await client?.close().catch(() => {});
  }

  private async open(): Promise<Client> {
    this.state = "connecting";
    this.error = undefined;
    this.events.changed();
    const client = new Client(
      { name: "lemma", version: this.clientVersion },
      {
        versionNegotiation: { mode: "auto" },
        listChanged: {
          tools: {
            onChanged: (error, tools) => {
              if (error === null && tools !== null && this.client === client) this.events.tools(tools);
            },
          },
        },
      },
    );
    client.onclose = () => {
      if (this.client !== client || this.closing) return;
      this.client = undefined;
      this.state = "failed";
      this.error = "The connection closed";
      this.events.changed();
    };
    let transport: StreamableHTTPClientTransport | StdioClientTransport | undefined;
    // Closing the transport stops the probe (on its sibling process too) and the handshake; the client, a listing.
    this.cancel = () => {
      void transport?.close().catch(() => {});
      void client.close().catch(() => {});
    };
    try {
      transport = this.transport();
      if (transport instanceof StdioClientTransport) {
        transport.stderr?.on("data", (chunk: Buffer) => {
          this.stderr = (this.stderr + chunk.toString("utf8")).slice(-STDERR_TAIL);
        });
      }
      if (this.closing) throw new Error("The server was stopped");
      await client.connect(transport, { timeout: this.timeoutMs });
      const tools = client.getServerCapabilities()?.tools === undefined ? [] : (await client.listTools(undefined, { timeout: this.timeoutMs })).tools;
      if (this.closing) throw new Error("The server was stopped");
      const info = client.getServerVersion();
      this.server = info === undefined ? undefined : { name: info.name, version: info.version, ...(info.title === undefined ? {} : { title: info.title }) };
      this.protocolVersion = client.getNegotiatedProtocolVersion();
      this.instructions = client.getInstructions();
      this.client = client;
      this.state = "connected";
      this.events.tools(tools);
      this.events.changed();
      return client;
    } catch (error) {
      await client.close().catch(() => {});
      // One that never connected is not the client's to close.
      await transport?.close().catch(() => {});
      if (!this.closing) {
        this.state = "failed";
        this.error = describe(error, this.config);
        this.events.changed();
      }
      throw new Error(this.error ?? describe(error, this.config), { cause: error });
    } finally {
      this.cancel = undefined;
    }
  }

  /** Throws for a `url` that is not one. */
  private transport(): StreamableHTTPClientTransport | StdioClientTransport {
    const { command, url } = this.config;
    if (url !== undefined)
      return new StreamableHTTPClientTransport(new URL(url), this.config.headers === undefined ? {} : { requestInit: { headers: { ...this.config.headers } } });
    return new StdioClientTransport({
      command: command!,
      args: [...(this.config.args ?? [])],
      ...(this.config.env === undefined ? {} : { env: { ...this.config.env } }),
      ...(this.config.cwd === undefined ? {} : { cwd: this.config.cwd }),
      stderr: "pipe",
    });
  }
}
