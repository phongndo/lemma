import type { Client, StreamableHTTPClientTransport, Tool as McpTool } from "@modelcontextprotocol/client";
import type { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { McpServerConfig } from "@lemma/mcp";
import { isImageAddress } from "./form.ts";
import type { CallResult } from "./tools.ts";

export type { McpTool };

type Sdk = typeof import("@modelcontextprotocol/client") & typeof import("@modelcontextprotocol/client/stdio");
/**
 * The SDK, imported by the first connect rather than with the plugin: with zod it is most of the code the plugin
 * loads, for servers a host may have none of. One that cannot be loaded fails the connect, saying why.
 */
let sdk: Sdk | undefined;
let loading: Promise<Sdk> | undefined;
const loadSdk = (): Promise<Sdk> =>
  (loading ??= Promise.all([import("@modelcontextprotocol/client"), import("@modelcontextprotocol/client/stdio")]).then(
    ([client, stdio]) => (sdk = { ...client, ...stdio }),
    (error: unknown) => {
      loading = undefined;
      throw error;
    },
  ));

/**
 * The protocol era each server spoke when it last connected in this process, by how it is started. The SDK asks a
 * server which it speaks (`server/discover`), a local one on a second copy of it, a process of its own (for a Node.js
 * server, 70–100 MB more while it runs), since a 2025 server may exit on a request it does not know. Once known, it is
 * not asked so again: a 2025 server is initialized at once (`prior`), and a 2026-07-28 one is asked on its own process,
 * which answers. A connect that fails forgets it, so the next asks as the first did.
 */
const eras = new Map<string, "legacy" | "modern">();
const eraKey = (config: McpServerConfig) => JSON.stringify([config.command, config.args, config.env, config.cwd, config.url, config.headers]);
/** The SDK's stdio transport, but asking which era on the process it starts: a subclass is asked in place. */
let inPlace: Sdk["StdioClientTransport"] | undefined;

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
  if (sdk !== undefined && error instanceof sdk.SdkHttpError && (error.status === 401 || error.status === 403))
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
  /** The icon the server declares, an `https:` or `data:` image; one for a theme only when it has no other. */
  icon: string | undefined;
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
    const loaded = await loadSdk().catch((error: unknown) => this.failed(error));
    const client = new loaded.Client(
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
    const key = eraKey(this.config);
    const era = eras.get(key);
    try {
      transport = this.transport(loaded, era === "modern");
      if (transport instanceof loaded.StdioClientTransport) {
        transport.stderr?.on("data", (chunk: Buffer) => {
          this.stderr = (this.stderr + chunk.toString("utf8")).slice(-STDERR_TAIL);
        });
      }
      if (this.closing) throw new Error("The server was stopped");
      await client.connect(transport, { timeout: this.timeoutMs, ...(era === "legacy" ? { prior: { kind: "legacy" as const } } : {}) });
      const tools = client.getServerCapabilities()?.tools === undefined ? [] : (await client.listTools(undefined, { timeout: this.timeoutMs })).tools;
      if (this.closing) throw new Error("The server was stopped");
      const info = client.getServerVersion();
      this.server = info === undefined ? undefined : { name: info.name, version: info.version, ...(info.title === undefined ? {} : { title: info.title }) };
      const icons = (info?.icons ?? []).filter((candidate) => isImageAddress(candidate.src));
      this.icon = (icons.find((candidate) => candidate.theme === undefined) ?? icons[0])?.src;
      this.protocolVersion = client.getNegotiatedProtocolVersion();
      this.instructions = client.getInstructions();
      const spoke = client.getProtocolEra();
      if (spoke === undefined) eras.delete(key);
      else eras.set(key, spoke);
      this.client = client;
      this.state = "connected";
      this.events.tools(tools);
      this.events.changed();
      return client;
    } catch (error) {
      eras.delete(key);
      await client.close().catch(() => {});
      // One that never connected is not the client's to close.
      await transport?.close().catch(() => {});
      return this.failed(error);
    } finally {
      this.cancel = undefined;
    }
  }

  /** Says why the connect failed, unless it was stopped, and throws it. */
  private failed(error: unknown): never {
    if (!this.closing) {
      this.state = "failed";
      this.error = describe(error, this.config);
      this.events.changed();
    }
    throw new Error(this.error ?? describe(error, this.config), { cause: error });
  }

  /** Throws for a `url` that is not one. A local server known to speak 2026-07-28 is asked which era `inPlace`. */
  private transport(loaded: Sdk, modern: boolean): StreamableHTTPClientTransport | StdioClientTransport {
    const { command, url } = this.config;
    if (url !== undefined)
      return new loaded.StreamableHTTPClientTransport(
        new URL(url),
        this.config.headers === undefined ? {} : { requestInit: { headers: { ...this.config.headers } } },
      );
    const Transport = modern ? (inPlace ??= class extends loaded.StdioClientTransport {}) : loaded.StdioClientTransport;
    return new Transport({
      command: command!,
      args: [...(this.config.args ?? [])],
      ...(this.config.env === undefined ? {} : { env: { ...this.config.env } }),
      ...(this.config.cwd === undefined ? {} : { cwd: this.config.cwd }),
      stderr: "pipe",
    });
  }
}
