import { createHash } from "node:crypto";
import { McpError, SERVER_NAME } from "@lemma/mcp";
import type { McpLaunch, McpServer, McpServerChange, McpServerConfig, McpServerState, McpServerStatus, McpState, McpToolInfo } from "@lemma/mcp";
import { ToolResult } from "@lemma/tools";
import type { Tool } from "@lemma/tools";
import { boundOutput } from "@lemma/tools/files";
import {
  connectionKey,
  decodeServer,
  definitions,
  expandConfig,
  exposureOf,
  MissingVariable,
  readServersFile,
  ruleOf,
  writeChange,
  writeEntry,
} from "./config.ts";
import type { Definition, ServersFile } from "./config.ts";
import { Connection } from "./connection.ts";
import type { McpTool } from "./connection.ts";
import { isImageAddress } from "./form.ts";
import { inputOf, toContent, toolNames } from "./tools.ts";

/** A server's icon: its entry's, when it can be one, else the one it declares. */
const iconOf = (own: string | undefined, declared: string | undefined): string | undefined => (own !== undefined && isImageAddress(own) ? own : declared);

/** What the manager needs of the kernel: adding a tool (the returned function removes it), and telling of a change. */
export interface Kernel {
  readonly addTool: (tool: Tool) => Promise<() => Promise<void>>;
  readonly changed: (state: McpState) => void;
  readonly warn: (message: string) => void;
}

export interface Options {
  /** The user's `mcp.json`. */
  readonly file: string;
  /** Text characters a result keeps before the rest goes to a temp file. */
  readonly maxOutputChars: number;
  /** Sent to servers as the client's version. */
  readonly version: string;
  /** Where `${VAR}` is read from. */
  readonly env: Readonly<Record<string, string | undefined>>;
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
  /** Serializes adding and removing its tools. */
  syncing: Promise<void>;
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

  constructor(kernel: Kernel, options: Options) {
    this.kernel = kernel;
    this.options = options;
    this.file = { path: options.file, entries: new Map() };
  }

  state(): McpState {
    return {
      file: this.options.file,
      ...(this.file.error === undefined ? {} : { fileError: this.file.error }),
      servers: [...this.entries.values()].map((entry) => this.status(entry)),
    };
  }

  /** Reads the file, and starts its servers and the plugins'. */
  start(plugins: readonly { readonly item: McpServer; readonly pluginId: string }[]): Promise<void> {
    this.plugins = plugins;
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

  /** Writes the server's whole entry (or removes it), and applies the file. */
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
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.queue.catch(() => {});
    await Promise.all([...this.entries.values()].map((entry) => entry.connection?.close()));
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
      await this.disconnect(entry);
    }
    for (const definition of next) {
      const key = connectionKey(definition.config);
      let entry = this.entries.get(definition.name);
      if (entry === undefined) {
        entry = { definition, connectionKey: key, connection: undefined, error: undefined, listed: [], registered: new Map(), syncing: Promise.resolve() };
        this.entries.set(definition.name, entry);
      }
      const reconnect = entry.connection === undefined || entry.connectionKey !== key;
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
    const connection: Connection = new Connection(
      config,
      {
        changed: () => {
          if (entry.connection === connection) this.publish();
        },
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
    );
    entry.connection = connection;
    // Failures are the connection's state; the page shows them.
    connection.ready().catch(() => {});
  }

  private async disconnect(entry: Entry): Promise<void> {
    const connection = entry.connection;
    entry.connection = undefined;
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
            .update(JSON.stringify([tool.name, tool.description, listed.inputSchema, tool.nested]))
            .digest("hex");
          wanted.set(tool.name, { key, tool });
        }
      }
      for (const [name, registered] of entry.registered) {
        if (wanted.get(name)?.key === registered.key) continue;
        entry.registered.delete(name);
        await registered.remove();
      }
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

  private toolOf(entry: Entry, listed: McpTool, name: string, nested: boolean): Tool {
    const server = entry.definition.name;
    const title = listed.title ?? listed.annotations?.title;
    const text = [title, listed.description].filter((part) => part !== undefined && part !== "").join(": ");
    return {
      name,
      description: `${text || listed.name} (MCP server "${server}")`,
      input: inputOf(listed.inputSchema),
      ...(nested ? { nested: true as const } : {}),
      execute: async (input, context) => {
        const connection = entry.connection;
        if (connection === undefined) throw new Error(`MCP server "${server}" is off`);
        const result = await connection.call(listed.name, input, context.signal, context.update);
        const { content, fullOutputPath } = await boundOutput(toContent(result), {
          budget: this.options.maxOutputChars,
          maxResultChars: context.maxResultChars,
          name: "mcp",
        });
        return new ToolResult({
          content: content.length === 0 ? [{ type: "text", text: "(no output)" }] : [...content],
          ...(result.isError === true ? { isError: true } : {}),
          details: {
            server,
            tool: listed.name,
            ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
            ...(fullOutputPath === undefined ? {} : { fullOutputPath }),
          },
        });
      },
    };
  }

  private status(entry: Entry): McpServerStatus {
    const { definition, connection } = entry;
    const { config } = definition;
    const on = enabled(definition);
    const error = definition.error ?? entry.error ?? (connection?.state === "failed" ? connection.error : undefined);
    const state: McpServerState = error !== undefined ? "failed" : !on || connection === undefined || connection.state === "closed" ? "off" : connection.state;
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
      ...(connection === undefined || connection.stderr === "" ? {} : { stderr: connection.stderr }),
      ...(connection?.server === undefined ? {} : { server: connection.server }),
      ...(connection?.protocolVersion === undefined ? {} : { protocolVersion: connection.protocolVersion }),
      ...(iconOf(config.icon, connection?.icon) === undefined ? {} : { icon: iconOf(config.icon, connection?.icon)! }),
      ...(connection?.instructions === undefined ? {} : { instructions: connection.instructions }),
      tools,
      ...(definition.source.kind === "file" && definition.file !== undefined ? { entry: definition.file } : {}),
      harnesses: config.harnesses !== false,
    };
  }

  /** The enabled servers other coding agents are handed (`McpLaunches`), their variables read; one missing a variable is left out. */
  launches(): McpLaunch[] {
    return [...this.entries.values()].flatMap(({ definition }) => {
      if (!enabled(definition) || definition.config.harnesses === false) return [];
      let config;
      try {
        config = expandConfig(definition.config, this.options.env);
      } catch {
        return [];
      }
      return [
        {
          name: definition.name,
          transport: config.url === undefined ? ("stdio" as const) : ("http" as const),
          ...(config.command === undefined ? {} : { command: config.command }),
          args: config.args ?? [],
          env: config.env ?? {},
          ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
          ...(config.url === undefined ? {} : { url: config.url }),
          headers: config.headers ?? {},
        },
      ];
    });
  }

  private publish(): void {
    if (!this.closed) this.kernel.changed(this.state());
  }
}
