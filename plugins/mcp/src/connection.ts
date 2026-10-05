import {
  Client,
  OAuthError,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import type {
  CallToolResult,
  ElicitRequest,
  ElicitResult,
  Implementation,
  OAuthClientProvider,
  PriorDiscovery,
  ReadResourceResult,
  Resource,
  Tool,
  Transport,
} from "@modelcontextprotocol/client";
import type { McpLogEntry, McpStatus } from "@lemma/contracts";
import { StdioTransport } from "./stdio.ts";

/** How to reach a server, every `${NAME}` already resolved. Two connections with equal launches are the same server. */
export type Launch =
  | {
      readonly type: "stdio";
      readonly command: string;
      readonly args: readonly string[];
      readonly env: Readonly<Record<string, string>>;
      readonly cwd: string;
    }
  | {
      readonly type: "http" | "sse";
      readonly url: string;
      readonly headers: Readonly<Record<string, string>>;
      /** `http` was inferred rather than written: a server that refuses it is tried over SSE. */
      readonly fallback: boolean;
    };

/**
 * What the plugin instance holding a connection lends it. A reload hands a
 * connection to the new instance, which binds its own, so nothing here
 * outlives the instance that provided it.
 */
export interface Binding {
  /** Signs requests to a URL server; absent, it is sent no token. */
  readonly auth?: OAuthClientProvider;
  /** Answers the server's questions; absent, they are declined. */
  readonly elicit?: (request: ElicitRequest["params"]) => Promise<ElicitResult>;
}

export interface ServerIdentity {
  readonly name: string;
  readonly version: string;
  readonly title?: string;
}

/** A connection as its holders see it. `off` is never a connection's: a server turned off has none. */
export interface ConnectionState {
  readonly status: Exclude<McpStatus, "off">;
  readonly error?: string;
  readonly retryAt?: number;
  readonly since: number;
  readonly server?: ServerIdentity;
  readonly protocol?: string;
  readonly instructions?: string;
  readonly tools: readonly Tool[];
  readonly resources: number;
  readonly prompts: number;
}

export interface CallOptions {
  readonly signal: AbortSignal;
  /** How long the server may go without answering or reporting progress. */
  readonly timeoutMs: number;
  /** How long the call may take at all. */
  readonly maxTotalMs: number;
  /** Progress the server reports, as a line to show. */
  readonly onProgress?: (line: string) => void;
}

/** Waits before each retry of a connection that failed; past the last, it waits for a restart or a call. */
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000];
/** A connection up at least this long that then drops gets its retries back. */
const STABLE_MS = 30_000;
/** How long the version probe waits on a stdio server before taking silence to mean an older server. */
const STDIO_PROBE_MS = 10_000;
const MAX_LOG_ENTRIES = 500;
const MAX_LOG_LINE = 4_000;

export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : typeof error === "string" ? error : String(error));

/** The server wants a sign-in, or the stored one no longer works (a refused refresh). */
export const isUnauthorized = (error: unknown): boolean =>
  error instanceof UnauthorizedError ||
  error instanceof OAuthError ||
  (error instanceof SdkError && error.code === SdkErrorCode.ClientHttpAuthentication) ||
  (error instanceof SdkHttpError && error.status === 401);

/** A Streamable HTTP refusal that an older HTTP+SSE server gives (the spec's fallback test). */
const refusesStreamable = (error: unknown): boolean =>
  error instanceof SdkHttpError ? [400, 404, 405].includes(error.status) : error instanceof SdkError && error.code === SdkErrorCode.ClientHttpNotImplemented;

/**
 * One MCP server: connects in the background, retries with backoff, keeps
 * its tool list current, and keeps what it printed. Holders subscribe to its
 * state and bind what it borrows from them (see `Binding`).
 */
export class Connection {
  private client: Client | undefined;
  private current: ConnectionState = { status: "starting", since: Date.now(), tools: [], resources: 0, prompts: 0 };
  private readonly listeners = new Set<() => void>();
  private readonly entries: McpLogEntry[] = [];
  /** Bindings of the instances holding it, newest last; the newest is the one used. */
  private readonly bindings: Binding[] = [];
  private failures = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private connecting: Promise<void> | undefined;
  /** What the last connection agreed on, so a reconnect skips the version probe; `legacy` after a probe went wrong. */
  private prior: PriorDiscovery | undefined;
  private connectedAt = 0;
  private closed = false;
  /** Settles when the first connection attempt does, however it ends. */
  readonly firstAttempt: Promise<void>;
  private settleFirst!: () => void;
  /** Bumped by every (re)connect and close, so a superseded attempt's outcome is ignored. */
  private generation = 0;

  readonly id: string;
  readonly launch: Launch;
  private readonly options: { readonly startupTimeoutMs: number; readonly clientInfo: Implementation };

  constructor(id: string, launch: Launch, options: { readonly startupTimeoutMs: number; readonly clientInfo: Implementation }) {
    this.id = id;
    this.launch = launch;
    this.options = options;
    this.firstAttempt = new Promise((resolve) => (this.settleFirst = resolve));
  }

  get state(): ConnectionState {
    return this.current;
  }

  get logs(): readonly McpLogEntry[] {
    return this.entries;
  }

  /** Called on every change of state. Returns the unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private get binding(): Binding {
    return this.bindings.at(-1) ?? {};
  }

  /** Lends it a holder's `Binding` until the returned function takes it back; the newest holder's is used. */
  bind(binding: Binding): () => void {
    this.bindings.push(binding);
    return () => {
      const at = this.bindings.indexOf(binding);
      if (at !== -1) this.bindings.splice(at, 1);
    };
  }

  /** An auth provider whose every method is the bound one's, so a transport made before a reload signs with the new instance's. */
  private readonly authProxy: OAuthClientProvider = new Proxy({} as OAuthClientProvider, {
    get: (_, key) => {
      const target = this.binding.auth as unknown as Record<PropertyKey, unknown> | undefined;
      const value = target?.[key];
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
    has: (_, key) => this.binding.auth !== undefined && key in this.binding.auth,
  });

  log(source: McpLogEntry["source"], text: string, level?: string): void {
    const line = text.length > MAX_LOG_LINE ? `${text.slice(0, MAX_LOG_LINE)}…` : text;
    this.entries.push({ at: Date.now(), source, text: line, ...(level === undefined ? {} : { level }) });
    if (this.entries.length > MAX_LOG_ENTRIES) this.entries.splice(0, this.entries.length - MAX_LOG_ENTRIES);
  }

  private set(next: Partial<ConnectionState> & Pick<ConnectionState, "status">): void {
    const changed = next.status !== this.current.status;
    this.current = {
      ...this.current,
      ...next,
      since: changed ? Date.now() : this.current.since,
      ...(next.status === "ready" || next.error !== undefined ? {} : { error: undefined }),
    } as ConnectionState;
    if (next.retryAt === undefined) this.current = withoutKey(this.current, "retryAt");
    if (next.error === undefined) this.current = withoutKey(this.current, "error");
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // A holder's failure is its own.
      }
    }
  }

  /** Connects unless connected or connecting; resolves once this attempt settles, never rejecting. */
  start(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.connecting !== undefined) return this.connecting;
    if (this.current.status === "ready" && this.client !== undefined) return Promise.resolve();
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    const generation = ++this.generation;
    this.set({ status: "starting" });
    this.connecting = this.connect(generation).finally(() => {
      if (this.generation === generation) this.connecting = undefined;
      this.settleFirst();
    });
    return this.connecting;
  }

  /** Drops the connection and connects again with fresh retries. */
  async restart(): Promise<void> {
    if (this.closed) return;
    this.failures = 0;
    this.prior = undefined;
    await this.disconnect();
    await this.start();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.settleFirst();
    clearTimeout(this.retryTimer);
    await this.disconnect();
    this.listeners.clear();
  }

  private async disconnect(): Promise<void> {
    this.generation++;
    this.connecting = undefined;
    const client = this.client;
    this.client = undefined;
    if (client !== undefined) await client.close().catch(() => {});
  }

  private async connect(generation: number): Promise<void> {
    const stale = () => generation !== this.generation || this.closed;
    let client: Client | undefined;
    try {
      client = await this.open(this.launch.type === "sse" ? "sse" : this.launch.type === "http" ? "http" : "stdio");
      if (stale()) {
        await client.close().catch(() => {});
        return;
      }
      this.client = client;
      const era = client.getProtocolEra();
      const discover = client.getDiscoverResult();
      this.prior = era === "modern" && discover !== undefined ? { kind: "modern", discover } : { kind: "legacy" };
      const listed = await this.list(client);
      if (stale()) return;
      this.connectedAt = Date.now();
      const version = client.getServerVersion();
      const instructions = client.getInstructions();
      const protocol = client.getNegotiatedProtocolVersion();
      this.set({
        status: "ready",
        tools: listed.tools,
        resources: listed.resources,
        prompts: listed.prompts,
        ...(version === undefined ? {} : { server: identity(version) }),
        ...(instructions === undefined ? {} : { instructions }),
        ...(protocol === undefined ? {} : { protocol }),
      });
      this.log("host", `Connected${version === undefined ? "" : ` to ${version.name} ${version.version}`}; ${listed.tools.length} tools`);
    } catch (error) {
      if (client !== undefined && this.client !== client) await client.close().catch(() => {});
      if (stale()) return;
      this.client = undefined;
      this.failed(error);
    }
  }

  /** A new client over a new transport, connected. HTTP falls back to SSE when the server refuses it and the type was inferred. */
  private async open(kind: "stdio" | "http" | "sse"): Promise<Client> {
    const client = this.makeClient();
    const transport = this.makeTransport(kind);
    this.watchClose(client, transport);
    try {
      await client.connect(transport, {
        timeout: this.options.startupTimeoutMs,
        ...(this.prior === undefined ? {} : { prior: this.prior }),
      });
      return client;
    } catch (error) {
      await client.close().catch(() => {});
      if (kind === "http" && this.launch.type === "http" && this.launch.fallback && refusesStreamable(error)) {
        this.log("host", `Streamable HTTP refused (${errorMessage(error)}); trying HTTP+SSE`);
        return this.open("sse");
      }
      // A probe that went wrong is not the server's fault: the next try skips it.
      if (this.prior === undefined && error instanceof SdkError && error.code === SdkErrorCode.EraNegotiationFailed) this.prior = { kind: "legacy" };
      throw error;
    }
  }

  private makeClient(): Client {
    const client = new Client(this.options.clientInfo, {
      capabilities: { elicitation: { form: {}, url: {} } },
      versionNegotiation: { mode: "auto", ...(this.launch.type === "stdio" ? { probe: { timeoutMs: STDIO_PROBE_MS } } : {}) },
      listChanged: {
        tools: {
          onChanged: (error, tools) => {
            if (error !== null) this.log("host", `Could not refresh the tool list: ${error.message}`);
            else if (tools !== null && this.client === client) {
              this.log("host", `The server changed its tools: ${tools.length} now`);
              this.set({ status: this.current.status, tools });
            }
          },
        },
        prompts: {
          onChanged: (_, prompts) => prompts !== null && this.client === client && this.set({ status: this.current.status, prompts: prompts.length }),
        },
        resources: {
          onChanged: () => this.client === client && void this.countResources(client).then((resources) => this.set({ status: this.current.status, resources })),
        },
      },
    });
    client.setRequestHandler("elicitation/create", async (request) => {
      const elicit = this.binding.elicit;
      if (elicit === undefined) return { action: "decline" };
      return elicit(request.params);
    });
    client.setNotificationHandler("notifications/message", (notification) => {
      const data = notification.params.data;
      this.log("server", typeof data === "string" ? data : JSON.stringify(data), notification.params.level);
    });
    client.onerror = (error) => this.log("host", errorMessage(error));
    return client;
  }

  /** A connection that drops after connecting is lost, and retried. */
  private watchClose(client: Client, transport: Transport): void {
    client.onclose = () => {
      if (this.client !== client || this.closed) return;
      this.client = undefined;
      const reason = (transport instanceof StdioTransport ? transport.exit : undefined) ?? "closed the connection";
      this.log("host", `The server ${reason}`);
      // Up long enough: a crash, not a crash loop; its retries start over.
      if (Date.now() - this.connectedAt >= STABLE_MS) this.failures = 0;
      this.failed(new Error(`The server ${reason}`));
    };
  }

  private makeTransport(kind: "stdio" | "http" | "sse"): Transport {
    const launch = this.launch;
    if (launch.type === "stdio") {
      return new StdioTransport({
        command: launch.command,
        args: launch.args,
        env: launch.env,
        cwd: launch.cwd,
        onLog: (line, stream) => this.log(stream, line),
      });
    }
    const url = new URL(launch.url);
    const options = {
      requestInit: { headers: { ...launch.headers } },
      ...(this.binding.auth === undefined ? {} : { authProvider: this.authProxy }),
    };
    return kind === "sse" ? new SSEClientTransport(url, options) : new StreamableHTTPClientTransport(url, options);
  }

  /** Every tool (all pages), and how many resources and prompts, as the server's capabilities allow. */
  private async list(client: Client) {
    const capabilities = client.getServerCapabilities() ?? {};
    const timeout = this.options.startupTimeoutMs;
    const tools = capabilities.tools === undefined ? [] : (await client.listTools(undefined, { timeout })).tools;
    const resources = capabilities.resources === undefined ? 0 : await this.countResources(client);
    const prompts =
      capabilities.prompts === undefined
        ? 0
        : await client.listPrompts(undefined, { timeout }).then(
            (result) => result.prompts.length,
            () => 0,
          );
    return { tools, resources, prompts };
  }

  private async countResources(client: Client): Promise<number> {
    const timeout = this.options.startupTimeoutMs;
    const [resources, templates] = await Promise.all([
      client.listResources(undefined, { timeout }).then(
        (result) => result.resources.length,
        () => 0,
      ),
      client.listResourceTemplates(undefined, { timeout }).then(
        (result) => result.resourceTemplates.length,
        () => 0,
      ),
    ]);
    return resources + templates;
  }

  private failed(error: unknown): void {
    if (isUnauthorized(error)) {
      this.log("host", "The server asks to sign in");
      this.set({ status: "auth", error: "Sign in to use this server" });
      return;
    }
    const message = errorMessage(error);
    this.log("host", `Could not connect: ${message}`);
    const delay = RETRY_DELAYS_MS[this.failures];
    this.failures++;
    if (delay === undefined) {
      this.set({ status: "error", error: message });
      return;
    }
    const retryAt = Date.now() + delay;
    this.set({ status: "error", error: message, retryAt });
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.start();
    }, delay);
    this.retryTimer.unref?.();
  }

  /**
   * The connected client, connecting first when it is not (a call is a reason
   * to try now). Fails with why it is not there.
   */
  private async ready(signal: AbortSignal): Promise<Client> {
    if (this.client !== undefined && this.current.status === "ready") return this.client;
    if (this.current.status === "auth")
      throw new Error(`MCP server "${this.id}" needs you to sign in: open Settings → MCP servers, or run \`lemma mcp login ${this.id}\``);
    // Given up on: this one try, and no more retries if it fails too.
    if (this.current.status === "error" && this.retryTimer === undefined) this.failures = RETRY_DELAYS_MS.length;
    // Joins a connection under way, or connects now instead of at the next retry.
    await abortable(this.start(), signal);
    if (this.client !== undefined && this.current.status === "ready") return this.client;
    throw new Error(`MCP server "${this.id}" is not connected${this.current.error === undefined ? "" : `: ${this.current.error}`}`);
  }

  /**
   * Calls a tool. A URL server that forgot the connection's session (404) is
   * connected to again and the call made once more, since it never ran; one
   * that refuses the sign-in (401) is marked as wanting one.
   */
  async callTool(name: string, args: Record<string, unknown>, options: CallOptions): Promise<CallToolResult> {
    try {
      return await this.callOnce(name, args, options);
    } catch (error) {
      if (this.launch.type !== "stdio" && error instanceof SdkHttpError && error.status === 404 && !options.signal.aborted) {
        this.log("host", "The server lost the session; connecting again");
        await this.restart();
        return this.callOnce(name, args, options);
      }
      if (isUnauthorized(error) && this.client !== undefined) {
        const client = this.client;
        this.client = undefined;
        void client.close().catch(() => {});
        this.failed(error);
      }
      throw error;
    }
  }

  private async callOnce(name: string, args: Record<string, unknown>, options: CallOptions): Promise<CallToolResult> {
    const client = await this.ready(options.signal);
    let progressed = 0;
    return client.callTool(
      { name, arguments: args },
      {
        signal: options.signal,
        timeout: options.timeoutMs,
        resetTimeoutOnProgress: true,
        maxTotalTimeout: options.maxTotalMs,
        ...(options.onProgress === undefined
          ? {}
          : {
              onprogress: (progress) => {
                const of = progress.total === undefined ? "" : `/${progress.total}`;
                options.onProgress!(
                  `${progressed++ === 0 ? "" : "\n"}[${progress.progress}${of}]${progress.message === undefined ? "" : ` ${progress.message}`}`,
                );
              },
            }),
      },
    ) as Promise<CallToolResult>;
  }

  async listResources(signal: AbortSignal): Promise<{
    readonly resources: readonly Resource[];
    readonly templates: readonly { uriTemplate: string; name: string; description?: string | undefined }[];
  }> {
    const client = await this.ready(signal);
    const timeout = this.options.startupTimeoutMs;
    const [resources, templates] = await Promise.all([
      client.listResources(undefined, { signal, timeout }).then((result) => result.resources),
      client.listResourceTemplates(undefined, { signal, timeout }).then(
        (result) => result.resourceTemplates,
        () => [],
      ),
    ]);
    return { resources, templates };
  }

  async readResource(uri: string, options: { readonly signal: AbortSignal; readonly timeoutMs: number }): Promise<ReadResourceResult> {
    const client = await this.ready(options.signal);
    return client.readResource({ uri }, { signal: options.signal, timeout: options.timeoutMs });
  }
}

const identity = (version: Implementation): ServerIdentity => ({
  name: version.name,
  version: version.version,
  ...(version.title === undefined ? {} : { title: version.title }),
});

const withoutKey = <T extends object>(value: T, key: keyof T): T => {
  if (!(key in value)) return value;
  const { [key]: _, ...rest } = value;
  return rest as T;
};

/** `promise`, or a rejection when `signal` aborts first. */
const abortable = <A>(promise: Promise<A>, signal: AbortSignal): Promise<A> =>
  new Promise<A>((resolve, reject) => {
    if (signal.aborted) return reject(new Error("Cancelled"));
    const abort = () => reject(new Error("Cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
