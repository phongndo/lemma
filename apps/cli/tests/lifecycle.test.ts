import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { settled, startLemma } from "../../../scripts/e2e.ts";
import type { Lemma } from "../../../scripts/e2e.ts";
import { ExitCode, run } from "../src/cli.ts";
import type { Io } from "../src/command.ts";
import { invoke, printOnFailure } from "./invoke.ts";

const cliMain = fileURLToPath(new URL("../src/main.ts", import.meta.url));

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Runs the CLI in-process as `invoke` does, with `fields` on its Io (a terminal to ask at, the command that runs it again). */
const runWith = async (argv: readonly string[], home: string, fields: Partial<Io> = {}) => {
  let out = "";
  const err: string[] = [];
  const code = await run(argv, {
    env: { LEMMA_HOME: home },
    cwd: home,
    out: (text) => void (out += `${text}\n`),
    err: (text) => void err.push(text),
    ...fields,
  });
  return { code, out: out.replace(/\n$/, ""), err: err.join("\n") };
};

describe("a host started in the background", () => {
  let home: string;
  let pid: number | undefined;
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "lemma-cli-serve-"));
    // Any free port, as the end-to-end hosts listen on.
    await writeFile(join(home, "config.jsonc"), JSON.stringify({ plugins: { "transport.server": { config: { port: 0 } } } }));
  });
  afterAll(async () => {
    if (pid !== undefined && alive(pid)) process.kill(pid, "SIGKILL");
    await rm(home, { recursive: true, force: true });
  });
  // What the host printed, for a failure: its log.
  printOnFailure(() => {
    const log = home === undefined ? undefined : join(home, "logs", "host.log");
    return log !== undefined && existsSync(log) ? `${log}:\n${readFileSync(log, "utf8")}` : undefined;
  });

  test("serve --detach returns once it listens; status says the CLI started it; logs prints its log; restart starts it again; stop stops it", async () => {
    const self = [process.execPath, "--conditions=lemma-source", cliMain];
    const started = await runWith(["serve", "--detach", "--json"], home, { self });
    expect(started.code, started.err).toBe(ExitCode.ok);
    const serving = JSON.parse(started.out) as { url: string; pid: number; home: string; log: string };
    pid = serving.pid;
    expect(serving).toMatchObject({ home, log: join(home, "logs", "host.log"), url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/) });
    expect(alive(serving.pid)).toBe(true);

    const status = JSON.parse((await invoke(["status", "--json"], home)).out);
    expect(status).toMatchObject({ environment: "local", url: serving.url, pid: serving.pid, info: { pid: serving.pid, startedBy: "cli", home } });
    expect((await invoke(["status"], home)).out).toMatch(/\nstarted +.*by lemma serve --detach/);

    // One host per home: another start says which runs.
    const again = await runWith(["serve", "--detach", "--json"], home, { self });
    expect(again.code).toBe(ExitCode.failed);
    expect(JSON.parse(again.err).error).toMatchObject({ code: "Running", message: expect.stringContaining(`pid ${serving.pid}`) });

    const logs = JSON.parse((await invoke(["logs", "--json"], home)).out) as { path: string; lines: string[] };
    expect(logs.path).toBe(serving.log);
    expect(logs.lines).toContainEqual(expect.stringMatching(new RegExp(`^lemma: --- \\S+ pid ${serving.pid}, started by cli ---$`)));
    expect(logs.lines).toContainEqual(expect.stringMatching(new RegExp(`^lemma: open ${serving.url}/`)));
    expect((await invoke(["logs", "-n", "1"], home)).out.split("\n")).toHaveLength(1);
    expect(JSON.parse((await invoke(["logs", "-n", "0", "--json"], home)).out)).toMatchObject({ lines: [] });
    expect((await invoke(["logs", "-n", "-5"], home)).code).toBe(ExitCode.usage);

    // Again in the background, on the port it had, for the project it served.
    const restart = await runWith(["restart", "--json"], home, { self });
    expect(restart.code, restart.err).toBe(ExitCode.ok);
    const restarted = JSON.parse(restart.out) as { pid: number };
    pid = restarted.pid;
    expect(restarted).toMatchObject({ restarted: true, url: serving.url, previous: serving.pid, startedBy: "cli", cutOff: [] });
    expect(alive(serving.pid)).toBe(false);
    expect(JSON.parse((await invoke(["status", "--json"], home)).out)).toMatchObject({ pid: restarted.pid, info: { startedBy: "cli", cwd: home } });

    const stopped = await invoke(["stop", "--json"], home);
    expect(stopped.code, stopped.err).toBe(ExitCode.ok);
    expect(JSON.parse(stopped.out)).toEqual({ stopped: true, pid: restarted.pid, startedBy: "cli", cutOff: [] });
    expect(alive(restarted.pid)).toBe(false);
    expect(existsSync(join(home, "transport.json"))).toBe(false);
    expect(JSON.parse((await invoke(["status", "--json"], home)).err).error.code).toBe("NoHost");
    expect(JSON.parse((await invoke(["stop", "--json"], home)).out)).toEqual({ stopped: false, home });
    // Its log stays, ending with its stop.
    expect((await readFile(serving.log, "utf8")).trimEnd().split("\n").at(-1)).toBe("lemma: stopped");
  }, 60_000);

  test("serve without a way to start itself, or for another machine, refuses", async () => {
    expect(JSON.parse((await invoke(["serve", "--detach", "--json"], home)).err).error.code).toBe("Unsupported");
    expect((await invoke(["serve", "--env", "box"], home)).code).toBe(ExitCode.usage);
  });

  test("logs says so when no host has run in a home", async () => {
    const empty = await mkdtemp(join(tmpdir(), "lemma-cli-nolog-"));
    try {
      expect(JSON.parse((await invoke(["logs", "--json"], empty)).err).error.code).toBe("NotFound");
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});

describe("stop with work in progress", () => {
  let lemma: Lemma;
  beforeAll(async () => {
    lemma = await startLemma("lemma-cli-stop-", { plugins: { "agent.loop": { config: { defaultModel: "mock/scripted" } } } });
  }, 30_000);
  afterAll(() => lemma?.stop());
  printOnFailure(() => lemma?.output());

  test("says what it would cut off and refuses, asked at a terminal or not, unless --force", async () => {
    const home = lemma.home;
    const session = (await invoke(["sessions", "new", "--cwd", home], home)).out;
    // A turn that waits on the model until the test is done with it.
    const turn = runWith(["run", session, "ramble on gate:stop"], home);
    await lemma.mock.reached("stop");
    const working = `a turn running in session ${session}`;
    expect(JSON.parse((await invoke(["status", "--json"], home)).out).inProgress).toEqual([
      { id: "agent.turns", title: "Turns", source: "agent.loop", items: [working] },
    ]);

    const refused = await invoke(["stop", "--json"], home);
    expect(refused.code).toBe(ExitCode.failed);
    expect(refused.err).toContain(`Stopping the host cuts off:\n  ${working}`);
    expect(JSON.parse(refused.err.split("\n").at(-1)!).error.code).toBe("Busy");
    const asked: string[] = [];
    const declined = await runWith(["stop"], home, { ask: async (question) => (asked.push(question), "n") });
    expect([declined.code, asked]).toEqual([ExitCode.failed, ["Stop it anyway? [y/N] "]]);
    expect(alive(lemma.host.pid!)).toBe(true);

    const forced = await invoke(["stop", "--force", "--json"], home);
    expect(forced.code, forced.err).toBe(ExitCode.ok);
    expect(JSON.parse(forced.out)).toMatchObject({ stopped: true, pid: lemma.host.pid, cutOff: [working] });
    expect(await settled(async () => lemma.host.exitCode !== null || lemma.host.signalCode !== null || undefined)).toBe(true);

    // The run it cut off says so, and how to rejoin it once a host runs again rather than send its prompt twice.
    const cut = await turn;
    expect(cut.code).toBe(ExitCode.unavailable);
    // In the session it ran in, with its prompt quoted for the shell.
    expect(cut.err).toMatch(/run `lemma run \S+ 'ramble on gate:stop' --request-id \S+` to rejoin it/);
  }, 60_000);
});
