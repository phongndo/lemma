import { Effect, Exit, Runtime, Schema, Scope } from "effect";
import type { Context } from "effect";
import { PluginContext } from "@lemma/core";
import { auth } from "@modelcontextprotocol/client";
import type { Tool as McpTool } from "@modelcontextprotocol/client";
import { InteractionOrigin, McpChanged, McpError, Notice, ToolResult } from "@lemma/contracts";
import type {
  ConfigScope,
  Credential,
  Credentials,
  HostControl,
  Interaction,
  McpLogEntry,
  McpManager,
  McpServerInfo,
  McpServerSpec,
  McpToolInfo,
  NoticePayload,
  Tool,
  Tools,
} from "@lemma/contracts";
import type { Events } from "@lemma/core";
import type { McpConfig } from "./config.ts";
import { Connection, errorMessage } from "./connection.ts";
import type { Binding, ConnectionState } from "./connection.ts";
import { elicit } from "./elicit.ts";
import { sameServer, toolNames } from "./names.ts";
import { listenForCallback, parseCallback, portOf, randomState, redirectUrlFor, signInProvider } from "./oauth.ts";
import type { Callback, Flow, OAuthSettings, SignIn, SignInStore } from "./oauth.ts";
import { acquire, connectionKey } from "./pool.ts";
import type { Held } from "./pool.ts";
import { interpolate, launchOf, masked, transportOf, unmasked } from "./resolve.ts";
import { toContent } from "./content.ts";
import { capOutput, describe, hintsOf, mcpTool } from "./tools.ts";

type CredentialsService = Context.Tag.Service<typeof Credentials>;
type ToolsService = Context.Tag.Service<typeof Tools>;
type HostControlService = Context.Tag.Service<typeof HostControl>;
type InteractionService = Context.Tag.Service<typeof Interaction>;
type EventsService = Context.Tag.Service<typeof Events>;

/** Where a server's secrets are kept in the credential store, and its sign-in. */
export const secretsKey = (id: string): string => `mcp:${id}`;
export const signInKey = (id: string): string => `mcp-oauth:${id}`;

/** The tools that list and read servers' resources. */
export const RESOURCE_TOOLS = ["mcp_resources", "mcp_read_resource"] as const;

/** How long a sign-in may take before it is abandoned. */
const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1_000;
/** Changes closer together than this are announced once. */
const ANNOUNCE_MS = 100;

export interface Services {
  readonly config: McpConfig;
  readonly owner: Context.Tag.Service<typeof PluginContext>;
  readonly tools: ToolsService;
  readonly credentials: CredentialsService;
  readonly control: HostControlService;
  readonly interaction: InteractionService;
  readonly events: EventsService;
  /** The host's directory: where a stdio server runs unless it says otherwise. */
  readonly cwd: string;
  readonly version: string;
}

/** A tool of a server's as it is registered. */
interface Registered {
  readonly name: string;
  /** The definition it was registered from, to tell a changed tool from the same one listed again. */
  readonly definition: string;
  /** The connection its calls go to; a server connected anew registers its tools anew. */
  readonly connection: Connection;
  readonly scope: Scope.CloseableScope;
}

/** A configured server, as this plugin instance runs it. */
interface Server {
  readonly spec: McpServerSpec;
  /** Stored secret values by name. */
  secrets: Record<string, string>;
  signIn: SignIn | undefined;
  /** Why it cannot connect without a change: an unset `${NAME}`, a malformed spec, a clashing id. */
  problem?: string;
  missing: readonly string[];
  held: Held | undefined;
  release: (() => void)[];
  readonly registered: Map<string, Registered>;
  /** Tool syncs run one after another. */
  sync: Promise<void>;
  readonly since: number;
}

const decodeSecrets = (credential: Credential | undefined): Record<string, string> =>
  credential?.type === "api_key" && credential.env !== undefined ? { ...credential.env } : {};

const decodeSignIn = (credential: Credential | undefined): SignIn | undefined => {
  const stored = credential?.type === "oauth" ? (credential as Record<string, unknown>)["mcp"] : undefined;
  return typeof stored === "object" && stored !== null && typeof (stored as SignIn).url === "string" ? (stored as SignIn) : undefined;
};

/** A sign-in in the store's shape: an OAuth credential, with the MCP client's details beside its tokens. */
const encodeSignIn = (signIn: SignIn): Credential => {
  const expiresIn = signIn.tokens?.expires_in;
  return {
    type: "oauth",
    access: signIn.tokens?.access_token ?? "",
    refresh: signIn.tokens?.refresh_token ?? "",
    expires: typeof expiresIn === "number" ? Date.now() + expiresIn * 1_000 : 0,
    mcp: signIn,
  } as Credential;
};

const hasAuthorizationHeader = (spec: McpServerSpec): boolean => Object.keys(spec.headers ?? {}).some((name) => name.toLowerCase() === "authorization");

/**
 * The servers one plugin instance runs: it holds a pooled connection for each
 * enabled server, keeps each server's tools registered while it is connected,
 * and is the `McpManager` clients call.
 */
export const makeServers = (services: Services) =>
  Effect.gen(function* () {
    const { config, owner, tools, credentials, control, interaction, events } = services;
    const runtime = yield* Effect.runtime<PluginContext>();
    const run = <A, E>(effect: Effect.Effect<A, E, PluginContext>) => Runtime.runPromise(runtime)(effect);
    const servers = new Map<string, Server>();
    const started = Date.now();
    let closing = false;
    let announceTimer: ReturnType<typeof setTimeout> | undefined;
    /** Sessions whose calls to each server are running, so the server's questions go to the client running that turn. */
    const calling = new Map<string, Map<string, number>>();
    /** Sign-ins running, by server. */
    const signingIn = new Map<string, Promise<void>>();

    const publish = (notice: NoticePayload) => events.publish(Notice, notice);

    // ------------------------------------------------------------------ what clients see

    const scopeOf = Effect.map(control.plugins, (plugins): ConfigScope => plugins.find((plugin) => plugin.id === owner.id)?.configScope ?? "user");

    const toolInfos = (server: Server, state: ConnectionState | undefined): McpToolInfo[] => {
      const listed = state?.tools ?? [];
      const names = toolNames(
        server.spec.id,
        listed.map((tool) => tool.name),
      );
      const disabled = new Set(server.spec.disabledTools ?? []);
      return listed.map((tool) => {
        const name = names.get(tool.name)!;
        const title = tool.title ?? tool.annotations?.title;
        return {
          name: tool.name,
          tool: name,
          ...(title === undefined ? {} : { title }),
          ...(tool.description === undefined ? {} : { description: tool.description }),
          enabled: !disabled.has(tool.name),
          hints: hintsOf(tool),
        };
      });
    };

    const infoOf = (server: Server, scope: ConfigScope): McpServerInfo => {
      const spec = server.spec;
      const state = server.held?.connection.state;
      const base = {
        id: spec.id,
        spec: masked(spec),
        type: transportOf(spec),
        scope,
        tools: toolInfos(server, state),
        resources: state?.resources ?? 0,
        prompts: state?.prompts ?? 0,
        secrets: Object.keys(server.secrets).sort(),
        missing: [...server.missing],
        ...(transportOf(spec) === "stdio" ? {} : { signedIn: server.signIn?.tokens !== undefined }),
      };
      if (spec.enabled === false) return { ...base, status: "off", since: server.since };
      if (state === undefined) return { ...base, status: "error", error: server.problem ?? "Not connected", since: server.since };
      return {
        ...base,
        status: state.status,
        since: state.since,
        ...(state.error === undefined ? {} : { error: state.error }),
        ...(state.retryAt === undefined ? {} : { retryAt: state.retryAt }),
        ...(state.server === undefined ? {} : { server: state.server }),
        ...(state.protocol === undefined ? {} : { protocol: state.protocol }),
        ...(state.instructions === undefined ? {} : { instructions: state.instructions }),
      };
    };

    const infos: Effect.Effect<McpServerInfo[]> = Effect.map(scopeOf, (scope) => [...servers.values()].map((server) => infoOf(server, scope)));

    /** Tells clients, once for a burst of changes. */
    const announce = () => {
      if (closing || announceTimer !== undefined) return;
      announceTimer = setTimeout(() => {
        announceTimer = undefined;
        if (closing) return;
        void run(Effect.flatMap(infos, (list) => events.publish(McpChanged, { servers: list }))).catch(() => {});
      }, ANNOUNCE_MS);
    };

    // ------------------------------------------------------------------ tools

    /** Registers the tools a connected server offers (and not turned off), and unregisters the rest. */
    const syncTools = (server: Server): Effect.Effect<void, never, PluginContext> =>
      Effect.gen(function* () {
        const connection = server.held?.connection;
        const state = connection?.state;
        const listed = state?.status === "ready" && !closing ? state.tools : [];
        const disabled = new Set(server.spec.disabledTools ?? []);
        const names = toolNames(
          server.spec.id,
          listed.map((tool) => tool.name),
        );
        const wanted = new Map<string, McpTool>();
        for (const tool of listed) if (!disabled.has(tool.name)) wanted.set(names.get(tool.name)!, tool);
        for (const [name, registered] of server.registered) {
          const tool = wanted.get(name);
          if (tool !== undefined && registered.connection === connection && JSON.stringify(tool) === registered.definition) continue;
          server.registered.delete(name);
          yield* Scope.close(registered.scope, Exit.void);
        }
        for (const [name, definition] of wanted) {
          if (server.registered.has(name) || connection === undefined) continue;
          const scope = yield* Scope.make();
          const tool = tracked(server.spec.id, mcpTool({ server: server.spec.id, name, definition, connection, ...limits(server.spec) }));
          const registered = yield* tools.register(tool).pipe(Scope.extend(scope), Effect.either);
          if (registered._tag === "Left") {
            yield* Scope.close(scope, Exit.void);
            connection.log("host", `Could not register ${name}: ${registered.left.message}`);
            continue;
          }
          server.registered.set(name, { name, definition: JSON.stringify(definition), connection, scope });
        }
      });

    const limits = (spec: McpServerSpec) => ({ timeoutMs: spec.toolTimeoutMs ?? config.toolTimeoutMs, maxOutputChars: config.maxOutputChars });

    /** Counts the sessions calling a server while their calls run (see `originFor`). */
    const tracked = <T extends { readonly execute: (input: any, context: any) => any }>(server: string, tool: T): T => ({
      ...tool,
      execute: async (input: unknown, context: { readonly sessionId: string }) => {
        const sessions = calling.get(server) ?? new Map<string, number>();
        calling.set(server, sessions);
        sessions.set(context.sessionId, (sessions.get(context.sessionId) ?? 0) + 1);
        try {
          return await tool.execute(input, context);
        } finally {
          const left = (sessions.get(context.sessionId) ?? 1) - 1;
          if (left === 0) sessions.delete(context.sessionId);
          else sessions.set(context.sessionId, left);
        }
      },
    });

    /** Whose client a server's question goes to: the one session calling it, else any client. */
    const originFor = (server: string): string | undefined => {
      const sessions = [...(calling.get(server)?.keys() ?? [])];
      return sessions.length === 1 ? `session:${sessions[0]}` : undefined;
    };

    const queueSync = (server: Server) => {
      server.sync = server.sync.then(() => run(Effect.zipRight(syncTools(server), syncResources()))).catch(() => {});
      return server.sync;
    };

    // ------------------------------------------------------------------ resources

    /** Connected servers that offer resources. */
    const withResources = () =>
      [...servers.values()].filter((server) => server.held?.connection.state.status === "ready" && server.held.connection.state.resources > 0);
    let resourceTools: Scope.CloseableScope | undefined;

    const listResourcesTool: Tool<{ readonly server?: string | undefined }> = {
      name: RESOURCE_TOOLS[0],
      description:
        "List the resources (files, records, documents) connected MCP servers offer, with their URIs and URI templates. Read one with mcp_read_resource.",
      input: Schema.Struct({ server: Schema.optional(Schema.String).annotations({ description: "Only this server's (its id)" }) }),
      replay: "safe",
      execute: async ({ server }, { signal }) => {
        const chosen = withResources().filter((candidate) => server === undefined || candidate.spec.id === server);
        if (chosen.length === 0)
          throw new Error(server === undefined ? "No connected MCP server offers resources" : `MCP server "${server}" is not connected or offers no resources`);
        const parts = await Promise.all(
          chosen.map(async (candidate) => {
            try {
              const { resources, templates } = await candidate.held!.connection.listResources(signal);
              return [
                `${candidate.spec.id}:`,
                ...resources.map(
                  (resource) =>
                    `- ${resource.uri} ${resource.name}${resource.mimeType === undefined ? "" : ` (${resource.mimeType})`}${resource.description === undefined ? "" : `: ${resource.description}`}`,
                ),
                ...templates.map(
                  (template) => `- ${template.uriTemplate} (template) ${template.name}${template.description === undefined ? "" : `: ${template.description}`}`,
                ),
              ].join("\n");
            } catch (error) {
              return `${candidate.spec.id}: could not list: ${errorMessage(error)}`;
            }
          }),
        );
        return new ToolResult({ content: [{ type: "text", text: parts.join("\n\n") }] });
      },
    };

    const readResourceTool: Tool<{ readonly server: string; readonly uri: string }> = {
      name: RESOURCE_TOOLS[1],
      description: "Read a resource from a connected MCP server by its URI (one mcp_resources lists, or one its template describes).",
      input: Schema.Struct({
        server: Schema.String.annotations({ description: "The server's id" }),
        uri: Schema.String.annotations({ description: "The resource's URI" }),
      }),
      replay: "safe",
      execute: async ({ server, uri }, context) => {
        const found = servers.get(server);
        if (found?.held === undefined) throw new Error(`No connected MCP server "${server}"`);
        const result = await found.held.connection.readResource(uri, { signal: context.signal, timeoutMs: found.spec.toolTimeoutMs ?? config.toolTimeoutMs });
        const content = result.contents.map((resource) => toContent({ type: "resource", resource }));
        return capOutput(
          new ToolResult({ content: content.length === 0 ? [{ type: "text", text: "(empty)" }] : content, details: { server, uri } }),
          config.maxOutputChars,
        );
      },
    };

    /** The resource tools are registered while some connected server offers resources. */
    const syncResources = (): Effect.Effect<void, never, PluginContext> =>
      Effect.gen(function* () {
        const wanted = !closing && withResources().length > 0;
        if (wanted === (resourceTools !== undefined)) return;
        if (!wanted) {
          const scope = resourceTools!;
          resourceTools = undefined;
          return yield* Scope.close(scope, Exit.void);
        }
        const scope = yield* Scope.make();
        resourceTools = scope;
        yield* Effect.all([tools.register(listResourcesTool), tools.register(readResourceTool)]).pipe(Scope.extend(scope), Effect.ignore);
      });

    // ------------------------------------------------------------------ connections

    const signInStore = (server: Server): SignInStore => ({
      current: () => server.signIn,
      update: async (change) => {
        let next: SignIn | undefined;
        await run(
          credentials.modify(signInKey(server.spec.id), (current) =>
            Effect.sync(() => {
              next = change(decodeSignIn(current) ?? server.signIn);
              return next === undefined ? undefined : encodeSignIn(next);
            }),
          ),
        );
        if (next === undefined) await run(credentials.remove(signInKey(server.spec.id)));
        server.signIn = next;
      },
    });

    /** The server's `oauth` settings, `${NAME}`s read as its launch reads them. */
    const oauthSettings = (server: Server): OAuthSettings => {
      const oauth = server.spec.oauth ?? {};
      const lookup = (name: string) => server.secrets[name] ?? process.env[name];
      const read = (value: string | undefined) => (value === undefined ? "" : interpolate(value, lookup, new Set()));
      const clientId = read(oauth.clientId);
      const clientSecret = read(oauth.clientSecret);
      return {
        ...(clientId === "" ? {} : { clientId }),
        ...(clientSecret === "" ? {} : { clientSecret }),
        ...(oauth.scopes === undefined ? {} : { scopes: oauth.scopes }),
        ...(oauth.callbackPort === undefined ? {} : { callbackPort: oauth.callbackPort }),
      };
    };

    const bindingFor = (server: Server, url: string | undefined): Binding => ({
      ...(url === undefined || hasAuthorizationHeader(server.spec)
        ? {}
        : { auth: signInProvider({ url, settings: oauthSettings(server), store: signInStore(server) }) }),
      elicit: (params) => {
        const origin = originFor(server.spec.id);
        return run(Effect.locally(elicit(interaction, publish, server.spec.name ?? server.spec.id, params), InteractionOrigin, origin));
      },
    });

    /** What changed in a server's connection: its tools to sync, clients to tell, and the person to tell when it needs them. */
    const watch = (server: Server, connection: Connection) => {
      let last = connection.state.status;
      return connection.subscribe(() => {
        const state = connection.state;
        if (state.status !== last) {
          const name = server.spec.name ?? server.spec.id;
          if (state.status === "auth")
            void run(publish({ level: "warning", message: `MCP server ${name} needs you to sign in`, source: `mcp:${server.spec.id}` }));
          else if (state.status === "error" && state.retryAt === undefined && last !== "error") {
            void run(
              publish({ level: "error", message: `MCP server ${name} stopped: ${state.error ?? "it could not connect"}`, source: `mcp:${server.spec.id}` }),
            );
          }
          last = state.status;
        }
        void queueSync(server);
        announce();
      });
    };

    /** Starts holding the connection the server's spec and secrets now describe, letting go of any other. */
    const connect = (server: Server): Effect.Effect<void, never, PluginContext> =>
      Effect.gen(function* () {
        const previous = server.held;
        for (const release of server.release.splice(0)) release();
        server.held = undefined;
        delete server.problem;
        server.missing = [];
        const spec = server.spec;
        if (spec.enabled !== false) {
          const resolved = launchOf(spec, { secrets: server.secrets, cwd: services.cwd });
          server.missing = resolved.missing;
          if (resolved.launch === undefined) server.problem = resolved.problem ?? "It cannot start";
          else {
            const launch = resolved.launch;
            const startupTimeoutMs = spec.startupTimeoutMs ?? config.startupTimeoutMs;
            const held = acquire(
              connectionKey(spec.id, launch, startupTimeoutMs),
              () => new Connection(spec.id, launch, { startupTimeoutMs, clientInfo: { name: "lemma", version: services.version } }),
            );
            server.held = held;
            server.release.push(held.connection.bind(bindingFor(server, launch.type === "stdio" ? undefined : launch.url)));
            server.release.push(watch(server, held.connection));
          }
        }
        if (previous !== undefined && previous !== server.held) yield* Effect.promise(() => previous.release());
        yield* Effect.promise(() => queueSync(server));
        announce();
      });

    const readCredential = (key: string) => credentials.read(key).pipe(Effect.orElseSucceed(() => undefined));

    // Every configured server, in config order; a clashing id is a problem, not a crash.
    for (const spec of config.servers) {
      const clash = [...servers.values()].find((other) => sameServer(other.spec.id, spec.id));
      const [secretsCredential, signInCredential] = yield* Effect.all([readCredential(secretsKey(spec.id)), readCredential(signInKey(spec.id))], {
        concurrency: 2,
      });
      const server: Server = {
        spec,
        secrets: decodeSecrets(secretsCredential),
        signIn: decodeSignIn(signInCredential),
        missing: [],
        held: undefined,
        release: [],
        registered: new Map(),
        sync: Promise.resolve(),
        since: started,
      };
      if (clash !== undefined) {
        servers.set(`${spec.id}\0${servers.size}`, { ...server, problem: `Its id reads the same as "${clash.spec.id}"'s in tool names; rename one` });
        continue;
      }
      servers.set(spec.id, server);
      yield* connect(server);
    }

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        closing = true;
        clearTimeout(announceTimer);
        if (resourceTools !== undefined) yield* Scope.close(resourceTools, Exit.void);
        yield* Effect.forEach(
          [...servers.values()],
          (server) =>
            Effect.gen(function* () {
              for (const release of server.release.splice(0)) release();
              for (const registered of server.registered.values()) yield* Scope.close(registered.scope, Exit.void);
              server.registered.clear();
              if (server.held !== undefined) yield* Effect.promise(() => server.held!.release());
            }),
          { concurrency: "unbounded", discard: true },
        );
      }),
    );

    // ------------------------------------------------------------------ the manager

    /** Manager calls run in a client's handler, outside this plugin: what they register is this plugin's. */
    const inPlugin = <A, E>(effect: Effect.Effect<A, E, PluginContext>) => Effect.provideService(effect, PluginContext, owner);

    const fail = (reason: McpError["reason"], message: string, server?: string, cause?: unknown) =>
      new McpError({ reason, message, ...(server === undefined ? {} : { server }), ...(cause === undefined ? {} : { cause }) });

    const find = (id: string) =>
      Effect.suspend(() => {
        const server = servers.get(id) ?? [...servers.values()].find((candidate) => candidate.spec.id === id);
        return server === undefined ? Effect.fail(fail("NotFound", `No MCP server "${id}"`, id)) : Effect.succeed(server);
      });

    /** Writes servers into this plugin's config file; the host reloads the plugin with them. */
    const saveConfig = (change: { readonly add?: readonly McpServerSpec[]; readonly remove?: readonly string[] }, scope?: ConfigScope) =>
      Effect.gen(function* () {
        const file = scope ?? (yield* scopeOf);
        return yield* control.configure(
          {
            [owner.id]: {
              ...(change.add === undefined ? {} : { add: { servers: change.add as unknown as Record<string, unknown>[] } }),
              ...(change.remove === undefined ? {} : { remove: { servers: [...change.remove] } }),
            },
          },
          file === "project" ? { scope: file } : undefined,
        );
      }).pipe(Effect.mapError((error) => fail("Failed", error.diagnostics.map((diagnostic) => diagnostic.message).join("; "), undefined, error)));

    /** A spec as it is written: defaults left out, so the config file stays short. */
    const tidy = (spec: McpServerSpec): McpServerSpec => {
      const { enabled, disabledTools, ...rest } = spec;
      return { ...rest, ...(enabled === false ? { enabled } : {}), ...(disabledTools !== undefined && disabledTools.length > 0 ? { disabledTools } : {}) };
    };

    const storeSecrets = (id: string, change: Readonly<Record<string, string | null>>) =>
      Effect.gen(function* () {
        let empty = false;
        yield* credentials.modify(secretsKey(id), (current) =>
          Effect.sync(() => {
            const env = decodeSecrets(current);
            for (const [name, value] of Object.entries(change)) {
              if (value === null) delete env[name];
              else env[name] = value;
            }
            empty = Object.keys(env).length === 0;
            return empty ? undefined : ({ type: "api_key", env } satisfies Credential);
          }),
        );
        if (empty) yield* credentials.remove(secretsKey(id));
        return empty;
      }).pipe(Effect.mapError((error) => fail("Failed", `Could not store the secrets: ${error.message}`, id, error)));

    const save: McpManager["save"] = (next, options) =>
      Effect.gen(function* () {
        const previous = servers.get(next.id)?.spec;
        const spec = unmasked(next, previous);
        if (typeof spec === "string") return yield* fail("Invalid", spec, next.id);
        const clash = [...servers.values()].find((other) => other.spec.id !== spec.id && sameServer(other.spec.id, spec.id));
        if (clash !== undefined) return yield* fail("Invalid", `"${spec.id}" reads the same as "${clash.spec.id}" in tool names; choose another id`, spec.id);
        if (transportOf(spec) === "stdio" ? spec.command === undefined : spec.url === undefined) {
          return yield* fail("Invalid", transportOf(spec) === "stdio" ? "A command server needs a command" : "A URL server needs a url", spec.id);
        }
        const secrets = options?.secrets ?? {};
        if (Object.keys(secrets).length > 0) yield* storeSecrets(spec.id, secrets);
        const report = yield* saveConfig({ add: [tidy(spec)] }, options?.scope);
        // Only the secrets changed: the config did not, so this instance connects with them itself.
        const server = servers.get(spec.id);
        if (server !== undefined && !report.restarted.includes(owner.id) && !report.deferred) {
          server.secrets = decodeSecrets(yield* readCredential(secretsKey(spec.id)));
          yield* inPlugin(connect(server));
        }
      });

    const remove: McpManager["remove"] = (id) =>
      Effect.gen(function* () {
        yield* find(id);
        yield* saveConfig({ remove: [id] });
        yield* credentials.remove(secretsKey(id)).pipe(Effect.ignore);
        yield* credentials.remove(signInKey(id)).pipe(Effect.ignore);
      });

    const setEnabled: McpManager["setEnabled"] = (id, enabled) =>
      Effect.flatMap(find(id), (server) => saveConfig({ add: [tidy({ ...server.spec, enabled })] }).pipe(Effect.asVoid));

    const setTool: McpManager["setTool"] = (id, tool, enabled) =>
      Effect.flatMap(find(id), (server) => {
        const disabled = new Set(server.spec.disabledTools ?? []);
        if (enabled) disabled.delete(tool);
        else disabled.add(tool);
        return saveConfig({ add: [tidy({ ...server.spec, disabledTools: [...disabled].sort() })] }).pipe(Effect.asVoid);
      });

    const restart: McpManager["restart"] = (id) =>
      Effect.gen(function* () {
        const server = yield* find(id);
        // Its secrets may have changed in another process.
        server.secrets = decodeSecrets(yield* readCredential(secretsKey(id)));
        const before = server.held?.connection;
        yield* inPlugin(connect(server));
        // The same connection (nothing about it changed): start it over.
        if (server.held !== undefined && server.held.connection === before) yield* Effect.promise(() => server.held!.connection.restart());
      });

    /** The browser sign-in: listens for the redirect on the loopback interface while asking for it to be pasted, for a browser elsewhere. */
    const signInFlow = (server: Server, url: string) =>
      Effect.gen(function* () {
        const settings = oauthSettings(server);
        const name = server.spec.name ?? server.spec.id;
        const state = randomState();
        const wanted = settings.callbackPort ?? portOf(server.signIn?.redirectUrl) ?? 0;
        const listen = (port: number) => Effect.tryPromise({ try: () => listenForCallback(port, state, name), catch: (error) => error });
        const callback = yield* Effect.acquireRelease(
          listen(wanted).pipe(Effect.orElse(() => (settings.callbackPort === undefined && wanted !== 0 ? listen(0) : listen(wanted)))),
          (open) => Effect.promise(() => open.close()),
        ).pipe(Effect.mapError((error) => fail("Auth", errorMessage(error), server.spec.id, error)));
        const flow: Flow = { redirectUrl: redirectUrlFor(callback.port), state };
        const provider = signInProvider({ url, settings, store: signInStore(server), flow });
        const scope = settings.scopes?.join(" ");
        const authorize = (options: { readonly authorizationCode?: string; readonly iss?: string }) =>
          Effect.tryPromise({
            try: () => auth(provider, { serverUrl: url, ...(scope === undefined ? {} : { scope }), ...options }),
            catch: (error) => fail("Auth", `Could not sign in to ${name}: ${errorMessage(error)}`, server.spec.id, error),
          });
        if ((yield* authorize({})) === "AUTHORIZED") return;
        const page = flow.authorizationUrl;
        if (page === undefined || !/^https?:$/.test(page.protocol)) return yield* fail("Auth", `${name} gave no usable sign-in page`, server.spec.id);
        yield* publish({
          level: "info",
          message: `Sign in to ${name} in your browser`,
          source: `mcp:${server.spec.id}`,
          links: [{ url: page.href, label: `Sign in to ${name}` }],
        });
        const pasted = Effect.gen(function* () {
          for (;;) {
            const text = yield* interaction.ask(`If your browser is not on the host's machine, paste the address it shows after you sign in to ${name}`, {
              placeholder: "http://localhost:…/callback?code=…",
            });
            const parsed = parseCallback(text);
            if (!("error" in parsed)) return parsed;
          }
        }).pipe(Effect.mapError(() => fail("Cancelled", "Signing in was cancelled", server.spec.id)));
        const received: Callback = yield* Effect.raceFirst(
          Effect.tryPromise({ try: () => callback.result, catch: (error) => fail("Auth", errorMessage(error), server.spec.id, error) }),
          pasted,
        );
        if (received.state !== state) return yield* fail("Auth", "The sign-in answered another request; start again", server.spec.id);
        yield* authorize({ authorizationCode: received.code, ...(received.iss === undefined ? {} : { iss: received.iss }) });
      }).pipe(
        Effect.scoped,
        Effect.timeoutFail({ duration: SIGN_IN_TIMEOUT_MS, onTimeout: () => fail("Auth", "Signing in took too long", server.spec.id) }),
        Effect.locally(InteractionOrigin, `mcp:${server.spec.id}`),
      );

    const login: McpManager["login"] = (id) =>
      Effect.gen(function* () {
        const server = yield* find(id);
        const launch = launchOf(server.spec, { secrets: server.secrets, cwd: services.cwd }).launch;
        if (launch === undefined || launch.type === "stdio")
          return yield* fail("Invalid", `${id} is not a URL server; it takes its credentials from its environment`, id);
        if (hasAuthorizationHeader(server.spec))
          return yield* fail("Invalid", `${id} sends its own Authorization header; change that instead of signing in`, id);
        const running = signingIn.get(id);
        if (running !== undefined) return yield* Effect.promise(() => running);
        // The sign-in belongs to the plugin, not the caller: a client that drops mid-way leaves it running.
        const promise = run(signInFlow(server, launch.url)).finally(() => signingIn.delete(id));
        signingIn.set(
          id,
          promise.catch(() => {}),
        );
        yield* Effect.tryPromise({ try: () => promise, catch: (error) => (error instanceof McpError ? error : fail("Auth", errorMessage(error), id, error)) });
        server.held?.connection.log("host", "Signed in");
        if (server.held !== undefined) yield* Effect.promise(() => server.held!.connection.restart());
      });

    const logout: McpManager["logout"] = (id) =>
      Effect.gen(function* () {
        const server = yield* find(id);
        yield* credentials.remove(signInKey(id)).pipe(Effect.mapError((error) => fail("Failed", error.message, id, error)));
        server.signIn = undefined;
        server.held?.connection.log("host", "Signed out");
        if (server.held !== undefined) yield* Effect.promise(() => server.held!.connection.restart());
      });

    const logs: McpManager["logs"] = (id) =>
      Effect.map(find(id), (server): readonly McpLogEntry[] => {
        const entries = server.held?.connection.logs ?? [];
        return server.problem === undefined ? [...entries] : [...entries, { at: server.since, source: "host", text: server.problem }];
      });

    const manager: McpManager = {
      id: owner.id,
      servers: infos,
      save,
      remove,
      setEnabled,
      setTool,
      restart,
      login,
      logout,
      logs,
    };

    /** Waits, once, for servers still making their first connection, up to `startupWaitMs` after this instance started. */
    const firstConnections = Effect.suspend(() => {
      const pending = [...servers.values()].flatMap((server) =>
        server.held !== undefined && server.held.connection.state.status === "starting" ? [server.held.connection.firstAttempt] : [],
      );
      const left = started + config.startupWaitMs - Date.now();
      if (pending.length === 0 || left <= 0) return Effect.succeed(false);
      return Effect.promise(() => Promise.race([Promise.all(pending), new Promise((resolve) => setTimeout(resolve, left).unref?.())])).pipe(
        Effect.zipRight(Effect.promise(() => Promise.all([...servers.values()].map((server) => server.sync)))),
        Effect.as(true),
      );
    });

    /**
     * The `mcp-servers` system section: each enabled server, whether it needs a sign-in, and its instructions, then
     * how to reach and call its tools. It changes when a server is added or removed, needs a sign-in, or first
     * connects (its instructions), not on every reconnect.
     */
    const section = (codemode: boolean): string | undefined => {
      const enabled = [...servers.values()].filter((server) => server.spec.enabled !== false);
      if (enabled.length === 0) return undefined;
      const lines = enabled.map((server) => {
        const state = server.held?.connection.state;
        const title = state?.server?.title ?? (server.spec.name !== undefined && server.spec.name !== server.spec.id ? server.spec.name : undefined);
        const head = `- ${server.spec.id}${title === undefined ? "" : ` (${title})`}${state?.status === "auth" ? ": needs the user to sign in (Settings → MCP servers) before its tools work" : ""}`;
        const instructions = state?.instructions?.trim();
        return instructions === undefined || instructions === ""
          ? head
          : `${head}\n  Its instructions: ${describe({ name: "", inputSchema: { type: "object" }, description: instructions }).replace(/\n/g, "\n  ")}`;
      });
      return [
        "<mcp_servers>",
        "The user connected these MCP servers; their tools are named mcp__<server>__<tool>.",
        ...lines,
        ...(codemode
          ? [
              'They are not in your tool list: call them from a codemode script (`await tools.mcp__<server>__<tool>({ ... })`), and find them, with their declarations, with `await searchTools("<server> <what you need>")`.',
              "A call resolves to the server's structured result, else the JSON object or array its text holds, else its text; a result with an image or a resource resolves to its MCP content blocks. A call the server reports failed rejects with its message.",
            ]
          : []),
        "</mcp_servers>",
      ].join("\n");
    };

    return { manager, infos, firstConnections, section, run };
  });
