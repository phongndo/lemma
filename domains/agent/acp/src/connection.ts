import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { Access, HarnessModel } from "@lemma/agent";
import type { AgentSpec, AuthMethodInfo } from "@lemma/agent/acp";
import { modeFor } from "./access.ts";
import type { AgentMode } from "./access.ts";

/** How much of what the agent printed to stderr is kept, to say why it failed. */
const STDERR_CHARS = 4_000;

/** A tool call as the agent has reported it so far in its session: what a permission request for it is about. */
export interface KnownCall {
  readonly title?: string;
  readonly kind?: string;
  readonly rawInput?: unknown;
  readonly locations: readonly string[];
  readonly content: readonly acp.ToolCallContent[];
}

/** What the agent process needs of the plugin. */
export interface ProcessHooks {
  /**
   * A permission request for a tool call, in the Lemma session whose ACP session asks, with what the agent said of the
   * call and the session's access level. `signal` aborts when the turn is cancelled or the agent stops: answer then
   * with `cancelled`.
   */
  readonly permission: (
    sessionId: string,
    request: acp.RequestPermissionRequest,
    context: { readonly call: KnownCall; readonly access: Access | undefined; readonly signal: AbortSignal },
  ) => Promise<acp.RequestPermissionResponse>;
  /** Its state changed: it started, stopped, or opened a session. */
  readonly changed: () => void;
}

/** A turn's listener for its ACP session's updates. */
type Listener = (update: acp.SessionUpdate) => void;

/** The ACP error code for "sign in first". */
const AUTH_REQUIRED = -32000;

/** An ACP error's message, and whether it asks for signing in. */
export const describeError = (cause: unknown): { readonly message: string; readonly auth: boolean } => {
  if (typeof cause === "object" && cause !== null) {
    const { code, message, data } = cause as { code?: unknown; message?: unknown; data?: unknown };
    const detail = typeof data === "object" && data !== null && "details" in data ? String((data as { details: unknown }).details) : undefined;
    if (typeof message === "string") return { message: detail === undefined ? message : `${message}: ${detail}`, auth: code === AUTH_REQUIRED };
  }
  return { message: cause instanceof Error ? cause.message : String(cause), auth: false };
};

/**
 * One agent's process, speaking ACP over its stdin and stdout: started when first needed, serving every Lemma session
 * that runs turns on it, each in an ACP session of its own. `token` names this start, so a session's kept state says
 * whether it is one this process knows.
 */
export class AgentProcess {
  readonly spec: AgentSpec;
  readonly token = randomBytes(6).toString("hex");
  private readonly hooks: ProcessHooks;
  private child: ChildProcess | undefined;
  private connection: acp.ClientConnection | undefined;
  private starting: Promise<acp.InitializeResponse> | undefined;
  private closed = false;
  /** Lemma session by ACP session, for the sessions this process opened. */
  private readonly owners = new Map<string, string>();
  private readonly listeners = new Map<string, Listener>();
  /** What each session's calls are, as reported: a permission request names only the call. */
  private readonly calls = new Map<string, Map<string, KnownCall>>();
  /** Permission requests waiting on the person, by session: cancelling the session withdraws them. */
  private readonly asking = new Map<string, Set<AbortController>>();
  /** Each session's mode, and the access level its turns asked for. */
  private readonly sessionModes = new Map<string, { current?: string; access?: Access; model?: string }>();
  /** The modes the agent offers, as its latest session said. */
  modes: readonly AgentMode[] = [];
  /** Its model option, as its latest session said: the option's id, the models, and the one a new session starts on. */
  models: { readonly configId: string; readonly options: readonly HarnessModel[]; readonly current?: string } | undefined;
  initialized: acp.InitializeResponse | undefined;
  /** Why it stopped, or failed to start. */
  error: string | undefined;
  stderr = "";

  constructor(spec: AgentSpec, hooks: ProcessHooks) {
    this.spec = spec;
    this.hooks = hooks;
  }

  get running(): boolean {
    return this.connection !== undefined && this.error === undefined;
  }

  get sessions(): number {
    return this.owners.size;
  }

  authMethods(): AuthMethodInfo[] {
    return (this.initialized?.authMethods ?? []).map((method) => ({
      id: method.id,
      name: method.name,
      ...(method.description === undefined || method.description === null ? {} : { description: method.description }),
      kind: "type" in method && method.type === "terminal" ? "terminal" : "agent",
    }));
  }

  /** Starts it, once: spawned and initialized. A start that fails leaves `error`, and the next call starts it again. */
  start(): Promise<acp.InitializeResponse> {
    if (this.closed) return Promise.reject(new Error(`${this.spec.title} is stopping`));
    this.starting ??= this.spawn().catch((cause: unknown) => {
      this.starting = undefined;
      this.error = describeError(cause).message;
      this.stop();
      this.hooks.changed();
      throw cause;
    });
    return this.starting;
  }

  private async spawn(): Promise<acp.InitializeResponse> {
    this.error = undefined;
    this.stderr = "";
    const child = spawn(this.spec.command, [...this.spec.args], {
      env: { ...process.env, ...this.spec.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    const failedToSpawn = new Promise<never>((_, reject) => child.once("error", reject));
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-STDERR_CHARS);
    });
    child.once("exit", (code, signal) => {
      if (this.child !== child) return;
      this.error ??= `It exited (${signal ?? `code ${code}`})${this.stderr.trim() === "" ? "" : `: ${this.stderr.trim().split("\n").at(-1)}`}`;
      this.stop();
      this.hooks.changed();
    });
    const stream = acp.ndJsonStream(Writable.toWeb(child.stdin!), Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>);
    const connection = acp
      .client({ name: "lemma" })
      .onRequest(acp.methods.client.session.requestPermission, async ({ params }) => {
        const owner = this.owners.get(params.sessionId);
        if (owner === undefined) return { outcome: { outcome: "cancelled" } };
        const controller = new AbortController();
        const waiting = this.asking.get(params.sessionId) ?? new Set();
        this.asking.set(params.sessionId, waiting.add(controller));
        try {
          const call = this.track(params.sessionId, params.toolCall);
          return await this.hooks.permission(owner, params, { call, access: this.sessionModes.get(params.sessionId)?.access, signal: controller.signal });
        } finally {
          waiting.delete(controller);
        }
      })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        const { update } = params;
        if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") this.track(params.sessionId, update);
        if (update.sessionUpdate === "current_mode_update") this.modeOf(params.sessionId).current = update.currentModeId;
        if (update.sessionUpdate === "config_option_update") this.sawConfig(params.sessionId, update.configOptions, false);
        this.listeners.get(params.sessionId)?.(update);
      })
      .connect(stream);
    this.connection = connection;
    const initialized = await Promise.race([
      failedToSpawn,
      connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        // It reads and writes files and runs commands with its own tools, on the host, as it does in a terminal.
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "lemma", title: "Lemma", version: "0.1.0" },
      }),
    ]);
    this.initialized = initialized;
    this.hooks.changed();
    return initialized;
  }

  private agent(): acp.ClientConnection["agent"] {
    if (this.connection === undefined) throw new Error(`${this.spec.title} is not running${this.error === undefined ? "" : `: ${this.error}`}`);
    return this.connection.agent;
  }

  /** Merges what an update says of a call into what is known of it. */
  private track(acpSession: string, update: Partial<acp.ToolCall> | acp.ToolCallUpdate): KnownCall {
    const calls = this.calls.get(acpSession) ?? new Map<string, KnownCall>();
    this.calls.set(acpSession, calls);
    const id = update.toolCallId ?? "";
    const known = calls.get(id) ?? { locations: [], content: [] };
    const next: KnownCall = {
      ...known,
      ...(update.title == null ? {} : { title: update.title }),
      ...(update.kind == null ? {} : { kind: update.kind }),
      ...(update.rawInput == null ? {} : { rawInput: update.rawInput }),
      ...(update.locations == null || update.locations.length === 0 ? {} : { locations: update.locations.map((location) => location.path) }),
      ...(update.content == null || update.content.length === 0 ? {} : { content: update.content }),
    };
    calls.set(id, next);
    return next;
  }

  /** Reads the model option a session reports; `fresh`: a new session's, whose model is the agent's default. */
  private sawConfig(acpSession: string, options: readonly acp.SessionConfigOption[] | null | undefined, fresh: boolean): void {
    const option = options?.find((candidate) => candidate.category === "model" && candidate.type === "select");
    if (option === undefined || !("options" in option)) return;
    const flat = (option.options as readonly (acp.SessionConfigSelectOption | acp.SessionConfigSelectGroup)[]).flatMap((entry) =>
      "group" in entry ? entry.options : [entry],
    );
    const current = typeof option.currentValue === "string" ? option.currentValue : undefined;
    this.models = {
      configId: option.id,
      options: flat.map((entry) => ({ id: entry.value, name: entry.name, ...(entry.description == null ? {} : { description: entry.description }) })),
      ...(fresh && current !== undefined ? { current } : this.models?.current === undefined ? {} : { current: this.models.current }),
    };
    if (current !== undefined) this.modeOf(acpSession).model = current;
  }

  /** Puts the session on the agent's model `model`, unless it is on it already or the agent has no such choice. */
  async useModel(acpSession: string, model: string | undefined): Promise<void> {
    const mode = this.modeOf(acpSession);
    if (model === undefined || this.models === undefined || mode.model === model) return;
    await this.agent().request(acp.methods.agent.session.setConfigOption, { sessionId: acpSession, configId: this.models.configId, value: model });
    mode.model = model;
  }

  private modeOf(acpSession: string): { current?: string; access?: Access; model?: string } {
    let mode = this.sessionModes.get(acpSession);
    if (mode === undefined) this.sessionModes.set(acpSession, (mode = {}));
    return mode;
  }

  private sawModes(acpSession: string, modes: acp.SessionModeState | null | undefined): void {
    if (modes == null) return;
    this.modes = modes.availableModes.map(({ id, name }) => ({ id, name }));
    this.modeOf(acpSession).current = modes.currentModeId;
  }

  /**
   * Keeps the turn's access level: Lemma answers the session's requests as `access` says (none: it asks every one), and
   * the session is put in the agent's own mode for it, or, where the agent has none for it (or no level is named), back
   * in the agent's mode for asking (`supervised`'s), so a level chosen earlier never outlasts a lower one.
   */
  async useAccess(acpSession: string, access: Access | undefined): Promise<void> {
    const mode = this.modeOf(acpSession);
    if (access === undefined) delete mode.access;
    else mode.access = access;
    const modeId = (access === undefined ? undefined : modeFor(access, this.modes)) ?? modeFor("supervised", this.modes);
    if (modeId === undefined || mode.current === modeId) return;
    await this.agent().request(acp.methods.agent.session.setMode, { sessionId: acpSession, modeId });
    mode.current = modeId;
  }

  /** Whether it opened this ACP session since it started. */
  knows(acpSession: string): boolean {
    return this.owners.has(acpSession);
  }

  async newSession(sessionId: string, cwd: string, mcpServers: acp.McpServer[]): Promise<acp.NewSessionResponse> {
    await this.start();
    const created = await this.agent().request(acp.methods.agent.session.new, { cwd, mcpServers });
    this.owners.set(created.sessionId, sessionId);
    this.sawModes(created.sessionId, created.modes);
    this.sawConfig(created.sessionId, created.configOptions, true);
    this.hooks.changed();
    return created;
  }

  /** Takes up an ACP session an earlier start opened, when the agent can; false when it cannot. */
  async resumeSession(sessionId: string, acpSession: string, cwd: string, mcpServers: acp.McpServer[]): Promise<boolean> {
    const initialized = await this.start();
    if (initialized.agentCapabilities?.sessionCapabilities?.resume == null) return false;
    try {
      const resumed = await this.agent().request(acp.methods.agent.session.resume, { sessionId: acpSession, cwd, mcpServers });
      this.sawModes(acpSession, resumed.modes);
      this.sawConfig(acpSession, resumed.configOptions, false);
    } catch {
      return false;
    }
    this.owners.set(acpSession, sessionId);
    this.hooks.changed();
    return true;
  }

  /** Sends a prompt, `listener` hearing the session's updates until it is answered. */
  async prompt(acpSession: string, prompt: acp.ContentBlock[], listener: Listener): Promise<acp.PromptResponse> {
    this.listeners.set(acpSession, listener);
    try {
      return await this.agent().request(acp.methods.agent.session.prompt, { sessionId: acpSession, prompt });
    } finally {
      if (this.listeners.get(acpSession) === listener) this.listeners.delete(acpSession);
    }
  }

  cancel(acpSession: string): void {
    for (const controller of this.asking.get(acpSession) ?? []) controller.abort();
    void this.connection?.agent.notify(acp.methods.agent.session.cancel, { sessionId: acpSession }).catch(() => {});
  }

  async authenticate(methodId: string): Promise<void> {
    await this.start();
    await this.agent().request(acp.methods.agent.authenticate, { methodId });
  }

  /** The Lemma session is gone: its ACP sessions are cancelled and forgotten, with what was kept of their calls and modes. */
  forget(sessionId: string): void {
    let forgot = false;
    for (const [acpSession, owner] of this.owners) {
      if (owner !== sessionId) continue;
      this.cancel(acpSession);
      this.owners.delete(acpSession);
      this.listeners.delete(acpSession);
      this.calls.delete(acpSession);
      this.asking.delete(acpSession);
      this.sessionModes.delete(acpSession);
      forgot = true;
    }
    if (forgot) this.hooks.changed();
  }

  private stop(): void {
    const child = this.child;
    this.child = undefined;
    this.connection?.close();
    this.connection = undefined;
    this.starting = undefined;
    this.owners.clear();
    this.listeners.clear();
    for (const waiting of this.asking.values()) for (const controller of waiting) controller.abort();
    this.asking.clear();
    this.calls.clear();
    this.sessionModes.clear();
    if (child !== undefined && child.exitCode === null) child.kill();
  }

  close(): void {
    this.closed = true;
    this.stop();
  }
}
