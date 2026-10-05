import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { deserializeMessage, serializeMessage } from "@modelcontextprotocol/client";
import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/client";
import { inheritedEnvironment } from "./resolve.ts";

export interface StdioOptions {
  readonly command: string;
  readonly args: readonly string[];
  /** Set over what it inherits from the host (`inheritedEnvironment`). */
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  /** Each line the server writes to stderr, and each stdout line that is not a message. */
  readonly onLog: (line: string, stream: "stderr" | "stdout") => void;
}

/** How long a server has after its stdin closes, then after SIGTERM, before the next step. */
const GRACE_MS = 2_000;
/** One message may be this long; a server that writes more without a newline is cut off. */
const MAX_LINE = 64 * 1024 * 1024;

/** Signals the server's whole process group: it was spawned detached, so it leads one, and `npx`'s children are in it. */
const signalGroup = (child: ChildProcess, signal: NodeJS.Signals) => {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  }
};

const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

const waitExit = (child: ChildProcess, ms: number) =>
  new Promise<boolean>((resolve) => {
    if (exited(child)) return resolve(true);
    const timer = setTimeout(() => resolve(false), ms);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });

/**
 * MCP over a child's stdin and stdout, as the spec's stdio transport. Unlike
 * the SDK's, the server inherits the host's environment but its credentials
 * (a server started from a Nix shell or behind a proxy needs PATH and the
 * proxy settings, not the provider keys), leads its own process
 * group so closing it also stops what it started (`npx` → node), and a stdout
 * line that is not JSON-RPC is logged rather than failing the connection.
 */
export class StdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;

  private child: ChildProcess | undefined;
  private closing = false;
  private ended = false;
  /** Why the process ended, once it has: read by whoever reports the connection lost. */
  exit: string | undefined;

  private readonly options: StdioOptions;

  constructor(options: StdioOptions) {
    this.options = options;
  }

  /** With `stderr`, marks this as a stdio transport to the SDK's version probe: silence then means an older server, not an outage. */
  get pid(): number | undefined {
    return this.child?.pid;
  }

  get stderr(): NodeJS.ReadableStream | null {
    return this.child?.stderr ?? null;
  }

  start(): Promise<void> {
    if (this.child !== undefined) return Promise.reject(new Error("The stdio transport is already started"));
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.command, [...this.options.args], {
        cwd: this.options.cwd,
        env: { ...inheritedEnvironment(), ...this.options.env },
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
      this.child = child;
      let started = false;
      child.once("spawn", () => {
        started = true;
        resolve();
      });
      child.once("error", (error: NodeJS.ErrnoException) => {
        const message =
          error.code === "ENOENT"
            ? `Command not found: ${this.options.command}`
            : error.code === "EACCES"
              ? `Not allowed to run ${this.options.command}`
              : `Could not start ${this.options.command}: ${error.message}`;
        const failure = new Error(message, { cause: error });
        if (started) this.onerror?.(failure);
        else reject(failure);
      });
      child.once("exit", (code, signal) => {
        this.exit = signal !== null ? `was stopped by ${signal}` : `exited with code ${code}`;
        // Whatever it started may outlive it, still holding the pipes.
        signalGroup(child, "SIGTERM");
        if (!this.closing) this.end();
      });
      child.stdin?.on("error", (error) => {
        // EPIPE while it exits: the exit reports it.
        if (!exited(child)) this.onerror?.(error);
      });
      lines(
        child.stdout!,
        (line) => this.receive(line),
        (error) => this.onerror?.(error),
      );
      lines(
        child.stderr!,
        (line) => this.options.onLog(line, "stderr"),
        () => {},
      );
    });
  }

  private receive(line: string) {
    const text = line.trim();
    if (text === "") return;
    let message: JSONRPCMessage;
    try {
      message = deserializeMessage(text);
    } catch {
      // Servers that log to stdout break other clients; here the line is only noted.
      this.options.onLog(text, "stdout");
      return;
    }
    this.onmessage?.(message);
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.child?.stdin;
    if (stdin === undefined || stdin === null || stdin.destroyed) throw new Error("The server is not running");
    const data = serializeMessage(message);
    if (!stdin.write(data)) await new Promise<void>((resolve) => stdin.once("drain", resolve));
  }

  /** The spec's shutdown: close its stdin, then SIGTERM, then SIGKILL, waiting a little between each. */
  async close(): Promise<void> {
    const child = this.child;
    if (child === undefined || this.closing) return;
    this.closing = true;
    if (!exited(child)) {
      child.stdin?.end();
      if (!(await waitExit(child, GRACE_MS))) {
        signalGroup(child, "SIGTERM");
        if (!(await waitExit(child, GRACE_MS))) {
          signalGroup(child, "SIGKILL");
          await waitExit(child, GRACE_MS);
        }
      }
    }
    child.stdout?.destroy();
    child.stderr?.destroy();
    this.end();
  }

  /** `onclose` once, whether the server exited or was closed. */
  private end() {
    if (this.ended) return;
    this.ended = true;
    this.onclose?.();
  }
}

/** Calls `onLine` for each newline-terminated line, and for the last unterminated one at the end. */
function lines(stream: NodeJS.ReadableStream, onLine: (line: string) => void, onError: (error: Error) => void) {
  let pending = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    pending += chunk;
    let at = pending.indexOf("\n");
    while (at !== -1) {
      onLine(pending.slice(0, at));
      pending = pending.slice(at + 1);
      at = pending.indexOf("\n");
    }
    if (pending.length > MAX_LINE) {
      pending = "";
      onError(new Error(`A line from the server ran past ${MAX_LINE} bytes and was dropped`));
    }
  });
  stream.on("end", () => {
    if (pending !== "") onLine(pending);
    pending = "";
  });
  stream.on("error", onError);
}
