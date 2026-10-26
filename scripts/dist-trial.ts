import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { settled } from "./e2e.ts";

/*
 * Where the release checks (dist-check.ts, dist-desktop-check.ts) run a release as a user's machine would: outside the
 * checkout, in a home and a project of their own, their paths with spaces and quotes as a user's may have, with a
 * `node` on PATH that fails, and the scripted provider (mock-openai.ts) for a model, so no API key. What a release's
 * host does once it serves the project, whichever way it was installed, is checked here for both.
 */

const root = fileURLToPath(new URL("..", import.meta.url));

/** Variables over the trial's environment; an undefined one is left out. */
type Variables = Readonly<Record<string, string | undefined>>;

/** A process the trial started, which runs until the trial stops it. */
export interface Launched {
  readonly child: ChildProcess;
  /** What it has printed, stdout and stderr. */
  readonly output: () => string;
  /** The match once its output matches `pattern`; fails after a minute. */
  readonly ready: (pattern: RegExp) => Promise<RegExpExecArray>;
}

export interface Trial {
  readonly temporary: string;
  /** The working directory of everything it runs: a git repository once `provide` makes it one. */
  readonly project: string;
  readonly home: string;
  /** `<home>/.lemma`, its LEMMA_HOME. */
  readonly lemmaHome: string;
  /** The environment everything runs in, which a check adds to before running what needs it. */
  readonly env: NodeJS.ProcessEnv;
  /** Runs `file` to its end, failing unless it exits `expected`; its stdout. */
  readonly command: (file: string, args: readonly string[], expected?: number, variables?: Variables) => Promise<string>;
  /** Starts `file`, to run until the trial stops it: then SIGTERM, and SIGKILL after `stopWithin` ms. */
  readonly launch: (file: string, args: readonly string[], options?: { readonly variables?: Variables; readonly stopWithin?: number }) => Launched;
  /** The project's file for the search to find, and the scripted provider as the host's model: before a host starts. */
  readonly provide: () => Promise<void>;
  /**
   * Fails unless the host serving the project, reached by the release's `lemma`, runs each plugin turned on, serves the
   * web app, finds a file natively, names to the agent a CLI that runs, and runs an agent's turn that runs a tool. Its
   * plugins, for a check to say more of.
   */
  readonly checkHost: (lemma: string, version: string) => Promise<readonly { readonly id: string; readonly state: string }[]>;
  /** Stops each process still running, the last started first. */
  readonly stop: () => Promise<void>;
  /** Stops them, then removes the trial's files. */
  readonly close: () => Promise<void>;
}

export const startTrial = async (name: string): Promise<Trial> => {
  const temporary = await mkdtemp(join(tmpdir(), `lemma-${name}-`));
  const project = join(temporary, "a project");
  const home = join(temporary, "home");
  const lemmaHome = join(home, ".lemma");
  const stubs = join(temporary, "stubs");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    LEMMA_HOME: lemmaHome,
    LEMMA_OUTPUT: "text",
    // A `node` that fails: the release runs on its own runtime, and so does the CLI it names to the agent.
    PATH: `${stubs}:${process.env.PATH ?? "/usr/bin:/bin"}`,
  };
  // What the shell running the check may set that would take the release elsewhere: a host, a profile, a project.
  for (const variable of ["LEMMA_URL", "LEMMA_TOKEN", "LEMMA_ENV", "LEMMA_PROFILE", "LEMMA_WEB_URL", "INIT_CWD", "ELECTRON_RUN_AS_NODE", "NODE_OPTIONS"]) {
    delete env[variable];
  }
  for (const dir of [project, stubs, lemmaHome]) await mkdir(dir, { recursive: true });
  await writeFile(join(stubs, "node"), "#!/bin/sh\necho 'lemma ran the node on PATH' >&2\nexit 99\n");
  await chmod(join(stubs, "node"), 0o755);

  const started: { readonly child: ChildProcess; readonly stopWithin: number }[] = [];
  const withVariables = (variables: Variables): NodeJS.ProcessEnv =>
    Object.fromEntries(Object.entries({ ...env, ...variables }).filter(([, value]) => value !== undefined));

  const command: Trial["command"] = async (file, args, expected = 0, variables = {}) => {
    const child = spawn(file, args, { cwd: project, env: withVariables(variables), stdio: ["ignore", "pipe", "pipe"], timeout: 90_000 });
    started.push({ child, stopWithin: 10_000 });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    const [code] = await once(child, "close");
    assert.equal(code, expected, `${file} ${args.join(" ")} exited ${code}:\n${out}\n${err}`);
    return out;
  };

  const launch: Trial["launch"] = (file, args, { variables = {}, stopWithin = 10_000 } = {}) => {
    const child = spawn(file, args, { cwd: project, env: withVariables(variables), stdio: ["ignore", "pipe", "pipe"] });
    started.push({ child, stopWithin });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    return {
      child,
      output: () => output,
      ready: async (pattern) => {
        const match = await settled(async () => pattern.exec(output) ?? undefined, undefined, 60_000);
        assert.ok(match, `${basename(file)} did not print ${pattern}:\n${output}`);
        return match;
      },
    };
  };

  const provide: Trial["provide"] = async () => {
    await command("git", ["init", "--quiet"]);
    await writeFile(join(project, "needle.txt"), "what the file search finds\n");
    await command("git", ["add", "needle.txt"]);
    const mock = launch(process.execPath, [join(root, "scripts/mock-openai.ts")], { variables: { PORT: "0", PACE_MS: "0", PATH: process.env.PATH } });
    const provider = (await mock.ready(/listening on (\S+)/))[1]!;
    await writeFile(
      join(lemmaHome, "config.jsonc"),
      JSON.stringify({
        plugins: {
          "transport.server": { config: { port: 0 } },
          "llm.pi-ai": { config: { providers: [{ id: "mock", api: "openai-completions", baseUrl: provider, models: [{ id: "scripted" }] }] } },
        },
      }),
    );
  };

  const checkHost: Trial["checkHost"] = async (lemma, version) => {
    const status = JSON.parse(await command(lemma, ["status", "--json"])) as { plugins: readonly { id: string; state: string }[] };
    const failed = status.plugins.filter((plugin) => plugin.state !== "active" && plugin.state !== "disabled").map(({ id, state }) => `${id}: ${state}`);
    assert.deepEqual(failed, [], "every plugin turned on runs");

    const { url } = JSON.parse(await readFile(join(lemmaHome, "transport.json"), "utf8")) as { url: string };
    const page = await fetch(url);
    assert.equal(page.status, 200);
    const script = /<script[^>]+src="([^"]+\.js)"/.exec(await page.text())?.[1];
    assert.ok(script, "the host serves the web app");
    assert.equal((await fetch(new URL(script, url))).status, 200);

    const found = await settled(async () => ((await command(lemma, ["workspace", "files", "needle"])).includes("needle.txt") ? true : undefined));
    assert.ok(found, "the native file search finds a file");

    const cli = (JSON.parse(await command(lemma, ["plugins", "config", "agent.loop", "--json"])) as { values: { cli: string } }).values.cli;
    assert.equal((await command("sh", ["-c", `${cli} --version`])).trim(), version, "the CLI named to the agent runs");

    const turn = (await command(lemma, ["run", "new", "check the shell", "--model", "mock/scripted", "--follow", "--json"])).trim().split("\n");
    assert.ok(
      turn.some((line) => line.includes("hello from lemma")),
      "the turn's tool ran",
    );
    // The desktop app's lemma runs on its Electron as Node.js, without the shell's NODE_OPTIONS (scripts/dist-desktop.ts):
    // the agent's shells run as the shell that started the host would.
    assert.ok(
      turn.some((line) => line.includes("ELECTRON_RUN_AS_NODE=unset")),
      "the agent's shell is not told to run Electron as Node.js",
    );
    const nodeOptions = `NODE_OPTIONS=${env.NODE_OPTIONS || "unset"}`;
    assert.ok(
      turn.some((line) => line.includes(nodeOptions)),
      `the agent's shell has ${nodeOptions}, as the host was started with`,
    );
    assert.deepEqual(
      (({ type, reason, toolCalls }) => ({ type, reason, toolCalls }))(JSON.parse(turn.at(-1)!)),
      { type: "result", reason: "done", toolCalls: 1 },
      "the turn ended",
    );
    return status.plugins;
  };

  const stop: Trial["stop"] = async () => {
    for (const { child, stopWithin } of started.splice(0).reverse()) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const closed = once(child, "close");
      child.kill("SIGTERM");
      const deadline = setTimeout(() => child.kill("SIGKILL"), stopWithin);
      await closed;
      clearTimeout(deadline);
    }
  };

  const close: Trial["close"] = async () => {
    await stop();
    await rm(temporary, { recursive: true, force: true });
  };

  return { temporary, project, home, lemmaHome, env, command, launch, provide, checkHost, stop, close };
};
