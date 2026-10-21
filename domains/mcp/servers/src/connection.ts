import type { AuthProvider, Client, StreamableHTTPClientTransport, Tool as McpTool } from "@modelcontextprotocol/client";
import type { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { McpServerConfig } from "@lemma/mcp";
import { NeedsSignIn, needsSignIn } from "./auth.ts";
import type { Challenge } from "./auth.ts";
import { isImageAddress } from "./form.ts";
import { loadedSdk, loadSdk } from "./sdk.ts";
import type { Sdk } from "./sdk.ts";
import type { CallResult } from "./tools.ts";

export type { McpTool };

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
  /** The server refused for want of a scope the sign-in lacks: the next sign-in asks for it. */
  readonly challenged?: (challenge: Challenge) => void;
}

/** The HTTP status of an error the SDK threw for one. */
const statusOf = (error: unknown): number | undefined => {
  const sdk = loadedSdk();
  return sdk !== undefined && error instanceof sdk.SdkHttpError ? error.status : undefined;
};

/** What went wrong, in words a person can act on. */
export function describe(error: unknown, config: McpServerConfig): string {
  const status = statusOf(error);
  if (status === 401 || status === 403)
    return `The server answered ${status}: it refused the token in the Authorization header. Check it, or remove the header to sign in instead.`;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT" && config.command !== undefined) return `Command not found: ${config.command}`;
  if (code === "ERR_INVALID_URL") return `Not a URL: ${config.url} (write it whole, as https://example.com/mcp)`;
  return error instanceof Error ? error.message : String(error);
}

/** The icons a server declares, as `Connection.icons` keeps them: one for any theme, and one for a dark theme besides. */
export function declaredIcons(declared: readonly { readonly src: string; readonly theme?: "light" | "dark" | undefined }[]): Connection["icons"] {
  const icons = declared.filter((candidate) => isImageAddress(candidate.src));
  const of = (theme: "light" | "dark" | undefined) => icons.find((candidate) => candidate.theme === theme)?.src;
  const icon = of(undefined) ?? of("light") ?? of("dark");
  const dark = of("dark");
  if (icon === undefined) return undefined;
  return dark === undefined || dark === icon ? { icon } : { icon, iconDark: dark };
}

/**
 * Whether a remote server that failed to connect may connect later: not one whose address is wrong, or that answered
 * with a client error other than a timeout or a rate limit, which trying again would only repeat.
 */
const retryable = (error: unknown): boolean => {
  if ((error as NodeJS.ErrnoException | undefined)?.code === "ERR_INVALID_URL") return false;
  const status = statusOf(error);
  return status === undefined || status < 400 || status >= 500 || status === 408 || status === 429;
};

/**
 * Whether a remote server refused for want of a sign-in: Lemma holds none it accepts, the server says so, or it
 * needs a scope the sign-in lacks. A renewal that failed for now (`RenewalFailed`) is none of these.
 */
const refused = (error: unknown): boolean => {
  if (needsSignIn(error)) return true;
  const sdk = loadedSdk();
  if (sdk === undefined) return false;
  const status = statusOf(error);
  return sdk.UnauthorizedError.isInstance(error) || sdk.InsufficientScopeError.isInstance(error) || status === 401 || status === 403;
};

/**
 * One server's connection: a local process over stdio, or a remote endpoint over Streamable HTTP, through the official
 * SDK, which speaks both the stateless protocol (2026-07-28) and the earlier ones, probing which a server speaks. It
 * connects once at a time; a call finding it closed or failed connects again. A remote server Lemma signs in to sends
 * the token `auth` holds; one that refuses it for want of a sign-in is `needs-sign-in` until it is connected again.
 */
export class Connection {
  state: "connecting" | "connected" | "failed" | "needs-sign-in" | "closed" = "connecting";
  error: string | undefined;
  /** Whether trying again later may connect: a remote server that could not be reached, or that dropped the connection. */
  retryable = false;
  stderr = "";
  server: { readonly name: string; readonly version?: string; readonly title?: string } | undefined;
  protocolVersion: string | undefined;
  instructions: string | undefined;
  /**
   * The icons the server declares, `https:` or `data:` images: `icon` for any theme (one for a light theme, or the only
   * one, when it has none for any), and `iconDark` for a dark theme when it declares one besides.
   */
  icons: { readonly icon?: string; readonly iconDark?: string } | undefined;
  private client: Client | undefined;
  private connecting: Promise<Client> | undefined;
  /** Stops the connect under way: its probe, its handshake, and a local server's process. */
  private cancel: (() => void) | undefined;
  private closing = false;
  /** With its variables expanded. */
  readonly config: McpServerConfig;
  private readonly events: ConnectionEvents;
  private readonly clientVersion: string;
  /** The bearer of a remote server Lemma signs in to. */
  private readonly auth: AuthProvider | undefined;

  constructor(config: McpServerConfig, events: ConnectionEvents, clientVersion: string, auth?: AuthProvider) {
    this.config = config;
    this.events = events;
    this.clientVersion = clientVersion;
    this.auth = auth;
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

  /**
   * Calls a tool, connecting first if need be. Progress the server reports restarts the timeout. A server that refuses
   * the call for want of a sign-in is `needs-sign-in`, and the call fails `NeedsSignIn`.
   */
  async call(name: string, args: unknown, signal: AbortSignal, progress?: (line: string) => void): Promise<CallResult> {
    const client = await this.ready();
    try {
      return await this.callWith(client, name, args, signal, progress);
    } catch (error) {
      if (this.auth === undefined || !refused(error)) throw error;
      this.challenge(error);
      if (this.client === client) {
        this.client = undefined;
        this.state = "needs-sign-in";
        this.retryable = false;
        this.events.changed();
        await client.close().catch(() => {});
      }
      throw new NeedsSignIn();
    }
  }

  private async callWith(client: Client, name: string, args: unknown, signal: AbortSignal, progress?: (line: string) => void): Promise<CallResult> {
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
      this.retryable = this.config.url !== undefined;
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
      this.icons = declaredIcons(info?.icons ?? []);
      this.protocolVersion = client.getNegotiatedProtocolVersion();
      this.instructions = client.getInstructions();
      const spoke = client.getProtocolEra();
      if (spoke === undefined) eras.delete(key);
      else eras.set(key, spoke);
      this.client = client;
      this.state = "connected";
      this.retryable = false;
      this.events.tools(tools);
      this.events.changed();
      return client;
    } catch (error) {
      eras.delete(key);
      await client.close().catch(() => {});
      // One that never connected is not the client's to close.
      await transport?.close().catch(() => {});
      if (this.auth !== undefined && refused(error)) {
        this.challenge(error);
        if (!this.closing) {
          this.state = "needs-sign-in";
          this.error = undefined;
          this.retryable = false;
          this.events.changed();
        }
        throw new NeedsSignIn();
      }
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
      this.retryable = this.config.url !== undefined && retryable(error);
      this.events.changed();
    }
    throw new Error(this.error ?? describe(error, this.config), { cause: error });
  }

  /** Passes on the scope a `403 insufficient_scope` asked for, and where the server's metadata is. */
  private challenge(error: unknown): void {
    const sdk = loadedSdk();
    if (sdk === undefined || !sdk.InsufficientScopeError.isInstance(error)) return;
    this.events.challenged?.({
      ...(error.requiredScope === undefined ? {} : { scope: error.requiredScope }),
      ...(error.resourceMetadataUrl === undefined ? {} : { resourceMetadataUrl: error.resourceMetadataUrl }),
    });
  }

  /** Throws for a `url` that is not one. A local server known to speak 2026-07-28 is asked which era `inPlace`. */
  private transport(loaded: Sdk, modern: boolean): StreamableHTTPClientTransport | StdioClientTransport {
    const { command, url } = this.config;
    if (url !== undefined)
      return new loaded.StreamableHTTPClientTransport(new URL(url), {
        ...(this.config.headers === undefined ? {} : { requestInit: { headers: { ...this.config.headers } } }),
        ...(this.auth === undefined ? {} : { authProvider: this.auth }),
      });
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
