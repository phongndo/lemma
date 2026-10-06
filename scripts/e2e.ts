import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/*
 * What the CLI's and the examples' end-to-end tests run Lemma with: a home in
 * the OS temp directory, the scripted provider (mock-openai.ts), and a real
 * host using it. Each process listens on a port it picks itself and says when
 * it is ready, so nothing waits a fixed time or probes for a free port; what
 * they print is kept for the failure that needs it. A plain module: tests
 * import it by its path.
 */

const hostMain = fileURLToPath(new URL("../packages/host/src/main.ts", import.meta.url));
const mockProvider = fileURLToPath(new URL("mock-openai.ts", import.meta.url));

/** Calls `read` until `until` accepts what it returns (a throw is "not yet"), or `timeout` ms pass: then undefined. */
export const settled = async <A>(read: () => Promise<A | undefined>, until: (value: A) => boolean = () => true, timeout = 10_000): Promise<A | undefined> => {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      const value = await read();
      if (value !== undefined && until(value)) return value;
    } catch {
      /* not yet */
    }
    if (Date.now() > deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

/** A Node.js process whose output (stdout and stderr) is kept as lines. */
interface Watched {
  readonly child: ChildProcess;
  /** The first line, printed already or to come, that `pattern` matches; rejects, with the output, if the process ends or `timeout` ms pass first. */
  readonly line: (pattern: RegExp, timeout?: number) => Promise<RegExpExecArray>;
  readonly output: () => string;
}

const launch = (name: string, args: readonly string[], env: Readonly<Record<string, string>>): Watched => {
  const child = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: "pipe" });
  const lines: string[] = [];
  let ended = false;
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on("line", (line) => {
      lines.push(line);
      changed();
    });
  }
  // After its output is read to the end, unlike `exit`.
  child.on("close", () => {
    ended = true;
    changed();
  });
  const output = () =>
    `${name} (pid ${child.pid}${ended ? `, ended: ${child.exitCode ?? child.signalCode}` : ""}) printed:\n${lines.map((line) => `  ${line}`).join("\n")}`;
  const line = (pattern: RegExp, timeout = 20_000) =>
    new Promise<RegExpExecArray>((resolve, reject) => {
      const timer = setTimeout(() => finish(() => reject(new Error(`${name} did not print ${pattern} within ${timeout} ms; ${output()}`))), timeout);
      const finish = (settle: () => void) => {
        clearTimeout(timer);
        listeners.delete(check);
        settle();
      };
      const check = () => {
        for (const printed of lines) {
          const match = pattern.exec(printed);
          if (match !== null) return finish(() => resolve(match));
        }
        if (ended) finish(() => reject(new Error(`${name} ended before printing ${pattern}; ${output()}`)));
      };
      listeners.add(check);
      check();
    });
  return { child, line, output };
};

const stop = async (child: ChildProcess) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await exited;
};

/** The scripted provider, pacing nothing: a test holds an answer with a gate instead (see mock-openai.ts). */
export interface Mock {
  /** Its base URL, `http://127.0.0.1:<port>/v1`. */
  readonly url: string;
  /** Resolves once a ramble waits at the gate `name` (its prompt says `gate:<name>`). */
  readonly reached: (name: string) => Promise<void>;
  /** Opens the gate `name`: the ramble waiting there goes on, and later ones pass it. */
  readonly open: (name: string) => void;
}

export interface LemmaOptions {
  /** Plugin rows for the config, besides the transport's (port 0) and the llm's (the provider as `mock/scripted`). */
  readonly plugins?: Readonly<Record<string, unknown>>;
  /** Runs before the host starts: to put a plugin file in the home, say. */
  readonly prepare?: (home: string) => Promise<void>;
}

export interface Lemma {
  readonly home: string;
  readonly mock: Mock;
  /** The host started last. */
  readonly host: ChildProcess;
  /** Starts a host in the home again, once the last one has exited (or was killed). */
  readonly restart: () => Promise<ChildProcess>;
  /** What the provider and each host printed, for a failure message. */
  readonly output: () => string;
  /** Stops the processes and removes the home. */
  readonly stop: () => Promise<void>;
}

/** A home under the OS temp directory (named from `prefix`) with a host running in it, its provider the scripted one. */
export const startLemma = async (prefix: string, options: LemmaOptions = {}): Promise<Lemma> => {
  const home = await mkdtemp(join(tmpdir(), prefix));
  const processes: Watched[] = [];
  const hosts: ChildProcess[] = [];
  const output = () => processes.map((watched) => watched.output()).join("\n");
  const stopAll = async () => {
    await Promise.all(processes.map((watched) => stop(watched.child)));
    await rm(home, { recursive: true, force: true });
  };
  const startHost = async () => {
    const host = launch("host", ["--conditions=lemma-source", hostMain, "--no-open"], { LEMMA_HOME: home, INIT_CWD: home });
    processes.push(host);
    hosts.push(host.child);
    // Printed once it runs, after reading the transport.json its transport wrote (a killed host's is left behind).
    await host.line(/^lemma: open /);
    return host.child;
  };
  try {
    const provider = launch("mock-openai", [mockProvider], { PORT: "0", PACE_MS: "0" });
    processes.push(provider);
    const url = (await provider.line(/listening on (\S+)/))[1]!;
    const mock: Mock = {
      url,
      reached: async (name) => {
        await provider.line(new RegExp(`^waiting ${name}$`));
      },
      open: (name) => {
        provider.child.stdin!.write(`open ${name}\n`);
      },
    };
    await writeFile(
      join(home, "config.jsonc"),
      JSON.stringify({
        plugins: {
          transport: { config: { port: 0 } },
          llm: { config: { providers: [{ id: "mock", api: "openai-completions", baseUrl: url, models: [{ id: "scripted" }] }] } },
          ...options.plugins,
        },
      }),
    );
    await options.prepare?.(home);
    await startHost();
    return {
      home,
      mock,
      get host() {
        return hosts.at(-1)!;
      },
      restart: startHost,
      output,
      stop: stopAll,
    };
  } catch (error) {
    await stopAll();
    throw error;
  }
};
