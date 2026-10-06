import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * End-to-end runs against a real host: the scripted provider, and a host
 * whose models come from it, for the CLI's tests and the examples'.
 */

const hostMain = fileURLToPath(new URL("../packages/host/src/main.ts", import.meta.url));
const mockProvider = fileURLToPath(new URL("mock-openai.ts", import.meta.url));

/** The scripted provider (`mock-openai.ts`) on a port of its own: resolves with its base URL once it listens. */
export const startMockProvider = (): Promise<{ readonly baseUrl: string; readonly process: ChildProcess }> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [mockProvider], { env: { ...process.env, PORT: "0" }, stdio: ["ignore", "pipe", "inherit"] });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`mock-openai exited with ${code}`)));
    child.stdout!.once("data", (chunk) => {
      const baseUrl = /http:\/\/\S+/.exec(String(chunk))?.[0];
      if (baseUrl === undefined) reject(new Error(`mock-openai said ${String(chunk)}`));
      else resolve({ baseUrl, process: child });
    });
  });

/** A config whose models come from the scripted provider (`mock/scripted`) and whose transport takes a free port, with more rows from `plugins`. */
export const mockConfig = (baseUrl: string, plugins: Readonly<Record<string, unknown>> = {}) => ({
  plugins: {
    transport: { config: { port: 0 } },
    llm: { config: { providers: [{ id: "mock", api: "openai-completions", baseUrl, models: [{ id: "scripted" }] }] } },
    ...plugins,
  },
});

/** A host in `home` (its `LEMMA_HOME` and project): resolves once it has written its own transport.json, as a killed host's may still be there. */
export const startHost = async (home: string): Promise<ChildProcess> => {
  const host = spawn(process.execPath, ["--conditions=lemma-source", hostMain, "--no-open"], {
    env: { ...process.env, LEMMA_HOME: home, INIT_CWD: home },
    stdio: "ignore",
  });
  const deadline = Date.now() + 20_000;
  for (;;) {
    const entry = await readFile(join(home, "transport.json"), "utf8").then(
      (text) => JSON.parse(text) as { readonly pid?: number },
      () => undefined,
    );
    if (entry?.pid === host.pid) return host;
    if (Date.now() > deadline || host.exitCode !== null) throw new Error("host did not start");
    await new Promise((done) => setTimeout(done, 100));
  }
};

/** Stops `host` and waits for it to exit; nothing to do once it has. */
export const stopHost = async (host: ChildProcess): Promise<void> => {
  if (host.exitCode !== null || host.signalCode !== null) return;
  const exited = new Promise((done) => host.once("exit", done));
  host.kill("SIGTERM");
  await exited;
};
