import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createReadStream, existsSync } from "node:fs";
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
/** The host lemma restart started, in the background, which the check stops at its end. */
let restartedPid: number | undefined;
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

/** `env` with `variables` over it, an undefined one left out. */
const withVariables = (variables: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries({ ...env, ...variables }).filter(([, value]) => value !== undefined));

/** Runs `file` in the project to its end, failing unless it exits `expected`; its stdout. */
const command = async (file: string, args: readonly string[], expected = 0, variables: Readonly<Record<string, string | undefined>> = {}): Promise<string> => {
  const child = spawn(file, args, { cwd: project, env: withVariables(variables), stdio: ["ignore", "pipe", "pipe"], timeout: 90_000 });
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

// The release, as GitHub serves it, and its API, which says it is the newest on either channel; with a wrong checksum
// when asked.
let badChecksum = false;
const server = createServer((request, response) => {
  if (request.url === "/api/releases/latest") return void response.end(JSON.stringify({ tag_name: `v${version}` }));
  if (request.url === "/api/releases?per_page=1") return void response.end(JSON.stringify([{ tag_name: `v${version}` }]));
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
  env.LEMMA_RELEASE_API_URL = `${env.LEMMA_RELEASE_BASE_URL}/api`;

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

  // A channel's newest, as the API says, and what lemma version and lemma update make of the install.
  await command("sh", [installer], 0, { LEMMA_VERSION: undefined, LEMMA_CHANNEL: "nightly" });
  const about = JSON.parse(await command(lemma, ["version", "--json"])) as Record<string, unknown>;
  assert.deepEqual(
    { ...about, commit: typeof about.commit, built: typeof about.built, root: typeof about.root },
    { version, kind: "release", channel: "nightly", link: lemma, dataDir: data, node: about.node, commit: "string", built: "string", root: "string" },
    "lemma version says what the release is and how it was installed",
  );
  assert.deepEqual(JSON.parse(await command(lemma, ["update", "--check", "--json"])), {
    version,
    channel: "nightly",
    newest: version,
    newer: false,
    older: false,
  });
  const before = await realpath(lemma);
  assert.deepEqual(JSON.parse(await command(lemma, ["update", "--channel", "stable", "--json"])), {
    updated: true,
    from: version,
    version,
    channel: "stable",
    root: dirname(dirname(await realpath(lemma))),
    link: lemma,
    host: null,
  });
  assert.notEqual(await realpath(lemma), before, "lemma update installs with the installer the release carries");
  assert.equal((JSON.parse(await command(lemma, ["version", "--json"])) as { channel: string }).channel, "stable");
  const service = JSON.parse(await command(lemma, ["service", "install", "--print", "--json"])) as { command: string[] };
  assert.deepEqual(service.command, [lemma, "serve", "--no-open"], "a service runs the lemma the installer links, so the newest release");
  console.log("installer: install, reinstall, pruning, a bad checksum, channels, lemma version, and lemma update passed");

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
  // A host in the terminal starts again in the background, on the same port, for the same project; it runs the rest.
  const serving = JSON.parse(await readFile(join(home, ".lemma/transport.json"), "utf8")) as { url: string; pid: number };
  const restarted = JSON.parse(await command(lemma, ["restart", "--json"])) as { url: string; pid: number; previous: number };
  assert.deepEqual([restarted.url, restarted.previous], [serving.url, serving.pid], "lemma restart starts the host again where it was");
  restartedPid = restarted.pid;
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

  // However many installs come after, the release a host runs from stays: here the one lemma restart started it on.
  const hosting = dirname(dirname(await realpath(lemma)));
  await command("sh", [installer]);
  await command("sh", [installer]);
  assert.ok(existsSync(hosting), "an install keeps the release a running host started on");
  assert.equal(await releases(), 3, "and the one before the new one, removing the rest");
  console.log(
    "release: host, lemma restart, plugins, web app, a TypeScript plugin file, file search, the agent's CLI, a turn, and pruning around a running host passed",
  );
} finally {
  if (restartedPid !== undefined) await command(lemma, ["stop", "--force"]).catch((error: unknown) => console.error(error));
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
