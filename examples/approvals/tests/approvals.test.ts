import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Effect, Layer, Schema } from "effect";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { definePlugin, makeCore } from "@lemma/core";
import type { Plugin } from "@lemma/core";
import { Interaction, InteractionError, ToolInvocation, ToolResult, Tools } from "@lemma/contracts";
import type { Tool } from "@lemma/contracts";
import { run as cli } from "@lemma/cli/src/cli.ts";
import tools from "@lemma/plugin-tools";
import approvals, { question } from "../approvals.ts";

const file = fileURLToPath(new URL("../approvals.ts", import.meta.url));
const defaults = { ask: ["bash"], mcp: "writes" as const, outsideProject: ["write", "edit"] };
const call = (name: string, input: unknown, sessionId = "s1") => new ToolInvocation({ sessionId, toolCallId: "c1", name, input, cwd: "/work/project" });

describe("which calls ask", () => {
  test("every command, and writes outside the session's directory", () => {
    expect(question(call("bash", { command: "rm -rf build" }), defaults)).toEqual({ title: "Run this command?", detail: "rm -rf build" });
    expect(question(call("write", { path: "src/a.ts" }), defaults)).toBeUndefined();
    expect(question(call("edit", { path: "/work/project/../other/a.ts" }), defaults)).toEqual({
      title: "Allow edit outside the project?",
      detail: "/work/other/a.ts",
    });
    expect(question(call("write", { path: "/work/projects-evil/a.ts" }), defaults)?.detail).toBe("/work/projects-evil/a.ts");
    expect(question(call("read", { path: "/etc/passwd" }), defaults)).toBeUndefined();
    expect(question(call("read", { path: "/etc/passwd" }), { ...defaults, outsideProject: ["read"] })?.detail).toBe("/etc/passwd");
  });

  test("asks for MCP tools their server does not mark read-only, and for names an `ask` pattern matches", () => {
    const tool = (name: string, readOnly?: boolean) => ({
      name,
      tool: `mcp__gh__${name}`,
      enabled: true,
      hints: readOnly === undefined ? {} : { readOnly },
    });
    const search = call("mcp__gh__search", { q: "x" });
    expect(question(search, defaults, { server: "GitHub", tool: tool("search", true) })).toBeUndefined();
    expect(question(call("mcp__gh__create_issue", { title: "t" }), defaults, { server: "GitHub", tool: tool("create_issue") })).toEqual({
      title: "Allow GitHub's create_issue?",
      detail: '{\n  "title": "t"\n}',
    });
    expect(question(search, { ...defaults, mcp: "all" }, { server: "GitHub", tool: tool("search", true) })?.title).toBe("Allow GitHub's search?");
    expect(question(call("mcp__gh__create_issue", {}), { ...defaults, mcp: "none" }, { server: "GitHub", tool: tool("create_issue") })).toBeUndefined();
    expect(question(search, { ...defaults, mcp: "none", ask: ["mcp__gh__*"] }, { server: "GitHub", tool: tool("search", true) })?.title).toBe(
      "Allow mcp__gh__search?",
    );
    expect(question(call("bash_like", {}), { ...defaults, ask: ["bash*"] })?.title).toBe("Allow bash_like?");
  });

  test("resolves a path as the file tools do: `~` is home and a leading `@` is dropped; `..name` is a name", () => {
    expect(question(call("write", { path: "~/.bashrc" }), defaults)?.detail).toBe(join(homedir(), ".bashrc"));
    expect(question(call("write", { path: "@/etc/hosts" }), defaults)?.detail).toBe("/etc/hosts");
    expect(question(call("write", { path: "..prettierrc" }), defaults)).toBeUndefined();
  });

  test("follows a link out of the project, even to a file not yet written", async () => {
    const root = await mkdtemp(join(tmpdir(), "lemma-approvals-links-"));
    try {
      await mkdir(join(root, "project"));
      await mkdir(join(root, "elsewhere"));
      await symlink(join(root, "elsewhere"), join(root, "project", "link"));
      const inProject = (path: string) => new ToolInvocation({ sessionId: "s1", toolCallId: "c1", name: "write", input: { path }, cwd: join(root, "project") });
      expect(question(inProject("link/new.txt"), defaults)?.title).toBe("Allow write outside the project?");
      expect(question(inProject("plain/new.txt"), defaults)).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

/** Answers each question with the next answer, recording what was asked; `undefined` means nobody is there. */
const answering = (answers: readonly (string | undefined)[]) => {
  const asked: { readonly title: string; readonly detail?: string }[] = [];
  const queue = [...answers];
  const plugin = definePlugin({
    id: "answers",
    provides: [Interaction],
    layer: Layer.succeed(Interaction, {
      confirm: () => Effect.die("not asked"),
      ask: () => Effect.die("not asked"),
      select: <V extends string>(title: string, _options: readonly { readonly value: V }[], detail?: string) =>
        Effect.suspend(() => {
          asked.push({ title, ...(detail === undefined ? {} : { detail }) });
          const answer = queue.shift();
          return answer === undefined
            ? Effect.fail(new InteractionError({ reason: "Unavailable", message: "No client is attached" }))
            : Effect.succeed(answer as V);
        }),
    }),
  });
  return { plugin, asked };
};

const shell: Tool<{ readonly command: string }> = {
  name: "bash",
  description: "Runs a command.",
  input: Schema.Struct({ command: Schema.String }),
  execute: async ({ command }) => new ToolResult({ content: [{ type: "text", text: `ran ${command}` }] }),
};
const shellPlugin = definePlugin({ id: "shell", requires: [Tools], layer: Layer.scopedDiscard(Effect.flatMap(Tools, (registry) => registry.register(shell))) });

const run = (plugins: readonly Plugin[], calls: readonly ToolInvocation[]) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* makeCore([tools, shellPlugin, approvals, ...plugins]);
        return yield* core.run(
          Effect.flatMap(Tools, (registry) =>
            Effect.forEach(calls, (invocation) =>
              Effect.map(registry.execute(invocation, new AbortController().signal), (result) =>
                result.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
              ),
            ),
          ),
        );
      }),
    ),
  );

describe("the guard", () => {
  test("runs a command allowed once, and asks again next time", async () => {
    const human = answering(["once", "deny"]);
    expect(await run([human.plugin], [call("bash", { command: "ls" }), call("bash", { command: "ls" })])).toEqual([
      "ran ls",
      "Tool call denied: the user declined",
    ]);
    expect(human.asked).toEqual([
      { title: "Run this command?", detail: "ls" },
      { title: "Run this command?", detail: "ls" },
    ]);
  });

  test("stops asking for a tool allowed for the session, in that session only", async () => {
    const human = answering(["session", "once"]);
    const results = await run([human.plugin], [call("bash", { command: "a" }), call("bash", { command: "b" }), call("bash", { command: "c" }, "s2")]);
    expect(results).toEqual(["ran a", "ran b", "ran c"]);
    expect(human.asked.map((asked) => asked.detail)).toEqual(["a", "c"]);
  });

  test("denies when nobody can answer", async () => {
    const human = answering([undefined]);
    const [result] = await run([human.plugin], [call("bash", { command: "ls" })]);
    expect(result).toBe("Tool call denied: nobody could approve it (No client is attached)");
  });
});

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const hostMain = join(root, "packages/host/src/main.ts");
const cliMain = join(root, "apps/cli/src/main.ts");
const mockProvider = join(root, "scripts/fixtures/mock-openai.ts");

const freePort = () =>
  new Promise<number>((done) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => done(port));
    });
  });

// The user's path: the file dropped into `<home>/plugins`, loaded by a real host, its question answered at the CLI.
describe("as a plugin file in a real host", () => {
  let home: string | undefined;
  let host: ChildProcess | undefined;
  let mock: ChildProcess | undefined;
  const lemma = async (...argv: string[]) => {
    const { stdout } = await execFileAsync(process.execPath, ["--conditions=lemma-source", cliMain, ...argv], { env: { ...process.env, LEMMA_HOME: home! } });
    return stdout;
  };

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "lemma-approvals-"));
    await mkdir(join(home, "plugins"));
    await copyFile(file, join(home, "plugins", "approvals.ts"));
    const port = await freePort();
    const provider = spawn(process.execPath, [mockProvider], { env: { ...process.env, PORT: String(port) }, stdio: ["ignore", "pipe", "ignore"] });
    mock = provider;
    await new Promise<void>((done) => provider.stdout!.once("data", () => done()));
    await writeFile(
      join(home, "config.jsonc"),
      JSON.stringify({
        plugins: {
          transport: { config: { port: 0 } },
          llm: { config: { providers: [{ id: "mock", api: "openai-completions", baseUrl: `http://127.0.0.1:${port}/v1`, models: [{ id: "scripted" }] }] } },
        },
      }),
    );
    const started = spawn(process.execPath, ["--conditions=lemma-source", hostMain, "--no-open"], {
      env: { ...process.env, LEMMA_HOME: home, INIT_CWD: home },
      stdio: "ignore",
    });
    host = started;
    const deadline = Date.now() + 20_000;
    while (!existsSync(join(home, "transport.json"))) {
      if (Date.now() > deadline || started.exitCode !== null) throw new Error("host did not start");
      await new Promise((done) => setTimeout(done, 100));
    }
  }, 30_000);

  // Whatever the setup got to before it failed.
  afterAll(async () => {
    mock?.kill();
    if (host !== undefined && host.exitCode === null) {
      const running = host;
      const exited = new Promise((done) => running.once("exit", done));
      running.kill("SIGTERM");
      await exited;
    }
    if (home !== undefined) await rm(home, { recursive: true, force: true });
  });

  test("loads, and a command runs or not as the user answers", async () => {
    const status = JSON.parse(await lemma("plugins", "--json"));
    expect(status.find((plugin: { id: string }) => plugin.id === "approvals")).toMatchObject({ source: "user", state: "active" });

    const session = (await lemma("session", "new", "--cwd", home!)).trim();
    const allowed = await lemma("run", session, "check the shell", "--model", "mock/scripted", "--answer", "once");
    expect(allowed).toContain("hello from lemma");
    const denied = await lemma("run", session, "again", "--model", "mock/scripted", "--answer", "deny");
    expect(denied).toContain("Tool call denied: the user declined");
    // No terminal and nothing to answer with: the CLI does not attach, so nobody can approve and the call is denied.
    const unattended = await lemma("run", session, "once more", "--model", "mock/scripted");
    expect(unattended).toContain("Tool call denied: nobody could approve it");
  }, 60_000);

  test("a question answered elsewhere closes the terminal's prompt", async () => {
    const session = (await lemma("session", "new", "--cwd", home!)).trim();
    let withdrawn = false;
    const asking = cli(["run", session, "check the shell", "--model", "mock/scripted"], {
      env: { LEMMA_HOME: home! },
      cwd: home!,
      out: () => {},
      write: () => {},
      err: () => {},
      // A terminal nobody types into: only withdrawing the prompt ends it.
      ask: (_question, _secret, signal) =>
        new Promise<string>((_, reject) =>
          signal?.addEventListener("abort", () => {
            withdrawn = true;
            reject(signal.reason);
          }),
        ),
    });
    let open: { id: string }[] = [];
    for (let tries = 0; open.length === 0 && tries < 100; tries++) {
      await new Promise((done) => setTimeout(done, 100));
      open = JSON.parse(await lemma("questions", "--json"));
    }
    await lemma("answer", open[0]!.id, "once");
    expect(await asking).toBe(0);
    expect(withdrawn).toBe(true);
  }, 60_000);
});
