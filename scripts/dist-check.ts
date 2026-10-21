import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hostTarget, packageName, parsePackageName, version as checkoutVersion } from "./dist-config.ts";
import { settled } from "./e2e.ts";

/*
 * Installs a release archive for this platform (`pnpm dist` builds it at the checkout's version; or pass its path) as a
 * user would, with scripts/install.sh, outside the checkout and with a `node` on PATH that fails, then runs it: a host,
 * the web app it serves, a plugin file in TypeScript, the native file search, the CLI the agent is told of, and an
 * agent's turn that runs a tool, on the scripted provider (no API key).
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const archive = resolve(process.argv[2] ?? join(root, "dist", `${packageName(checkoutVersion, hostTarget())}.tar.gz`));
const named = parsePackageName(basename(archive));
assert.ok(named, `${basename(archive)} is not named as a release archive, lemma-v<version>-<target>.tar.gz`);
assert.equal(named.target, hostTarget(), `${basename(archive)} is for another platform than this one`);
const { version } = named;
const temporary = await mkdtemp(join(tmpdir(), "lemma-dist-check-"));
// Spaces and quotes in the paths, as a user's may have.
const project = join(temporary, "a project");
const home = join(temporary, "home");
const bin = join(temporary, "user's bin");
const data = join(temporary, "data");
const stubs = join(temporary, "stubs");
const lemma = join(bin, "lemma");
const children: ChildProcess[] = [];
const env: NodeJS.ProcessEnv = {
  ...process.env,
  HOME: home,
  LEMMA_HOME: join(home, ".lemma"),
  LEMMA_OUTPUT: "text",
  // A `node` that fails: the release runs on its own runtime, and so does the CLI it names to the agent.
  PATH: `${stubs}:${process.env.PATH ?? "/usr/bin:/bin"}`,
  LEMMA_VERSION: version,
  LEMMA_INSTALL_DIR: bin,
  LEMMA_DATA_DIR: data,
};
for (const name of ["LEMMA_URL", "LEMMA_TOKEN", "LEMMA_ENV", "INIT_CWD", "NODE_OPTIONS"]) delete env[name];

/** Runs `file` in the project to its end, failing unless it exits `expected`; its stdout. */
const command = async (file: string, args: readonly string[], expected = 0): Promise<string> => {
  const child = spawn(file, args, { cwd: project, env, stdio: ["ignore", "pipe", "pipe"], timeout: 90_000 });
  children.push(child);
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));
  const [code] = await once(child, "close");
  assert.equal(code, expected, `${file} ${args.join(" ")} exited ${code}:\n${out}\n${err}`);
  return out;
};

/** Starts `file` in the project, to run until the check ends; `ready` waits for its output to match. */
const launch = (file: string, args: readonly string[], variables: NodeJS.ProcessEnv = {}) => {
  const child = spawn(file, args, { cwd: project, env: { ...env, ...variables }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  return {
    ready: async (pattern: RegExp) => {
      const match = await settled(async () => pattern.exec(output) ?? undefined, undefined, 60_000);
      assert.ok(match, `${basename(file)} did not print ${pattern}:\n${output}`);
      return match;
    },
  };
};

// The release, as GitHub serves it; with a wrong checksum when asked.
let badChecksum = false;
const server = createServer((request, response) => {
  const name = request.url?.slice(1);
  if (name !== basename(archive) && name !== `${basename(archive)}.sha256`) return void response.writeHead(404).end();
  if (badChecksum && name.endsWith(".sha256")) return void response.end(`${"0".repeat(64)}  ${basename(archive)}\n`);
  createReadStream(join(dirname(archive), name))
    .on("error", () => response.destroy())
    .pipe(response);
});

try {
  for (const dir of [project, stubs, join(home, ".lemma/plugins")]) await mkdir(dir, { recursive: true });
  await writeFile(join(stubs, "node"), "#!/bin/sh\necho 'lemma ran the node on PATH' >&2\nexit 99\n");
  await chmod(join(stubs, "node"), 0o755);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  env.LEMMA_RELEASE_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const installer = join(root, "scripts/install.sh");
  const releases = async () => (await readdir(join(data, "releases"))).length;
  await command("sh", [installer]);
  assert.equal((await command(lemma, ["--version"])).trim(), version);
  await command(lemma, ["status"], 3);
  const first = await realpath(lemma);
  await command("sh", [installer]);
  const second = await realpath(lemma);
  assert.notEqual(second, first, "a reinstall switches to a release directory of its own");
  assert.equal(await releases(), 2, "a reinstall keeps the release before it");
  await command("sh", [installer]);
  const installed = await realpath(lemma);
  assert.equal(await releases(), 2, "a reinstall removes releases older than the one before it");
  badChecksum = true;
  await command("sh", [installer], 1);
  assert.equal(await realpath(lemma), installed, "a download that fails its checksum leaves the installed release in place");
  badChecksum = false;
  console.log("installer: install, reinstall, pruning, and a bad checksum passed");

  await command("git", ["init", "--quiet"]);
  await writeFile(join(project, "needle.txt"), "what the file search finds\n");
  await command("git", ["add", "needle.txt"]);
  const mock = launch(process.execPath, [join(root, "scripts/mock-openai.ts")], { PORT: "0", PACE_MS: "0", PATH: process.env.PATH });
  const provider = (await mock.ready(/listening on (\S+)/))[1]!;
  await writeFile(
    join(home, ".lemma/config.jsonc"),
    JSON.stringify({
      plugins: {
        "transport.server": { config: { port: 0 } },
        "llm.pi-ai": { config: { providers: [{ id: "mock", api: "openai-completions", baseUrl: provider, models: [{ id: "scripted" }] }] } },
      },
    }),
  );
  // A user's plugin file, in TypeScript, importing what the host links into the home.
  await writeFile(
    join(home, ".lemma/plugins/greet.ts"),
    `import { Schema } from "effect";
import { definePlugin } from "@lemma/core/plain";
import { ToolResult, Tools } from "@lemma/tools";

const greeting = (name: string): string => \`Hello, \${name}\`;

export default definePlugin({
  id: "greet",
  setup: (_, { add }) => {
    add(Tools, {
      name: "greet",
      description: "Greets someone by name.",
      input: Schema.Struct({ name: Schema.String }),
      execute: async ({ name }) => new ToolResult({ content: [{ type: "text", text: greeting(name) }] }),
    });
  },
});
`,
  );

  launch(lemma, ["serve", "--no-open"]);
  await settled(() => command(lemma, ["status"]), undefined, 60_000);
  const status = JSON.parse(await command(lemma, ["status", "--json"])) as { plugins: readonly { id: string; state: string }[] };
  const failed = status.plugins.filter((plugin) => plugin.state !== "active" && plugin.state !== "disabled").map(({ id, state }) => `${id}: ${state}`);
  assert.deepEqual(failed, [], "every plugin turned on runs");
  assert.ok(
    status.plugins.some((plugin) => plugin.id === "greet"),
    "the plugin file loads",
  );

  const { url } = JSON.parse(await readFile(join(home, ".lemma/transport.json"), "utf8")) as { url: string };
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
  assert.deepEqual(
    (({ type, reason, toolCalls }) => ({ type, reason, toolCalls }))(JSON.parse(turn.at(-1)!)),
    { type: "result", reason: "done", toolCalls: 1 },
    "the turn ended",
  );
  console.log("release: host, plugins, web app, a TypeScript plugin file, file search, the agent's CLI, and a turn passed");
} finally {
  for (const child of children.reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const closed = once(child, "close");
    child.kill("SIGTERM");
    const deadline = setTimeout(() => child.kill("SIGKILL"), 10_000);
    await closed;
    clearTimeout(deadline);
  }
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  await rm(temporary, { recursive: true, force: true });
}
