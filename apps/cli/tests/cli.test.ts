import { execFileSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ledger, promptDiff, trajectory } from "@lemma/contracts";
import type { SessionEvent, SessionInfo } from "@lemma/contracts";
import { ExitCode, parseOffset, run } from "../src/cli.ts";
import { toAnswer } from "../src/live.ts";
import { mockConfig, startHost, startMockProvider, stopHost } from "../../../scripts/e2e.ts";
import { formatDiff, formatPlugins, formatQuestions, formatRecords, formatSession, formatStep, formatSystem, formatTrajectory } from "../src/format.ts";

const invoke = async (argv: readonly string[], home: string, cwd = "/", env: Readonly<Record<string, string>> = {}) => {
  let out = "";
  const err: string[] = [];
  const code = await run(argv, {
    env: { LEMMA_HOME: home, ...env },
    cwd,
    out: (text) => {
      out += `${text}\n`;
    },
    write: (text) => {
      out += text;
    },
    err: (text) => err.push(text),
  });
  return { code, out: out.replace(/\n$/, ""), err: err.join("\n") };
};

/** Retries `read` until it answers without throwing, while a restarting transport comes back (a new port here) and rewrites transport.json. */
const settled = async <A>(read: () => Promise<A | undefined>, until: (value: A) => boolean = () => true): Promise<A | undefined> => {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const value = await read();
      if (value !== undefined && until(value)) return value;
    } catch {
      /* not back yet */
    }
    if (Date.now() > deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

const freePort = () =>
  new Promise<number>((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });

describe("without a host", () => {
  let home: string;
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "lemma-cli-"));
  });
  afterAll(() => rm(home, { recursive: true, force: true }));

  test("reports a missing host as unavailable", async () => {
    const result = await invoke(["status", "--json"], home);
    expect(result.code).toBe(ExitCode.unavailable);
    expect(JSON.parse(result.err).error.code).toBe("NoHost");
  });

  test("rejects bad usage before connecting", async () => {
    for (const argv of [
      [],
      ["bogus"],
      ["status", "extra"],
      ["session", "show"],
      ["session", "list", "--all", "--cwd", "/x"],
      ["--nope"],
      ["inspect", "s", "--system"],
      ["inspect", "s", "--request", "1", "--system", "--diff"],
      ["inspect", "s", "--request", "1", "--records"],
      ["inspect", "s", "--request", "1", "--step", "2"],
      ["inspect", "s", "--sort", "bogus"],
      ["inspect", "s", "--range", "5"],
      ["run"],
      ["run", "s"],
      ["run", "s", "hi", "--thinking", "huge"],
      ["answer", "q"],
      ["login"],
      ["logout"],
      ["cancel"],
      ["workspace", "checkout"],
      ["workspace", "nope"],
      ["workspace", "files", "--limit", "0"],
      ["session", "title", "s"],
      ["session", "checkout", "s"],
      ["events", "x"],
      ["events", "--questions", "maybe"],
      ["plugins", "config"],
      ["plugins", "show"],
      ["plugins", "config", "agent", "maxSteps"],
      ["plugins", "config", "agent", "maxSteps", "5", "--unset"],
      ["ui", "bogus"],
      ["ui", "enable"],
      ["ui", "config", "theme"],
      ["ui", "config", "theme", "accent"],
      ["remote", "bogus"],
      ["remote", "clear", "x"],
      ["remote", "set"],
      ["remote", "set", "https://box.example.ts.net/lemma", "--token", "t"],
      ["remote", "set", "ftp://box.example.ts.net", "--token", "t"],
      ["remote", "set", "https://box.example.ts.net?token=t", "--token", "t"],
      ["remote", "set", "https://box.example.ts.net", "x", "--token", "t"],
      // No token, and no terminal to ask at.
      ["remote", "set", "https://box.example.ts.net"],
      ["token", "x"],
    ]) {
      expect((await invoke(argv, home)).code, argv.join(" ")).toBe(ExitCode.usage);
    }
    // LEMMA_URL names the host only together with its token.
    expect((await invoke(["status"], home, "/", { LEMMA_URL: "https://box.example.ts.net" })).code).toBe(ExitCode.usage);
    expect((await invoke(["remote"], home, "/", { LEMMA_URL: "box", LEMMA_TOKEN: "t" })).code).toBe(ExitCode.usage);
  });

  test("remote and token say there is no host, without one", async () => {
    expect(JSON.parse((await invoke(["remote", "--json"], home)).out)).toMatchObject({ source: "local", tokenSet: false });
    expect((await invoke(["remote"], home)).out).toContain("No remote host is set and no local host runs");
    const token = await invoke(["token", "--json"], home);
    expect(token.code).toBe(ExitCode.unavailable);
    expect(JSON.parse(token.err).error.code).toBe("NoHost");
  });

  test("prints help", async () => {
    const result = await invoke(["--help"], home);
    expect(result.code).toBe(ExitCode.ok);
    expect(result.out).toContain("session show <id>");
  });
});

describe("against a running host", () => {
  let home: string;
  let host: ChildProcess;
  let mock: ChildProcess;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "lemma-cli-"));
    // A scripted provider: a prompt gets a bash call, the tool result gets a streamed answer.
    const provider = await startMockProvider();
    mock = provider.process;
    await writeFile(join(home, "config.jsonc"), JSON.stringify(mockConfig(provider.baseUrl)));
    host = await startHost(home);
  }, 30_000);

  afterAll(async () => {
    mock.kill();
    await stopHost(host);
    await rm(home, { recursive: true, force: true });
  });

  test("status reports the composition", async () => {
    const result = await invoke(["status", "--json"], home);
    expect(result.code).toBe(ExitCode.ok);
    const status = JSON.parse(result.out);
    expect(status.info.home).toBe(home);
    expect(status.plugins.map((plugin: { id: string }) => plugin.id)).toContain("agent");
    expect(status.plugins.every((plugin: { state: string }) => plugin.state === "active")).toBe(true);
    expect(status.running).toEqual([]);
  });

  test("run sends a prompt and prints the reply; --follow --json streams events and ends with the result", async () => {
    const session = (await invoke(["session", "new", "--cwd", home], home)).out;
    expect(await invoke(["session", "title", session, "CLI", "test"], home)).toMatchObject({ code: ExitCode.ok, out: `${session}  CLI test` });
    expect(await invoke(["session", "pin", session], home)).toMatchObject({ code: ExitCode.ok, out: `${session}  pinned` });
    expect(await invoke(["session", "archive", session], home)).toMatchObject({ code: ExitCode.ok, out: `${session}  archived` });
    expect((await invoke(["session", "list", "--all"], home)).out).toContain("CLI test [pinned] [archived]");
    expect(await invoke(["session", "unarchive", session], home)).toMatchObject({ code: ExitCode.ok, out: `${session}  unarchived` });
    const doomed = (await invoke(["session", "new", "--cwd", home], home)).out;
    expect(await invoke(["session", "delete", doomed], home)).toMatchObject({ code: ExitCode.ok, out: `${doomed}  deleted` });
    expect((await invoke(["session", "list", "--all"], home)).out).not.toContain(doomed);

    const plain = await invoke(["run", session, "check", "the", "shell", "--model", "mock/scripted"], home);
    expect(plain.code).toBe(ExitCode.ok);
    expect(plain.out).toContain("Everything works end to end.");
    expect(plain.out).toMatch(/── turn done · 2 steps · 1 tool call/);

    const followed = await invoke(["run", session, "again", "--model", "mock/scripted", "--follow", "--json"], home);
    const lines = followed.out.split("\n").map((line) => JSON.parse(line));
    expect(lines.some((event) => event.type === "turn-started")).toBe(true);
    expect(lines.some((event) => event.type === "delta" && event.event.type === "toolcall-end")).toBe(true);
    // The command's output also streams live (order across event kinds is not guaranteed, so only its arrival is checked).
    expect(lines.some((event) => event.type === "tool-output" && event.chunk.includes("hello from lemma"))).toBe(true);
    expect(lines.at(-1)).toMatchObject({ type: "result", session, reason: "done", steps: 2, toolCalls: 1 });

    const tools = JSON.parse((await invoke(["inspect", session, "--filter", "kind:tool", "--json"], home)).out);
    expect(tools.map((record: { tool: string; status: string }) => [record.tool, record.status])).toEqual([
      ["bash", "ok"],
      ["bash", "ok"],
    ]);
    // The host consumes the INIT_CWD it was started with, so a CLI the agent runs uses the agent's directory.
    expect(JSON.stringify(tools)).toContain("INIT_CWD=unset");
    expect(JSON.parse((await invoke(["inspect", session, "--records", "--sort", "duration", "--desc", "--json"], home)).out)[0].kind).toBe("assistant");
    expect((await invoke(["cancel", session], home)).code).toBe(ExitCode.ok);
  }, 30_000);

  test("a prompt sent while a turn runs is queued or steers it; a queued one can be withdrawn; a request id sends it once", async () => {
    const session = (await invoke(["session", "new", "--cwd", home], home)).out;
    const first = invoke(["run", session, "ramble on", "--model", "mock/scripted", "--json"], home);
    await settled(
      async () => JSON.parse((await invoke(["status", "--json"], home)).out).running as string[],
      (running) => running.includes(session),
    );
    const queued = invoke(["run", session, "afterwards", "--request-id", "q1", "--json"], home);
    const listed = await settled(
      async () => JSON.parse((await invoke(["queue", session, "--json"], home)).out) as { requestId: string; mode: string }[],
      (queue) => queue.some((item) => item.requestId === "q1"),
    );
    expect(listed).toEqual([expect.objectContaining({ requestId: "q1", mode: "follow-up" })]);
    expect((await invoke(["queue", session], home)).out).toMatch(/follow-up\s+q1\s+\S+\s+afterwards/);
    expect((await invoke(["withdraw", session, "q1"], home)).code).toBe(ExitCode.ok);
    const withdrawn = await queued;
    expect(withdrawn.code).toBe(ExitCode.failed);
    expect(JSON.parse(withdrawn.err).error.code).toBe("Withdrawn");
    expect((await invoke(["withdraw", session, "q1", "--json"], home)).code).toBe(ExitCode.failed);

    // A steer joins the running turn: both runs report that one turn.
    const steered = invoke(["run", session, "also check the shell", "--steer", "--request-id", "s1", "--json"], home);
    const [ramble, steer] = await Promise.all([first, steered]);
    expect(ramble.code).toBe(ExitCode.ok);
    expect(steer.code).toBe(ExitCode.ok);
    const turn = JSON.parse(ramble.out).turn as string;
    expect(JSON.parse(steer.out)).toMatchObject({ turn, reason: "done", toolCalls: 1 });
    // The same request id again reports that turn instead of placing the prompt twice.
    expect(JSON.parse((await invoke(["run", session, "also check the shell", "--request-id", "s1", "--json"], home)).out).turn).toBe(turn);
    const { branch } = JSON.parse((await invoke(["session", "show", session, "--json"], home)).out) as { branch: { data: { type: string } }[] };
    expect(branch.filter((event) => event.data.type === "turn-start")).toHaveLength(1);
    expect((await invoke(["run", session, "x", "--steer", "--when-busy", "reject"], home)).code).toBe(ExitCode.usage);
  }, 30_000);

  test("a retried run reports the turn that placed its prompt, even after a checkout left it off the branch", async () => {
    const session = (await invoke(["session", "new", "--cwd", home], home)).out;
    const first = JSON.parse((await invoke(["run", session, "first", "--request-id", "b1", "--json"], home)).out);
    const second = JSON.parse((await invoke(["run", session, "second", "--request-id", "b2", "--json"], home)).out);
    expect(second.turn).not.toBe(first.turn);
    const { branch } = JSON.parse((await invoke(["session", "show", session, "--json"], home)).out) as {
      branch: { id: string; data: Record<string, unknown> }[];
    };
    const firstEnd = branch.find((event) => event.data.type === "turn-end" && event.data.turnId === first.turn)!;
    expect((await invoke(["session", "checkout", session, firstEnd.id], home)).code).toBe(ExitCode.ok);
    const retried = JSON.parse((await invoke(["run", session, "second", "--request-id", "b2", "--json"], home)).out);
    expect(retried).toMatchObject({ turn: second.turn, reason: "done", text: second.text });
  }, 30_000);

  test("a retried run --follow shows the turn that placed its prompt: its answer when done, all of it when running", async () => {
    const session = (await invoke(["session", "new", "--cwd", home], home)).out;
    const done = await invoke(["run", session, "check the shell", "--request-id", "d1", "--follow"], home);
    expect(done.out).toContain("Everything works end to end.");
    const again = await invoke(["run", session, "check the shell", "--request-id", "d1", "--follow"], home);
    expect(again.code).toBe(ExitCode.ok);
    expect(again.out).toContain("Everything works end to end.");

    // Retried while it runs: what it said before the retry, then the rest as it comes, once each, in order.
    const running = invoke(["run", session, "ramble on", "--request-id", "r1"], home);
    await settled(
      async () => JSON.parse((await invoke(["status", "--json"], home)).out).running as string[],
      (ids) => ids.includes(session),
    );
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const joined = await invoke(["run", session, "ramble on", "--request-id", "r1", "--follow"], home);
    expect(joined.code).toBe(ExitCode.ok);
    const words = [...joined.out.matchAll(/word(\d+)/g)].map((match) => Number(match[1]));
    expect(words).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
    expect((await running).code).toBe(ExitCode.ok);
  }, 30_000);

  test("lists providers, models, and open questions", async () => {
    expect(JSON.parse((await invoke(["models", "--json"], home)).out).map((model: { ref: string }) => model.ref)).toEqual(["mock/scripted"]);
    expect(JSON.parse((await invoke(["providers", "--json"], home)).out).some((provider: { id: string }) => provider.id === "mock")).toBe(true);
    expect(await invoke(["questions"], home)).toMatchObject({ code: ExitCode.ok, out: "No open questions." });
    expect((await invoke(["answer", "nope", "yes", "--json"], home)).code).toBe(ExitCode.failed);
  });

  test("session list is scoped to a directory unless --all", async () => {
    const empty = await mkdtemp(join(tmpdir(), "lemma-cli-empty-"));
    try {
      expect(await invoke(["session", "list"], home, empty)).toMatchObject({ code: ExitCode.ok, out: `No sessions in ${empty}.` });
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
    expect(JSON.parse((await invoke(["session", "list", "--all", "--json"], home)).out)).toBeInstanceOf(Array);
  });

  test("open prints the web app's address for a session, with the token", async () => {
    const session = JSON.parse((await invoke(["session", "new", "--json"], home)).out).id as string;
    const { url } = JSON.parse((await invoke(["open", session, "trajectory", "--json"], home)).out) as { url: string };
    const address = new URL(url);
    expect(address.pathname).toBe(`/threads/${encodeURIComponent(session)}/trajectory`);
    expect(address.searchParams.get("token")).toBeTruthy();
    expect(new URL(JSON.parse((await invoke(["open", "--json"], home)).out).url).pathname).toBe("/");
    expect(JSON.parse((await invoke(["open", "missing", "--json"], home)).err).error).toMatchObject({ code: "NotFound" });
  });

  test("a domain error keeps the host's code", async () => {
    const result = await invoke(["session", "show", "missing", "--json"], home);
    expect(result.code).toBe(ExitCode.failed);
    expect(JSON.parse(result.err).error).toMatchObject({ code: "NotFound", subject: "missing" });
  });

  test("restart and reload go through the host", async () => {
    expect(JSON.parse((await invoke(["plugins", "restart", "project-context", "--json"], home)).out)).toEqual({ restarted: "project-context" });
    expect(JSON.parse((await invoke(["plugins", "restart", "project-context", "--force", "--json"], home)).out)).toEqual({ restarted: "project-context" });
    expect(await invoke(["reload"], home)).toMatchObject({ code: ExitCode.ok, out: "nothing changed" });
  });

  test("disable and enable write the config that decides, refuse locked plugins, and undo rejected changes", async () => {
    const userConfig = join(home, "config.jsonc");
    const projectConfig = join(home, ".lemma", "config.jsonc");
    const original = await readFile(userConfig, "utf8");
    const rows = async (path: string) => JSON.parse(await readFile(path, "utf8")).plugins;
    const find = async (id: string) => JSON.parse((await invoke(["plugins", "--json"], home)).out).find((plugin: { id: string }) => plugin.id === id);
    try {
      const off = await invoke(["plugins", "disable", "project-context", "--json"], home);
      expect(off.code).toBe(ExitCode.ok);
      expect(JSON.parse(off.out)).toMatchObject({ disabled: "project-context", stopped: ["project-context"] });
      expect((await rows(userConfig))["project-context"]).toEqual({ enabled: false });
      expect(await find("project-context")).toMatchObject({ enabled: false, state: "disabled", scope: "user", source: "bundled" });
      expect(await find("llm")).toMatchObject({ enabled: true, state: "active", locked: "Needed by transport" });
      expect((await invoke(["plugins"], home)).out).toContain("off in the user config");

      // A pinned plugin, and one a pinned plugin needs, refuse; the file is left as it was.
      const pinned = await invoke(["plugins", "disable", "transport", "--json"], home);
      expect(pinned.code).toBe(ExitCode.failed);
      expect(JSON.parse(pinned.err).error).toMatchObject({ code: "ReloadError", subject: "transport" });
      const locked = await invoke(["plugins", "disable", "llm", "--json"], home);
      expect(locked.code).toBe(ExitCode.failed);
      expect(JSON.parse(locked.err).error).toMatchObject({ code: "ReloadError", subject: "llm" });
      expect(JSON.parse(locked.err).error.message).toContain("Needed by transport");
      expect((await rows(userConfig)).transport).toEqual({ config: { port: 0 } });
      expect((await rows(userConfig)).llm.enabled).toBeUndefined();
      // Nor can a plugin the host depends on be restarted by force while it runs; a failed one still can.
      const forced = await invoke(["plugins", "restart", "llm", "--force", "--json"], home);
      expect(forced.code).toBe(ExitCode.failed);
      expect(JSON.parse(forced.err).error).toMatchObject({ code: "ReloadError", subject: "llm" });
      expect(JSON.parse(forced.err).error.message).toContain("cannot be restarted while running");

      // The project file is only written for a trusted project.
      const untrusted = await invoke(["plugins", "disable", "bash", "--project", "--json"], home);
      expect(untrusted.code).toBe(ExitCode.failed);
      expect(JSON.parse(untrusted.err).error.message).toContain("not a trusted project");
      expect(existsSync(projectConfig)).toBe(false);

      // Trusted: a project row overrides the user row, so enabling there writes an explicit true.
      await writeFile(userConfig, JSON.stringify({ ...JSON.parse(await readFile(userConfig, "utf8")), trustedProjects: [home] }));
      expect(await invoke(["reload"], home)).toMatchObject({ code: ExitCode.ok });
      expect(JSON.parse((await invoke(["plugins", "disable", "bash", "--json"], home)).out)).toMatchObject({ stopped: ["bash"] });
      const overridden = await invoke(["plugins", "enable", "bash", "--project", "--json"], home);
      expect(JSON.parse(overridden.out)).toMatchObject({ enabled: "bash", started: ["bash"] });
      expect((await rows(projectConfig)).bash).toEqual({ enabled: true });
      expect(await find("bash")).toMatchObject({ enabled: true, state: "active", scope: "project" });

      const on = await invoke(["plugins", "enable", "project-context", "--json"], home);
      expect(JSON.parse(on.out)).toMatchObject({ enabled: "project-context", started: ["project-context"] });
      expect((await rows(userConfig))["project-context"]).toBeUndefined();
    } finally {
      await rm(join(home, ".lemma"), { recursive: true, force: true });
      await writeFile(userConfig, original);
      await invoke(["reload"], home);
    }
  });

  test("plugins show prints a plugin's wiring: who provides, who uses, and the hooks and events it takes part in", async () => {
    const shown = await invoke(["plugins", "show", "agent"], home);
    expect(shown.code).toBe(ExitCode.ok);
    expect(shown.out).toContain("Agent  used by transport");
    expect(shown.out).toContain("Llm  from llm");
    // What a plugin adds to other plugins' registries: bash its tool.
    expect((await invoke(["plugins", "show", "bash"], home)).out).toContain("Contributes\n  lemma/tools  bash");
    const transport = JSON.parse((await invoke(["plugins", "show", "transport", "--json"], home)).out);
    expect(transport.observes).toEqual(expect.arrayContaining(["lemma/session.appended", "lemma/notice"]));
    expect(transport.hooks).toEqual(expect.arrayContaining([expect.objectContaining({ name: "lemma/interaction.request" })]));
    expect(JSON.parse((await invoke(["plugins", "show", "nope", "--json"], home)).err).error.code).toBe("NotFound");
  });

  test("kernel shows the host as its core runs it: capabilities, hook chains, registries, and events", async () => {
    const capabilities = await invoke(["kernel"], home);
    expect(capabilities.code).toBe(ExitCode.ok);
    expect(capabilities.out).toMatch(/lemma\/Agent\s+agent \(active\)\s+transport/);
    const hooks = JSON.parse((await invoke(["kernel", "hooks", "--json"], home)).out);
    expect(hooks).toEqual(expect.arrayContaining([expect.objectContaining({ name: "lemma/interaction.request" })]));
    const registries = (await invoke(["kernel", "registries"], home)).out;
    expect(registries).toMatch(/lemma\/tools {2}\(\d+ items\)/);
    expect(registries).toMatch(/\n {2}bash +1 +bash/);
    expect((await invoke(["kernel", "events"], home)).out).toContain("lemma/session.appended");
    expect((await invoke(["kernel", "nope"], home)).code).toBe(ExitCode.usage);
    expect((await invoke(["kernel", "toString"], home)).code).toBe(ExitCode.usage);
  });

  test("inspectors lists what host plugins let you look into, and prints one as tables", async () => {
    const listed = await invoke(["inspectors"], home);
    expect(listed.out).toMatch(/tools\.registered\s+Tools\s+tools/);
    expect(listed.out).toMatch(/agent\.turns\s+Running turns\s+agent/);
    const tools = await invoke(["inspectors", "tools.registered"], home);
    expect(tools.out).toMatch(/^tools\nname\s+plugin\s+description\n/);
    expect(tools.out).toMatch(/\nbash\s+bash\s+/);
    expect(JSON.parse((await invoke(["inspectors", "agent.turns", "--json"], home)).out)).toEqual([]);
    expect(JSON.parse((await invoke(["inspectors", "nope", "--json"], home)).err).error.code).toBe("NotFound");
  });

  test("plugins config shows a plugin's fields and sets or unsets one in the file that sets its config", async () => {
    const userConfig = join(home, "config.jsonc");
    const original = await readFile(userConfig, "utf8");
    const config = async (id: string) => JSON.parse((await invoke(["plugins", "config", id, "--json"], home)).out);
    try {
      const agent = await config("agent");
      expect(agent.fields.find((field: { key: string }) => field.key === "maxSteps")).toMatchObject({ type: "integer", default: 200 });
      expect(agent.values.maxSteps).toBe(200);
      expect((await invoke(["plugins", "config", "agent"], home)).out).toContain("Model calls allowed in one turn");

      // The transport needs the agent, so the change is written, answered, and then applied, restarting the transport.
      const set = await invoke(["plugins", "config", "agent", "maxSteps", "80", "--json"], home);
      expect(set.code).toBe(ExitCode.ok);
      expect(JSON.parse(set.out)).toMatchObject({ id: "agent", key: "maxSteps", value: 80, scope: "user", deferred: true });
      expect(JSON.parse(await readFile(userConfig, "utf8")).plugins.agent).toEqual({ config: { maxSteps: 80 } });
      const maxSteps = async () => (await config("agent")).values.maxSteps as number;
      expect(await settled(maxSteps, (value) => value === 80)).toBe(80);

      const wrong = await invoke(["plugins", "config", "agent", "maxSteps", "1.5", "--json"], home);
      expect(wrong.code).toBe(ExitCode.failed);
      expect(JSON.parse(wrong.err).error).toMatchObject({ code: "Usage", message: "maxSteps must be a whole number" });
      const unknown = await invoke(["plugins", "config", "agent", "speed", "9", "--json"], home);
      expect(JSON.parse(unknown.err).error.message).toContain("its fields are defaultModel, systemPrompt, cli, maxSteps");

      await invoke(["plugins", "config", "agent", "maxSteps", "--unset"], home);
      expect(JSON.parse(await readFile(userConfig, "utf8")).plugins.agent).toBeUndefined();
      expect(await settled(maxSteps, (value) => value === 200)).toBe(200);
      // The transport's token is secret: clients learn only whether it is set.
      const transport = await config("transport");
      expect(transport.fields.find((field: { key: string }) => field.key === "token")).toMatchObject({ secret: true });
      expect(transport.values.token).toBeUndefined();
      expect(transport.values.port).toBe(0);
    } finally {
      await writeFile(userConfig, original);
      await settled(async () => (await invoke(["reload"], home)).code === ExitCode.ok || undefined);
    }
  });

  test("ui lists and writes the web app's rows, and finds UI files as they appear", async () => {
    const userConfig = join(home, "config.jsonc");
    const original = await readFile(userConfig, "utf8");
    const ui = async () => JSON.parse((await invoke(["ui", "--json"], home)).out);
    try {
      expect(await ui()).toEqual({ plugins: {}, enabledIn: {}, configIn: {}, files: [] });
      expect((await invoke(["ui", "disable", "composer"], home)).out).toBe("disabled composer in the user config; open web apps apply it");
      await invoke(["ui", "config", "theme", "accent", "red"], home);
      await invoke(["ui", "config", "theme", "scale", "1.2"], home);
      expect(JSON.parse(await readFile(userConfig, "utf8")).ui).toEqual({ composer: { enabled: false }, theme: { config: { accent: "red", scale: 1.2 } } });
      expect(await ui()).toMatchObject({ enabledIn: { composer: "user" }, configIn: { theme: "user" } });
      await invoke(["ui", "enable", "composer"], home);
      await invoke(["ui", "config", "theme", "accent", "--unset"], home);
      expect(JSON.parse(await readFile(userConfig, "utf8")).ui).toEqual({ theme: { config: { scale: 1.2 } } });

      await mkdir(join(home, "ui"), { recursive: true });
      await writeFile(join(home, "ui", "theme.css"), ":root { --accent: red; }");
      const deadline = Date.now() + 5_000;
      let files: { name: string; kind: string; url: string }[] = [];
      while (files.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        files = (await ui()).files;
      }
      expect(files).toMatchObject([{ name: "theme.css", kind: "style" }]);
      expect((await invoke(["ui"], home)).out).toContain("user/theme.css");
    } finally {
      await rm(join(home, "ui"), { recursive: true, force: true });
      await writeFile(userConfig, original);
      await invoke(["reload"], home);
    }
  });

  test("do lists the commands plugins registered and runs one, answering its questions", async () => {
    const listed = JSON.parse((await invoke(["do", "--json"], home)).out).map((command: { id: string }) => command.id);
    expect(listed).toEqual(expect.arrayContaining(["host.reload", "host.restart-plugin", "llm.logout", "workspace.checkout", "workspace.new-branch"]));
    expect(await invoke(["do", "host.reload"], home)).toMatchObject({ code: ExitCode.ok, out: "Config reloaded; nothing changed" });

    const repo = await mkdtemp(join(tmpdir(), "lemma-cli-repo-"));
    try {
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });
      expect(await invoke(["do", "workspace.new-branch", "--answer", "topic"], home, repo)).toMatchObject({
        code: ExitCode.ok,
        out: "Created and switched to topic",
      });
      const dismissed = await invoke(["do", "workspace.checkout", "--questions", "dismiss", "--json"], home, repo);
      expect(dismissed.code).toBe(ExitCode.failed);
      expect(JSON.parse(dismissed.err.split("\n").at(-1)!).error).toMatchObject({ code: "Cancelled", subject: "workspace.checkout" });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
    expect(JSON.parse((await invoke(["do", "nope", "--json"], home)).err).error).toMatchObject({ code: "NotFound", subject: "nope" });
  }, 30_000);

  test("workspace files finds a project's files by a fuzzy query", async () => {
    const repo = await realpath(await mkdtemp(join(tmpdir(), "lemma-cli-files-")));
    try {
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
      await mkdir(join(repo, "src", "components"), { recursive: true });
      await writeFile(join(repo, "src", "components", "Composer.tsx"), "");
      await writeFile(join(repo, "README.md"), "");
      const found = JSON.parse((await invoke(["workspace", "files", "src", "compoesr", "--json"], home, repo)).out);
      expect(found).toMatchObject({ root: repo, truncated: false });
      expect(found.entries[0]).toEqual({ path: "src/components/Composer.tsx", kind: "file" });
      expect((await invoke(["workspace", "files", "--limit", "1", "--path", repo], home)).out.split("\n")).toHaveLength(2);
      expect(JSON.parse((await invoke(["workspace", "files", "--json", "--path", join(repo, "missing")], home)).err).error).toMatchObject({
        code: "NotFound",
      });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 30_000);

  test("a rejected token fails instead of waiting", async () => {
    const other = await mkdtemp(join(tmpdir(), "lemma-cli-"));
    try {
      const discovery = JSON.parse(await readFile(join(home, "transport.json"), "utf8"));
      await writeFile(join(other, "transport.json"), JSON.stringify({ ...discovery, token: "wrong" }));
      const result = await invoke(["status", "--json"], other);
      expect(result.code).toBe(ExitCode.unavailable);
      expect(JSON.parse(result.err).error.code).toBe("Unauthorized");
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  describe("from another machine", () => {
    // `other` stands for the client machine: a home with no local host, only what `lemma remote` writes.
    let other: string;
    let url: string;
    let token: string;
    let dead: string;
    beforeAll(async () => {
      other = await mkdtemp(join(tmpdir(), "lemma-cli-client-"));
      ({ url, token } = JSON.parse(await readFile(join(home, "transport.json"), "utf8")));
      dead = `http://127.0.0.1:${await freePort()}`;
    });
    afterAll(() => rm(other, { recursive: true, force: true }));
    const remoteFile = () => join(other, "remote.json");

    test("token prints the local host's token; remote set checks it against the host before saving it", async () => {
      expect(await invoke(["token"], home)).toMatchObject({ code: ExitCode.ok, out: token });

      const wrong = await invoke(["remote", "set", url, "--token", "wrong", "--json"], other);
      expect(wrong.code).toBe(ExitCode.unavailable);
      expect(JSON.parse(wrong.err).error).toMatchObject({ code: "Unauthorized" });
      const unreachable = await invoke(["remote", "set", dead, "--token", token, "--json"], other);
      expect(unreachable.code).toBe(ExitCode.unavailable);
      expect(JSON.parse(unreachable.err).error).toMatchObject({ code: "Unreachable" });
      expect(existsSync(remoteFile())).toBe(false);

      const set = await invoke(["remote", "set", `${url}/`, "--token", token, "--json"], other);
      expect(set.code).toBe(ExitCode.ok);
      expect(JSON.parse(set.out)).toMatchObject({ url, from: remoteFile(), info: { home } });
      expect(JSON.parse(await readFile(remoteFile(), "utf8"))).toEqual({ url, token });
      expect((await stat(remoteFile())).mode & 0o777).toBe(0o600);

      // The token can come from LEMMA_TOKEN, or be asked for without echoing it.
      expect((await invoke(["remote", "set", url], other, "/", { LEMMA_TOKEN: token })).code).toBe(ExitCode.ok);
      const asked: boolean[] = [];
      const code = await run(["remote", "set", url], {
        env: { LEMMA_HOME: other },
        cwd: "/",
        out: () => {},
        err: () => {},
        ask: async (_question, secret) => {
          asked.push(secret);
          return `${token}\n`;
        },
      });
      expect([code, asked]).toEqual([ExitCode.ok, [true]]);
      expect(JSON.parse(await readFile(remoteFile(), "utf8"))).toEqual({ url, token });
    });

    test("commands go to the host in remote.json; remote names it without the token", async () => {
      await writeFile(remoteFile(), JSON.stringify({ url, token }));
      const shown = await invoke(["remote"], other);
      expect(shown.out).toBe(`${url} (from ${remoteFile()})`);
      expect(JSON.parse((await invoke(["remote", "--json"], other)).out)).toEqual({ source: "remote", url, from: remoteFile(), tokenSet: true });

      const status = JSON.parse((await invoke(["status", "--json"], other)).out);
      expect(status).toMatchObject({ url, source: "remote", info: { home } });
      expect(status.pid).toBeUndefined();
      expect((await invoke(["status"], other)).out).toContain(`${url} (from ${remoteFile()}, transport`);
      const listed = JSON.parse((await invoke(["session", "list", "--all", "--json"], other)).out);
      expect(listed).toEqual(JSON.parse((await invoke(["session", "list", "--all", "--json"], home)).out));
      const opened = new URL(JSON.parse((await invoke(["open", "--json"], other)).out).url);
      expect([opened.origin, opened.searchParams.get("token")]).toEqual([url, token]);
      // `token` is about this machine's host, and there is none here.
      expect(JSON.parse((await invoke(["token", "--json"], other)).err).error.code).toBe("NoHost");
    });

    test("LEMMA_URL and LEMMA_TOKEN override remote.json", async () => {
      await writeFile(remoteFile(), JSON.stringify({ url: dead, token }));
      const env = { LEMMA_URL: url, LEMMA_TOKEN: token };
      expect(JSON.parse((await invoke(["remote", "--json"], other, "/", env)).out)).toMatchObject({ source: "env", url, from: "LEMMA_URL" });
      expect(JSON.parse((await invoke(["status", "--json"], other, "/", env)).out)).toMatchObject({ url, source: "env", info: { home } });
      const wrong = await invoke(["status", "--json"], other, "/", { ...env, LEMMA_TOKEN: "wrong" });
      expect(JSON.parse(wrong.err).error).toMatchObject({ code: "Unauthorized" });
      expect(JSON.parse(wrong.err).error.message).toContain("LEMMA_TOKEN");
    });

    test("a remote host that does not answer is NoHost, naming its URL and the way back", async () => {
      await writeFile(remoteFile(), JSON.stringify({ url: dead, token }));
      const down = await invoke(["status", "--json"], other);
      expect(down.code).toBe(ExitCode.unavailable);
      const error = JSON.parse(down.err).error;
      expect(error.code).toBe("NoHost");
      expect(error.message).toContain(dead);
      expect(error.message).toContain("lemma remote clear");

      await writeFile(remoteFile(), JSON.stringify({ url, token: "stale" }));
      const stale = JSON.parse((await invoke(["status", "--json"], other)).err).error;
      expect(stale.code).toBe("Unauthorized");
      expect(stale.message).toContain(remoteFile());

      // An unusable file is an error, never a silent fallback to the local host.
      await writeFile(remoteFile(), "{");
      expect(JSON.parse((await invoke(["status", "--json"], other)).err).error.message).toContain(`Cannot use ${remoteFile()}`);
    });

    test("remote clear removes remote.json: back to the local host", async () => {
      await writeFile(remoteFile(), JSON.stringify({ url, token }));
      expect(JSON.parse((await invoke(["remote", "clear", "--json"], other)).out)).toEqual({ removed: true, from: remoteFile() });
      expect(existsSync(remoteFile())).toBe(false);
      expect(JSON.parse((await invoke(["remote", "clear", "--json"], other)).out)).toEqual({ removed: false, from: remoteFile() });
      expect(JSON.parse((await invoke(["status", "--json"], other)).err).error.code).toBe("NoHost");
    });
  });
});

describe("formatSession", () => {
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const event = (seq: number, data: SessionEvent["data"]): SessionEvent => ({ seq, id: `e${seq}`, parent: seq === 1 ? null : `e${seq - 1}`, at: 0, data });
  const info: SessionInfo = { id: "s1", cwd: "/work", createdAt: 0, updatedAt: 0, title: "Fix it", leaf: "e6", lastSeq: 6 };

  test("renders the branch as a transcript", () => {
    const output = formatSession(info, [
      event(1, { type: "turn-start", turnId: "t" }),
      event(2, { type: "message", message: { role: "user", content: [{ type: "text", text: "Fix it" }], timestamp: 0 } }),
      event(3, {
        type: "message",
        message: {
          role: "assistant",
          api: "x",
          provider: "p",
          model: "m",
          usage,
          stopReason: "toolUse",
          timestamp: 0,
          content: [
            { type: "thinking", thinking: "hidden" },
            { type: "text", text: "Looking." },
            { type: "toolCall", id: "c", name: "bash", arguments: { command: "ls" } },
          ],
        },
      }),
      event(4, {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "c",
          toolName: "bash",
          isError: true,
          timestamp: 0,
          content: [{ type: "text", text: Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n") }],
        },
      }),
      event(5, { type: "turn-end", turnId: "t", reason: "cancelled" }),
      event(6, { type: "title", title: "Fix it" }),
    ]);
    const body = output.slice(output.indexOf("\n\n") + 2);
    expect(body).toBe(
      [
        "── user",
        "Fix it",
        "── assistant (p/m)",
        "Looking.",
        '→ bash {"command":"ls"}',
        "── bash (error)",
        ...Array.from({ length: 12 }, (_, i) => `line ${i}`),
        "… 8 more lines",
        "── turn ended: cancelled",
      ].join("\n"),
    );
    expect(output).toContain("events   6 (6 on the current branch)");
  });
});

describe("inspect formatting", () => {
  const usage = {
    input: 1200,
    output: 40,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 1240,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const spec = { name: "bash", description: "Run", parameters: {} };
  const events: SessionEvent[] = (
    [
      { type: "turn-start", turnId: "t" },
      { type: "message", turnId: "t", message: { role: "user", content: [{ type: "text", text: "Run ls" }], timestamp: 0 } },
      { type: "step-start", turnId: "t", stepId: "s1" },
      {
        type: "request",
        turnId: "t",
        stepId: "s1",
        model: "p/m",
        composition: "abc",
        system: "BASE\n\nCTX",
        tools: [spec],
        contributions: [
          { source: "agent", kind: "system", label: "base", chars: 4 },
          { source: "project-context", kind: "system", label: "project-context", chars: 3 },
          { source: "bash", kind: "tool", label: "bash", chars: JSON.stringify(spec).length },
        ],
      },
      {
        type: "message",
        turnId: "t",
        stepId: "s1",
        timing: { startedAt: 0, firstTokenAt: 500, endedAt: 2000 },
        message: {
          role: "assistant",
          api: "x",
          provider: "p",
          model: "m",
          usage,
          stopReason: "toolUse",
          timestamp: 0,
          content: [{ type: "toolCall", id: "c", name: "bash", arguments: { command: "ls" } }],
        },
      },
      {
        type: "message",
        turnId: "t",
        stepId: "s1",
        timing: { startedAt: 2000, endedAt: 2300 },
        message: { role: "toolResult", toolCallId: "c", toolName: "bash", content: [], isError: false, timestamp: 0 },
      },
      { type: "step-end", turnId: "t", stepId: "s1" },
      { type: "turn-end", turnId: "t", reason: "done" },
    ] satisfies SessionEvent["data"][]
  ).map((data, i) => ({ seq: i + 1, id: `e${i + 1}`, parent: i === 0 ? null : `e${i}`, at: i * 1000, data }));
  const turns = trajectory(events);

  test("the overview has one line per step", () => {
    expect(formatTrajectory(turns)).toBe(
      ["Turn 1 · done · 1 step · ↑1.2k ↓40 · 7.0s", '  "Run ls"', "  1  s1  m  1 msg  ↑1.2k ↓40  ttft 500ms  2.0s  → bash"].join("\n"),
    );
  });

  test("records list as a table with step, request, kind, status, time, tokens, and name", () => {
    expect(formatRecords(ledger(turns), false).split("\n")).toEqual([
      "step  req  kind    status    time   tokens   name",
      "1          user    sent                      Run ls",
      "1     #1   system  initial                   initial system prompt",
      "1.1   #1   model   tool use  2.0s   1.2k/40  → bash",
      '1.1        tool    ok        300ms           bash {"command":"ls"}',
    ]);
    expect(formatRecords([], false)).toBe("No records match.");
  });

  test("the system view prints each section under its plugin, and the diff view prints changed lines", () => {
    const request = turns[0]!.steps[0]!.request!;
    expect(formatSystem(request)).toBe("── base from agent, 4 chars (changed)\nBASE\n\n── project-context from project-context, 3 chars (changed)\nCTX");
    expect(formatDiff(promptDiff(undefined, request), true)).toContain("first request");
    const edited = { ...request, sections: request.sections.map((section) => (section.id === "base" ? { ...section, text: "BASE 2" } : section)) };
    expect(formatDiff(promptDiff(request, edited), false)).toBe("── base from agent (changed)\n- BASE\n+ BASE 2");
    expect(formatDiff([], false)).toContain("unchanged");
  });

  test("a step names the plugin behind every part of the request", () => {
    const output = formatStep(turns[0]!, turns[0]!.steps[0]!);
    expect(output).toContain("  base from agent, 4 chars (changed)\n    BASE");
    expect(output).toContain("  project-context from project-context, 3 chars (changed)\n    CTX");
    expect(output).toMatch(/ {2}bash {2}from bash {2}\d+ chars {2}\(changed\)/);
    expect(output).toContain("composition  abc");
    expect(output).toMatch(/Tool runs:\n {2}bash {2}ok {2}300ms/);
  });
});

describe("argument parsing", () => {
  test("offsets accept seconds, units, and combinations", () => {
    expect(parseOffset("90")).toBe(90_000);
    expect(parseOffset("1m30s")).toBe(90_000);
    expect(parseOffset("500ms")).toBe(500);
    expect(parseOffset("2h")).toBe(7_200_000);
    expect(parseOffset("soon")).toBeUndefined();
  });

  test("answers are checked against the question", () => {
    const select = {
      type: "select" as const,
      id: "q",
      title: "Pick",
      options: [
        { value: "api_key", label: "API key" },
        { value: "oauth", label: "Subscription" },
      ],
    };
    expect(toAnswer(select, "oauth")).toEqual({ type: "select", value: "oauth" });
    expect(toAnswer(select, "api key")).toEqual({ type: "select", value: "api_key" });
    expect(toAnswer(select, "2")).toEqual({ type: "select", value: "oauth" });
    expect(toAnswer(select, "other")).toContain("Choose one of");
    expect(toAnswer({ type: "confirm", id: "c", title: "Go?" }, "Yes")).toEqual({ type: "confirm", value: true });
    expect(toAnswer({ type: "confirm", id: "c", title: "Go?" }, "maybe")).toContain("yes or no");
    expect(toAnswer({ type: "ask", id: "a", title: "Key" }, " sk ")).toEqual({ type: "ask", value: " sk " });
  });

  test("open questions show what they are about before their choices", () => {
    const approval = {
      type: "select" as const,
      id: "q1",
      title: "Run this command?",
      detail: "rm -rf build\nls",
      options: [
        { value: "once", label: "Allow once" },
        { value: "deny", label: "Deny" },
      ],
    };
    expect(formatQuestions([approval])).toBe("q1  select  Run this command?\n    rm -rf build\n    ls\n    1. once (Allow once)\n    2. deny (Deny)");
  });
});

describe("a host killed mid-turn", () => {
  let home: string;
  let mock: ChildProcess;
  const hosts: ChildProcess[] = [];

  const startOne = async () => {
    const host = await startHost(home);
    hosts.push(host);
    return host;
  };
  const show = async (session: string) =>
    JSON.parse((await invoke(["session", "show", session, "--json"], home)).out) as { branch: { data: Record<string, any> }[] };

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "lemma-cli-crash-"));
    const provider = await startMockProvider();
    mock = provider.process;
    await writeFile(join(home, "config.jsonc"), JSON.stringify(mockConfig(provider.baseUrl, { agent: { config: { defaultModel: "mock/scripted" } } })));
  }, 30_000);

  afterAll(async () => {
    mock.kill();
    for (const host of hosts) await stopHost(host);
    await rm(home, { recursive: true, force: true });
  });

  test("resumes its turns when it starts again: a cut-off command is reported with its output, a cut-off answer is asked again", async () => {
    const first = await startOne();
    const slow = (await invoke(["session", "new", "--cwd", home], home)).out;
    const ramble = (await invoke(["session", "new", "--cwd", home], home)).out;
    // Both are left waiting when the host dies under them.
    void invoke(["run", slow, "do it slowly"], home);
    void invoke(["run", ramble, "ramble on"], home);
    const live = (session: string) => readFile(join(home, "agent", `${session}.live.json`), "utf8");
    expect(
      await settled(
        () => live(slow),
        (text) => text.includes("started"),
      ),
    ).toBeDefined();
    expect(
      await settled(
        () => live(ramble),
        (text) => text.includes("word5"),
      ),
    ).toBeDefined();
    const exited = new Promise((resolve) => first.once("exit", resolve));
    first.kill("SIGKILL");
    await exited;

    await startOne();
    const ended = async (session: string) =>
      settled(
        () => show(session),
        ({ branch }) => branch.some((event) => event.data.type === "turn-end"),
      );
    const [slowLog, rambleLog] = await Promise.all([ended(slow), ended(ramble)]);
    for (const log of [slowLog!, rambleLog!]) {
      expect(log.branch.some((event) => event.data.type === "custom" && event.data.kind === "agent.resumed")).toBe(true);
      expect(log.branch.find((event) => event.data.type === "turn-end")!.data.reason).toBe("done");
      expect(log.branch.filter((event) => event.data.type === "turn-start")).toHaveLength(1);
    }
    // The command was not run again: the model was told it was cut off, with what it had printed.
    const result = slowLog!.branch.find((event) => event.data.type === "message" && event.data.message.role === "toolResult")!.data.message;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/interrupted[\s\S]*started/);
    // The answer cut off midway is kept as an interrupted attempt, and asked again in full.
    const attempt = rambleLog!.branch.find((event) => event.data.type === "attempt")!.data.message;
    expect(attempt.errorMessage).toMatch(/^Interrupted/);
    expect(attempt.content[0].text).toContain("word5");
    const answer = rambleLog!.branch.filter((event) => event.data.type === "message" && event.data.message.role === "assistant").at(-1)!.data.message;
    expect(answer.content[0].text).toContain("word60");
  }, 60_000);
});

describe("formatPlugins", () => {
  test("says why a plugin is left out, and what waits on it", () => {
    const base = { version: "1", source: "bundled" as const, enabled: true, provides: [], requires: [] };
    const text = formatPlugins([
      { ...base, id: "agent", provides: ["lemma/Agent"], state: "disabled", problem: "its config is invalid at maxSteps: Expected number" },
      { ...base, id: "compaction", requires: ["lemma/Agent"], state: "disabled", haltedBy: "agent" },
    ]);
    expect(text).toContain("left out: its config is invalid at maxSteps: Expected number");
    expect(text).toContain("needs agent, which is left out");
  });
});
