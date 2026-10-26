import { createHash } from "node:crypto";
import { McpError, SERVER_NAME } from "@lemma/mcp";
import type { McpAuthStatus, McpServer, McpServerChange, McpServerConfig, McpServerState, McpServerStatus, McpState, McpToolInfo } from "@lemma/mcp";
import { outputBudget, ToolResult } from "@lemma/tools";
import type { Tool, ToolNamespace } from "@lemma/tools";
import { boundOutput } from "@lemma/tools/files";
import { bearer, callbackParams, finishSignIn, needsSignIn, newState, SignInStore, startSignIn, unionScopes } from "./auth.ts";
import type { Challenge, Flow, SignInTarget } from "./auth.ts";
import { listenForCallback } from "./callback.ts";
import type { Arrival, Callback } from "./callback.ts";
import {
  connectionKey,
  decodeServer,
  definitions,
  expandConfig,
  exposureOf,
  MissingVariable,
  readServersFile,
  redact,
  ruleOf,
  secretsOf,
  writeChange,
  writeEntry,
} from "./config.ts";
import type { Definition, ServersFile } from "./config.ts";
import { Connection, sendsOwnToken } from "./connection.ts";
import type { McpTool } from "./connection.ts";
import { isImageAddress } from "./form.ts";
import { inputOf, namespaceOf, outputOf, structuredOf, toContent, toolNames } from "./tools.ts";

/** A server's icon: its entry's, when it can be one (for every theme), else the ones it declares. */
const iconsOf = (own: string | undefined, declared: Connection["icons"] | undefined): { readonly icon?: string; readonly iconDark?: string } =>
  own !== undefined && isImageAddress(own) ? { icon: own } : (declared ?? {});

/** What the manager needs of the kernel: adding a tool (the returned function removes it), and telling of a change. */
export interface Kernel {
  readonly addTool: (tool: Tool) => Promise<() => Promise<void>>;
  /** Adds the namespace of a server's tools; the returned function removes it. */
  readonly addNamespace: (namespace: ToolNamespace) => Promise<() => Promise<void>>;
  readonly changed: (state: McpState) => void;
  readonly warn: (message: string) => void;
}

export interface Options {
  /** The user's `mcp.json`. */
  readonly file: string;
  /** Where the sign-ins Lemma holds are kept, `<home>/mcp-auth.json`. */
  readonly authFile: string;
  /** Sent to servers as the client's version. */
  readonly version: string;
  /** Where `${VAR}` is read from. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** How long a remote server that could not be reached waits before each try to connect again, the last repeating. */
  readonly retryDelaysMs?: readonly number[];
  /** How long a sign-in waits on the person's browser. */
  readonly signInTimeoutMs?: number;
}

const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000, 120_000, 300_000];
/** How long a connection stays up before the tries to connect again start over from the first delay. */
const HELD_MS = 60_000;
const SIGN_IN_TIMEOUT_MS = 10 * 60_000;

/** A remote server Lemma signs in to, when it asks: one that does not send an `Authorization` header of its own. */
const signsIn = (config: McpServerConfig): boolean => config.url !== undefined && !sendsOwnToken(config);

/** What a tool call to a server that needs signing in fails with, for the model to pass on. */
const signInNeeded = (server: string) =>
  `MCP server "${server}" needs the person to sign in before its tools work: they can from Settings › Integrations, or with /mcp login ${server}.`;

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** A sign-in stopped by the person, or replaced by another: nothing to report. */
const STOPPED = "The sign-in was stopped";

/**
 * The code the browser brought back, checked: the authorization server's refusal, an address from another sign-in
 * (its `state` not this one's), and one without a code fail with what to do. Only a pasted code may come without a
 * `state` (an authorization server's page showing one to copy): the person gives it, where the browser's own way
 * back must prove it is this sign-in's.
 */
function codeOf(params: URLSearchParams, flow: Flow, pasted: boolean): string {
  const error = params.get("error");
  const state = params.get("state");
  if ((state !== null || !pasted) && state !== flow.state)
    throw new Error("That address is from another sign-in: paste the one this sign-in's browser landed on.");
  if (error !== null) throw new Error(`The authorization server refused: ${params.get("error_description") ?? error}.`);
  const code = params.get("code");
  if (code === null || code === "") throw new Error("That address has no code: paste the whole address the browser landed on.");
  return code;
}

/** A browser sign-in under way: its page (once the authorization server is found), the listener, and a paste. */
interface SignInRun {
  flow: Flow | undefined;
  url: string | undefined;
  readonly callback: Callback;
  readonly stop: AbortController;
  readonly paste: (params: URLSearchParams) => void;
  readonly pasted: Promise<URLSearchParams>;
  /** How it ended: `undefined` once signed in, else why not. */
  ended: Promise<string | undefined> | undefined;
}

interface Registered {
  /** Changes when anything the model sees of the tool does. */
  readonly key: string;
  readonly remove: () => Promise<void>;
}

/** A server the manager runs. Its tools are re-added whenever it lists them, or its exposures change. */
interface Entry {
  definition: Definition;
  connectionKey: string;
  connection: Connection | undefined;
  /** Why it cannot connect, apart from the definition's own error (a variable not set). */
  error: string | undefined;
  /** What it listed when it last connected. */
  listed: readonly McpTool[];
  readonly registered: Map<string, Registered>;
  /** Its tools' namespace, while it has tools. */
  namespace: Registered | undefined;
  /** Serializes adding and removing its tools. */
  syncing: Promise<void>;
  /** A remote server Lemma signs in to, as its connection was made: the sign-in it holds is the one for this address. */
  target: SignInTarget | undefined;
  signIn: SignInRun | undefined;
  /** Why the last sign-in failed. */
  signInError: string | undefined;
  /** What the server said when it last refused, for the next sign-in. */
  challenge: Challenge | undefined;
  /** The try to connect again that is waiting, and how many tries have failed since a connection last held. */
  retry: { readonly timer: ReturnType<typeof setTimeout>; readonly at: number } | undefined;
  attempts: number;
  /** When its connection last connected, while it is up. */
  connectedAt: number | undefined;
}

const enabled = (definition: Definition) => definition.error === undefined && definition.config.enabled !== false;

/**
 * Runs the MCP servers: the user's `mcp.json` merged with the servers plugins add, one connection each, and each
 * server's tools in the tools registry. Changes are applied one at a time, in order.
 */
export class Servers {
  private readonly entries = new Map<string, Entry>();
  private file: ServersFile;
  private plugins: readonly { readonly item: McpServer; readonly pluginId: string }[] = [];
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly kernel: Kernel;
  private readonly options: Options;
  private readonly store: SignInStore;

  constructor(kernel: Kernel, options: Options) {
    this.kernel = kernel;
    this.options = options;
    this.file = { path: options.file, entries: new Map() };
    this.store = new SignInStore(options.authFile);
  }

  state(): McpState {
    return {
      file: this.options.file,
      ...(this.file.error === undefined ? {} : { fileError: this.file.error }),
      servers: [...this.entries.values()].map((entry) => this.status(entry)),
    };
  }

  /** Reads the file and the sign-ins, and starts the file's servers and the plugins'. */
  async start(plugins: readonly { readonly item: McpServer; readonly pluginId: string }[]): Promise<void> {
    this.plugins = plugins;
    await this.store.load();
    return this.reload();
  }

  /** Reads the file again and applies it. A file that cannot be read keeps the servers it had. */
  reload(): Promise<void> {
    return this.serially(async () => {
      const file = await readServersFile(this.options.file);
      this.file = file.error === undefined ? file : { ...this.file, error: file.error };
      await this.apply();
    });
  }

  /** The servers plugins add changed. */
  setPlugins(plugins: readonly { readonly item: McpServer; readonly pluginId: string }[]): Promise<void> {
    return this.serially(async () => {
      this.plugins = plugins;
      await this.apply();
    });
  }

  reconnect(name: string): Promise<void> {
    return this.serially(async () => {
      const entry = this.find(name);
      if (!enabled(entry.definition)) return;
      await this.disconnect(entry);
      this.connect(entry);
      this.publish();
    });
  }

  configure(name: string, change: McpServerChange): Promise<void> {
    return this.serially(async () => {
      const { definition } = this.find(name);
      if (this.file.error !== undefined) throw new McpError({ reason: "Failed", message: `Fix ${this.options.file} first: ${this.file.error}` });
      try {
        // A plugin's server has the plugin's values without the entry: one differing from them is written.
        await writeChange(this.options.file, name, change, definition.source.kind === "plugin" ? definition.source.config : {});
      } catch (cause) {
        throw new McpError({ reason: "Failed", message: cause instanceof Error ? cause.message : String(cause), cause });
      }
      this.file = await readServersFile(this.options.file);
      await this.apply();
    });
  }

  /** Writes the server's whole entry (or removes it, with the sign-in Lemma holds for it), and applies the file. */
  put(name: string, entry: McpServerConfig | null): Promise<void> {
    return this.serially(async () => {
      if (entry !== null) {
        const decoded = decodeServer(name, entry);
        if ("error" in decoded) throw new McpError({ reason: "Invalid", message: decoded.error });
      } else if (!SERVER_NAME.test(name)) throw new McpError({ reason: "Invalid", message: `"${name}" is not a server name` });
      if (this.file.error !== undefined) throw new McpError({ reason: "Failed", message: `Fix ${this.options.file} first: ${this.file.error}` });
      try {
        await writeEntry(this.options.file, name, entry);
      } catch (cause) {
        throw new McpError({ reason: "Failed", message: cause instanceof Error ? cause.message : String(cause), cause });
      }
      this.file = await readServersFile(this.options.file);
      await this.apply();
      if (entry === null)
        await this.store.set(name, undefined).catch((cause: unknown) => this.kernel.warn(`${name}'s sign-in was not removed: ${messageOf(cause)}`));
    });
  }

  /**
   * Starts signing in to a remote server that asks, replacing a sign-in under way: answers with the page to approve
   * on, once the server's authorization server is found (and Lemma registered with it). The sign-in then waits on the
   * browser coming back, or a paste (`finishSignIn`), and connects the server again once it is stored.
   */
  async signIn(name: string): Promise<{ readonly url: string }> {
    const entry = this.find(name);
    const target = this.signInTarget(entry);
    // The one it replaces lets go of its port first, which this one may listen on.
    await this.stopSignIn(entry);
    entry.signInError = undefined;
    const state = newState();
    const callback = await this.listen(target, state);
    let paste!: (params: URLSearchParams) => void;
    const pasted = new Promise<URLSearchParams>((resolve) => (paste = resolve));
    const flow: Flow = { redirectUrl: callback.redirectUrl, state };
    const run: SignInRun = { flow: undefined, url: undefined, callback, stop: new AbortController(), paste, pasted, ended: undefined };
    entry.signIn = run;
    this.publish();
    let url: string;
    try {
      url = await startSignIn(this.store, target, flow, entry.challenge);
    } catch (cause) {
      await callback.close();
      const message = this.redact(entry, `Could not start signing in: ${messageOf(cause)}`);
      if (entry.signIn === run) {
        entry.signIn = undefined;
        entry.signInError = message;
        this.publish();
      }
      throw new McpError({ reason: "Failed", message, cause });
    }
    if (entry.signIn !== run) {
      await callback.close();
      throw new McpError({ reason: "Failed", message: STOPPED });
    }
    run.flow = flow;
    run.url = url;
    run.ended = this.awaitSignIn(entry, run, target);
    this.publish();
    return { url };
  }

  /** Finishes the sign-in under way with the address its browser landed on, answering once it is stored. */
  async finishSignIn(name: string, address: string): Promise<void> {
    const entry = this.find(name);
    const run = entry.signIn;
    if (run?.flow === undefined || run.ended === undefined)
      throw new McpError({ reason: "Invalid", message: `No sign-in to ${name} is waiting on the browser: start one first` });
    const params = callbackParams(address);
    try {
      codeOf(params, run.flow, true);
    } catch (cause) {
      // A wrong paste leaves the sign-in waiting, for the right one.
      throw new McpError({ reason: "Invalid", message: messageOf(cause) });
    }
    run.paste(params);
    const failure = await run.ended;
    if (failure !== undefined) throw new McpError({ reason: "Failed", message: failure });
  }

  /** Stops the sign-in under way, if any. */
  async cancelSignIn(name: string): Promise<void> {
    const entry = this.find(name);
    if (entry.signIn === undefined) return;
    const stopped = this.stopSignIn(entry);
    this.publish();
    await stopped;
  }

  /** Forgets the sign-in Lemma holds for the server, stopping one under way, and connects again. */
  async signOut(name: string): Promise<void> {
    const entry = this.find(name);
    this.signInTarget(entry);
    await this.stopSignIn(entry);
    entry.signInError = undefined;
    try {
      await this.store.set(name, undefined);
    } catch (cause) {
      throw new McpError({ reason: "Failed", message: messageOf(cause), cause });
    }
    await this.reconnect(name);
  }

  /** The server to sign in to, its variables read; fails `Invalid` for one Lemma does not sign in to. */
  private signInTarget(entry: Entry): SignInTarget {
    const { name, config, error } = entry.definition;
    if (error !== undefined) throw new McpError({ reason: "Invalid", message: error });
    if (config.url === undefined) throw new McpError({ reason: "Invalid", message: `${name} is a local server: Lemma signs in only to remote ones` });
    if (!signsIn(config))
      throw new McpError({ reason: "Invalid", message: `${name} sends its own Authorization header: remove it from "headers" to sign in instead` });
    if (config.enabled === false) throw new McpError({ reason: "Invalid", message: `${name} is off: turn it on to sign in` });
    try {
      const expanded = expandConfig(config, this.options.env);
      return { name, url: expanded.url!, oauth: expanded.oauth };
    } catch (cause) {
      throw new McpError({ reason: "Invalid", message: messageOf(cause) });
    }
  }

  /**
   * Listens for the browser coming back: on the port the server's entry fixes, else the one Lemma registered with its
   * authorization server, so the registration still holds, else (that one taken) any, registering again.
   */
  private async listen(target: SignInTarget, state: string): Promise<Callback> {
    const fixed = target.oauth?.callbackPort;
    const registered = this.store.get(target.name, target.url)?.redirectUrl;
    const port = fixed ?? (registered === undefined ? 0 : Number(new URL(registered).port) || 0);
    try {
      return await listenForCallback(port, target.name, state);
    } catch (cause) {
      if (fixed === undefined && port !== 0) return listenForCallback(0, target.name, state).catch((again: unknown) => this.cannotListen(port, again));
      return this.cannotListen(port, cause);
    }
  }

  private cannotListen(port: number, cause: unknown): never {
    throw new McpError({ reason: "Failed", message: `Could not listen on port ${port} for the browser to come back to Lemma: ${messageOf(cause)}`, cause });
  }

  /**
   * Waits for the browser to come back with a code (or a paste of where it landed), exchanges it for tokens, and
   * connects the server again. Says how it ended: `undefined` once signed in, else why not. One stopped or replaced
   * meanwhile leaves the server to whoever stopped it.
   */
  private async awaitSignIn(entry: Entry, run: SignInRun, target: SignInTarget): Promise<string | undefined> {
    let arrival: Arrival | undefined;
    let failure: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const params = await new Promise<URLSearchParams>((resolve, reject) => {
        void run.callback.arrived.then((arrived) => {
          arrival = arrived;
          resolve(arrived.params);
        });
        void run.pasted.then(resolve);
        run.stop.signal.addEventListener("abort", () => reject(new Error(STOPPED)), { once: true });
        timer = setTimeout(
          () => reject(new Error("The sign-in timed out waiting on the browser: start it again.")),
          this.options.signInTimeoutMs ?? SIGN_IN_TIMEOUT_MS,
        );
      });
      await finishSignIn(this.store, target, run.flow!, codeOf(params, run.flow!, arrival === undefined), params.get("iss") ?? undefined);
    } catch (cause) {
      failure = this.redact(entry, messageOf(cause));
    } finally {
      clearTimeout(timer);
    }
    arrival?.answer(failure);
    await run.callback.close();
    if (entry.signIn !== run) return failure;
    entry.signIn = undefined;
    entry.signInError = failure === STOPPED ? undefined : failure;
    if (failure === undefined) await this.reconnect(entry.definition.name).catch(() => {});
    else this.publish();
    return failure;
  }

  /** Stops the sign-in under way, which then says nothing of how it ended; settles once its port is free. */
  private stopSignIn(entry: Entry): Promise<void> {
    const run = entry.signIn;
    if (run === undefined) return Promise.resolve();
    entry.signIn = undefined;
    run.stop.abort();
    return run.callback.close();
  }

  async close(): Promise<void> {
    this.closed = true;
    const stopped = [...this.entries.values()].map((entry) => {
      this.cancelRetry(entry);
      return this.stopSignIn(entry);
    });
    await Promise.all(stopped);
    await this.queue.catch(() => {});
    await Promise.all([...this.entries.values()].map((entry) => entry.connection?.close()));
  }

  /** What the server said when it refused, kept for the next sign-in: a scope asked for joins those asked before. */
  private heard(entry: Entry, challenge: Challenge): void {
    const scope = unionScopes(entry.challenge?.scope, challenge.scope);
    entry.challenge = { ...entry.challenge, ...challenge, ...(scope === undefined ? {} : { scope }) };
  }

  /** The values `${VAR}` references in the server's entry read, replaced in `text` by their references. */
  private redact(entry: Entry, text: string): string {
    return redact(text, secretsOf(entry.definition.config, this.options.env));
  }

  /**
   * Tries to connect again later, for a remote server that could not be reached or dropped its connection: sooner
   * after the first failures, then every few minutes, until it connects or is reconnected, changed, or turned off.
   */
  private retryLater(entry: Entry, connection: Connection): void {
    if (entry.retry !== undefined || this.closed || entry.connection !== connection || connection.state !== "failed" || !connection.retryable) return;
    const delays = this.options.retryDelaysMs ?? RETRY_DELAYS_MS;
    const delay = delays[Math.min(entry.attempts, delays.length - 1)]!;
    entry.attempts++;
    const timer = setTimeout(() => {
      if (entry.retry?.timer !== timer) return;
      entry.retry = undefined;
      if (entry.connection === connection && !this.closed) connection.ready().catch(() => {});
    }, delay);
    timer.unref?.();
    entry.retry = { timer, at: Date.now() + delay };
  }

  private cancelRetry(entry: Entry): void {
    if (entry.retry !== undefined) clearTimeout(entry.retry.timer);
    entry.retry = undefined;
    entry.attempts = 0;
  }

  /** Lines for the model: each server whose tools only scripts call, and what it offers. */
  codemodeServers(): readonly { readonly name: string; readonly description?: string }[] {
    return [...this.entries.values()]
      .filter(({ definition }) => enabled(definition) && this.reachesCodemode(definition))
      .map(({ definition }) => ({
        name: definition.name,
        ...(definition.config.description === undefined ? {} : { description: definition.config.description }),
      }));
  }

  /** From its config alone, so the model's list of servers does not change as they connect. */
  private reachesCodemode(definition: Definition): boolean {
    const { exposure = "codemode", toolExposure = {} } = definition.config;
    return exposure === "codemode" || Object.values(toolExposure).includes("codemode");
  }

  private serially(work: () => Promise<void>): Promise<void> {
    const run = this.queue.then(() => (this.closed ? undefined : work()));
    this.queue = run.catch(() => {});
    return run;
  }

  private find(name: string): Entry {
    const entry = this.entries.get(name);
    if (entry === undefined) throw new McpError({ reason: "NotFound", message: `No MCP server is named "${name}"` });
    return entry;
  }

  /** Brings the running servers in line with the file and the plugins' servers. */
  private async apply(): Promise<void> {
    const next = definitions(this.file, this.plugins);
    const names = new Set(next.map((definition) => definition.name));
    for (const [name, entry] of this.entries) {
      if (names.has(name)) continue;
      this.entries.delete(name);
      await this.stopSignIn(entry);
      await this.disconnect(entry);
    }
    for (const definition of next) {
      const key = connectionKey(definition.config);
      let entry = this.entries.get(definition.name);
      if (entry === undefined) {
        entry = {
          definition,
          connectionKey: key,
          connection: undefined,
          error: undefined,
          listed: [],
          registered: new Map(),
          namespace: undefined,
          syncing: Promise.resolve(),
          target: undefined,
          signIn: undefined,
          signInError: undefined,
          challenge: undefined,
          retry: undefined,
          attempts: 0,
          connectedAt: undefined,
        };
        this.entries.set(definition.name, entry);
      }
      const reconnect = entry.connection === undefined || entry.connectionKey !== key;
      // A sign-in for the server as it was reaches it no more, nor does what was said of it.
      if (entry.connectionKey !== key || !enabled(definition)) {
        await this.stopSignIn(entry);
        entry.signInError = undefined;
        entry.challenge = undefined;
      }
      entry.definition = definition;
      entry.connectionKey = key;
      if (!enabled(definition)) await this.disconnect(entry);
      else if (reconnect) {
        await this.disconnect(entry);
        this.connect(entry);
      } else await this.sync(entry);
    }
    // Map order is insertion order: keep the list sorted by name, as `definitions` returns it.
    const sorted = next.map((definition) => [definition.name, this.entries.get(definition.name)!] as const);
    this.entries.clear();
    for (const [name, entry] of sorted) this.entries.set(name, entry);
    this.publish();
  }

  /** Starts connecting, in the background: its tools are added once it lists them. */
  private connect(entry: Entry): void {
    let config;
    try {
      config = expandConfig(entry.definition.config, this.options.env);
      entry.error = undefined;
    } catch (cause) {
      entry.error = cause instanceof MissingVariable ? cause.message : String(cause);
      return;
    }
    const name = entry.definition.name;
    entry.target = signsIn(config) ? { name, url: config.url!, oauth: config.oauth } : undefined;
    const connection: Connection = new Connection(
      config,
      {
        changed: () => {
          if (entry.connection !== connection) return;
          if (connection.state === "connected") entry.connectedAt = Date.now();
          else if (connection.state === "failed") {
            // One that held a while starts over; one that drops as soon as it connects keeps waiting longer.
            if (entry.connectedAt !== undefined && Date.now() - entry.connectedAt >= HELD_MS) entry.attempts = 0;
            entry.connectedAt = undefined;
            this.retryLater(entry, connection);
          }
          this.publish();
        },
        challenged: (challenge) => this.heard(entry, challenge),
        tools: (tools) => {
          if (entry.connection !== connection) return;
          entry.listed = tools;
          void this.sync(entry).then(
            () => this.publish(),
            (cause: unknown) => this.kernel.warn(`${entry.definition.name}'s tools: ${cause instanceof Error ? cause.message : String(cause)}`),
          );
        },
      },
      this.options.version,
      entry.target === undefined ? undefined : bearer(this.store, entry.target, (challenge) => this.heard(entry, challenge)),
    );
    entry.connection = connection;
    // Failures are the connection's state; the page shows them.
    connection.ready().catch(() => {});
  }

  private async disconnect(entry: Entry): Promise<void> {
    const connection = entry.connection;
    entry.connection = undefined;
    entry.connectedAt = undefined;
    this.cancelRetry(entry);
    entry.listed = [];
    entry.error = undefined;
    await this.sync(entry);
    await connection?.close();
  }

  /** Adds the server's tools as it last listed them, at their exposures now, and removes those it no longer has. */
  private sync(entry: Entry): Promise<void> {
    const run = entry.syncing.then(async () => {
      const wanted = new Map<string, { readonly key: string; readonly tool: Tool }>();
      if (entry.connection !== undefined) {
        const names = toolNames(
          entry.definition.name,
          entry.listed.map((tool) => tool.name),
        );
        for (const listed of entry.listed) {
          const exposure = exposureOf(entry.definition.config, listed.name);
          if (exposure === "hidden") continue;
          const tool = this.toolOf(entry, listed, names.get(listed.name)!, exposure === "codemode");
          const key = createHash("sha256")
            .update(JSON.stringify([tool.name, tool.description, listed.inputSchema, listed.outputSchema, tool.nested]))
            .digest("hex");
          wanted.set(tool.name, { key, tool });
        }
      }
      for (const [name, registered] of entry.registered) {
        if (wanted.get(name)?.key === registered.key) continue;
        entry.registered.delete(name);
        await registered.remove();
      }
      await this.syncNamespace(entry, wanted.size > 0);
      for (const [name, { key, tool }] of wanted) {
        if (entry.registered.has(name)) continue;
        try {
          entry.registered.set(name, { key, remove: await this.kernel.addTool(tool) });
        } catch (cause) {
          // Another plugin holds the name: the rest of the server's tools are added all the same.
          this.kernel.warn(`${entry.definition.name}'s tool ${name} was not added: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }
    });
    entry.syncing = run.catch(() => {});
    return run;
  }

  /**
   * Keeps the namespace of the server's tools while it has some: what it is for (its configured description, else the
   * first line of what it tells clients), and what it tells clients as the instructions scripts read.
   */
  private async syncNamespace(entry: Entry, wanted: boolean): Promise<void> {
    const server = entry.definition.name;
    const instructions = entry.connection?.instructions?.trim() || undefined;
    const namespace: ToolNamespace = {
      name: namespaceOf(server),
      description: entry.definition.config.description ?? instructions?.split("\n")[0] ?? `The tools of the MCP server "${server}"`,
      ...(instructions === undefined ? {} : { instructions }),
      aliases: [...new Set([server, `mcp__${server}`])].filter((alias) => alias !== namespaceOf(server)),
    };
    const key = JSON.stringify(namespace);
    if (wanted && entry.namespace?.key === key) return;
    const previous = entry.namespace;
    entry.namespace = undefined;
    await previous?.remove();
    if (!wanted) return;
    try {
      entry.namespace = { key, remove: await this.kernel.addNamespace(namespace) };
    } catch (cause) {
      this.kernel.warn(`${server}'s namespace was not added: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  private toolOf(entry: Entry, listed: McpTool, name: string, nested: boolean): Tool {
    const server = entry.definition.name;
    const title = listed.title ?? listed.annotations?.title;
    const text = [title, listed.description].filter((part) => part !== undefined && part !== "").join(": ");
    return {
      name,
      description: `${text || listed.name} (MCP server "${server}")`,
      input: inputOf(listed.inputSchema),
      output: outputOf(listed.outputSchema),
      namespace: namespaceOf(server),
      ...(nested ? { nested: true as const } : {}),
      execute: async (input, context) => {
        const connection = entry.connection;
        if (connection === undefined) throw new Error(`MCP server "${server}" is off`);
        let result;
        try {
          result = await connection.call(listed.name, input, context.signal, context.update);
        } catch (cause) {
          if (needsSignIn(cause)) throw new Error(signInNeeded(server), { cause });
          // What reaches the model shows a `${VAR}`'s reference, as the page does.
          throw new Error(this.redact(entry, messageOf(cause)), { cause });
        }
        const { content, fullOutputPath } = await boundOutput(toContent(result), { budget: outputBudget(context.maxResultChars), name: "mcp" });
        return new ToolResult({
          content: content.length === 0 ? [{ type: "text", text: "(no output)" }] : [...content],
          ...(result.isError === true ? { isError: true } : {}),
          details: {
            server,
            tool: listed.name,
            ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
            ...(fullOutputPath === undefined ? {} : { fullOutputPath }),
          },
          structured: structuredOf(result),
        });
      },
    };
  }

  /** How signing in stands, for a remote server Lemma signs in to that asked, or for which it holds a sign-in. */
  private authOf(entry: Entry): McpAuthStatus | undefined {
    if (!signsIn(entry.definition.config) || entry.definition.error !== undefined) return undefined;
    const error = entry.signInError === undefined ? {} : { error: entry.signInError };
    if (entry.signIn !== undefined) return { state: "signing-in", ...(entry.signIn.url === undefined ? {} : { url: entry.signIn.url }), ...error };
    if (entry.connection?.state === "needs-sign-in") return { state: "signed-out", ...error };
    if (entry.target !== undefined && this.store.get(entry.target.name, entry.target.url)?.tokens !== undefined) return { state: "signed-in", ...error };
    // A server that connects without a sign-in asks for none, whatever a sign-in tried on it said.
    if (entry.connection?.state === "connected") return undefined;
    return entry.signInError === undefined ? undefined : { state: "signed-out", ...error };
  }

  private status(entry: Entry): McpServerStatus {
    const { definition, connection } = entry;
    const { config } = definition;
    const on = enabled(definition);
    const failure = definition.error ?? entry.error ?? (connection?.state === "failed" ? connection.error : undefined);
    const error = failure === undefined ? undefined : this.redact(entry, failure);
    const state: McpServerState = error !== undefined ? "failed" : !on || connection === undefined || connection.state === "closed" ? "off" : connection.state;
    const auth = on ? this.authOf(entry) : undefined;
    const names = toolNames(
      definition.name,
      entry.listed.map((tool) => tool.name),
    );
    const own = definition.file?.toolExposure;
    const tools = entry.listed.map((tool): McpToolInfo => {
      const exposure = exposureOf(config, tool.name);
      const rule = ruleOf(config, tool.name);
      const title = tool.title ?? tool.annotations?.title;
      return {
        name: tool.name,
        exposure,
        ...(own !== undefined && Object.hasOwn(own, tool.name) ? { own: own[tool.name]! } : {}),
        ...(rule === undefined ? {} : { rule }),
        ...(exposure === "hidden" ? {} : { tool: names.get(tool.name)! }),
        ...(title === undefined ? {} : { title }),
        ...(tool.description === undefined ? {} : { description: tool.description }),
      };
    });
    return {
      name: definition.name,
      state,
      source: definition.source.kind === "file" ? definition.source.path : definition.source.id,
      sourceKind: definition.source.kind,
      transport: config.url === undefined ? "stdio" : "http",
      target: config.url ?? [config.command ?? "", ...(config.args ?? [])].join(" ").trim(),
      enabled: on,
      exposure: config.exposure ?? "codemode",
      ...(config.description === undefined ? {} : { description: config.description }),
      ...(error === undefined ? {} : { error }),
      ...(state === "failed" && entry.retry !== undefined ? { retryIn: Math.max(0, entry.retry.at - Date.now()) } : {}),
      ...(auth === undefined ? {} : { auth }),
      ...(connection === undefined || connection.stderr === "" ? {} : { stderr: this.redact(entry, connection.stderr) }),
      ...(connection?.server === undefined ? {} : { server: connection.server }),
      ...(connection?.protocolVersion === undefined ? {} : { protocolVersion: connection.protocolVersion }),
      ...iconsOf(config.icon, connection?.icons),
      ...(connection?.instructions === undefined ? {} : { instructions: connection.instructions }),
      tools,
      ...(definition.source.kind === "file" && definition.file !== undefined ? { entry: definition.file } : {}),
    };
  }

  private publish(): void {
    if (!this.closed) this.kernel.changed(this.state());
  }
}
