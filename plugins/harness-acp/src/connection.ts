import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { AgentSpec } from "./config.ts";

/** Lemma as it introduces itself to agents. */
export const CLIENT_INFO = { name: "lemma", version: "0.1.0" } as const;

/** Output kept from an agent's stderr, the tail: what its failures say. */
const STDERR_CHARS = 8 * 1024;
/** How long an agent gets to exit on its own once its stdin closes, and again after SIGTERM. */
const EXIT_GRACE_MS = 2_000;

/** How the adapter reaches an agent: a stream to its process, or (in tests) an agent in this process. */
export interface Transport {
  readonly target: { readonly stream: acp.Stream } | { readonly app: acp.AgentApp };
  /** What the agent printed to stderr lately. */
  readonly stderr: () => string;
  /** Resolves with why the agent stopped, when it does. */
  readonly exited: Promise<string>;
  /** Stops the agent: stdin closed, then SIGTERM, then SIGKILL. */
  readonly close: () => Promise<void>;
}

export type StartAgent = (spec: AgentSpec, cwd: string) => Transport;

const settle = <A>(promise: Promise<A>, ms: number) =>
  Promise.race([promise.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms).unref())]);

/** Starts the agent's process with ACP on its stdio. */
export const spawnAgent: StartAgent = (spec, cwd) => {
  const child = spawn(spec.command, [...spec.args], { cwd, env: { ...process.env, ...spec.env }, stdio: ["pipe", "pipe", "pipe"] });
  let tail = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    tail = (tail + chunk).slice(-STDERR_CHARS);
  });
  const exited = new Promise<string>((resolve) => {
    child.once("exit", (code, signal) => resolve(signal === null ? `exited with code ${code}` : `was stopped by ${signal}`));
    // A spawn that fails (no such program) emits `error` and no `exit`.
    child.once("error", (error) => resolve(error.message));
  });
  // A write after the process died must not take the host down; the connection notices the closed stream.
  child.stdin.on("error", () => {});
  return {
    target: { stream: acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>) },
    stderr: () => tail,
    exited,
    close: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.stdin.end();
      if (await settle(exited, EXIT_GRACE_MS)) return;
      child.kill("SIGTERM");
      if (await settle(exited, EXIT_GRACE_MS)) return;
      child.kill("SIGKILL");
    },
  };
};

/** What a running turn takes from its ACP session: the session's updates, and its requests for permission. */
export interface SessionHandler {
  readonly update: (update: acp.SessionUpdate) => void;
  readonly permission: (request: acp.RequestPermissionRequest) => Promise<acp.RequestPermissionResponse>;
}

/**
 * One agent process and its ACP connection, shared by every session that
 * runs on it. Updates and permission requests are routed to the turn
 * running in their ACP session; ones for a session no turn runs in (the
 * history `session/load` replays) are dropped, and their permission refused.
 */
export interface Connection {
  readonly agent: acp.ClientContext;
  readonly initialized: acp.InitializeResponse;
  /** Turns running now, by ACP session id. */
  readonly handlers: Map<string, SessionHandler>;
  /** ACP sessions this connection has open, with the Lemma turn each last ran. */
  readonly sessions: Map<string, string>;
  /** Each session's cumulative cost so far (USD), to turn the agent's running totals into a turn's cost. */
  readonly costs: Map<string, number>;
  readonly alive: () => boolean;
  /** Why the connection ended, with what the agent last printed. */
  readonly ended: () => string | undefined;
  readonly close: () => Promise<void>;
}

const CANCELLED: acp.RequestPermissionResponse = { outcome: { outcome: "cancelled" } };

/** Connects to the agent and runs `initialize`. Rejects (with the agent's last stderr) when it cannot start or answer. */
export async function openConnection(spec: AgentSpec, transport: Transport): Promise<Connection> {
  const handlers = new Map<string, SessionHandler>();
  const app = acp
    .client({ name: CLIENT_INFO.name })
    .onNotification(acp.methods.client.session.update, (ctx) => {
      handlers.get(ctx.params.sessionId)?.update(ctx.params.update);
    })
    .onRequest(acp.methods.client.session.requestPermission, (ctx) => handlers.get(ctx.params.sessionId)?.permission(ctx.params) ?? Promise.resolve(CANCELLED));
  const connection = "stream" in transport.target ? app.connect(transport.target.stream) : app.connect(transport.target.app);
  let ended: string | undefined;
  const why = (reason: string) => {
    const stderr = transport.stderr().trim();
    return `${spec.title ?? spec.id} ${reason}${stderr === "" ? "" : `. It last printed:\n${stderr.split("\n").slice(-20).join("\n")}`}`;
  };
  void transport.exited.then((reason) => {
    ended ??= why(reason);
    connection.close(new Error(ended));
  });
  void connection.closed.then(() => {
    ended ??= why("closed its connection");
  });
  const initialize: Promise<acp.InitializeResponse> = connection.agent.request(acp.methods.agent.initialize, {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: CLIENT_INFO,
  });
  const initialized = await Promise.race([initialize, transport.exited.then((reason): Promise<never> => Promise.reject(new Error(why(reason))))]).catch(
    async (error: unknown): Promise<never> => {
      await transport.close();
      throw error instanceof Error ? error : new Error(String(error));
    },
  );
  return {
    agent: connection.agent,
    initialized,
    handlers,
    sessions: new Map(),
    costs: new Map(),
    alive: () => ended === undefined && !connection.signal.aborted,
    ended: () => ended,
    close: async () => {
      connection.close();
      await transport.close();
    },
  };
}
