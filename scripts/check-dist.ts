import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { archiveName, releaseTag, version } from "./dist-config.ts";
import type { Target } from "./dist-config.ts";
import { settled } from "./e2e.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const archive = resolve(process.argv[2] ?? join(root, "dist", archiveName(`${process.platform}-${process.arch}` as Target)));
const temporary = await mkdtemp(join(tmpdir(), "lemma-install-check-"));
const project = join(temporary, "test project");
const home = join(temporary, "home");
const bin = join(temporary, "user's bin");
const data = join(temporary, "user's data");
const stubs = join(temporary, "stubs");
const cli = join(bin, "lemma");
const children: ChildProcess[] = [];
const env: NodeJS.ProcessEnv = {
  HOME: home,
  LEMMA_HOME: join(home, ".lemma"),
  PATH: `${stubs}:/usr/bin:/bin`,
  LEMMA_VERSION: releaseTag,
  LEMMA_INSTALL_DIR: bin,
  LEMMA_DATA_DIR: data,
};

async function command(file: string, args: string[], expected = 0): Promise<string> {
  const child = spawn(file, args, { cwd: project, env, stdio: ["ignore", "pipe", "pipe"], timeout: 90_000 });
  children.push(child);
  let out = "";
  let err = "";
  child.stdout.on("data", (data) => {
    out += data;
  });
  child.stderr.on("data", (data) => {
    err += data;
  });
  const [code] = await once(child, "close");
  assert.equal(code, expected, `${file} ${args.join(" ")}\n${out}\n${err}`);
  return out;
}

function launch(file: string, args: string[], variables: NodeJS.ProcessEnv = {}) {
  const child = spawn(file, args, { cwd: project, env: { ...env, ...variables }, stdio: ["pipe", "pipe", "pipe"] });
  children.push(child);
  let output = "";
  child.stdout.on("data", (data) => {
    output += data;
  });
  child.stderr.on("data", (data) => {
    output += data;
  });
  return {
    child,
    ready: async (pattern: RegExp) => {
      const match = await settled(
        async () => pattern.exec(output) ?? undefined,
        () => true,
        30_000,
      );
      assert.ok(match, `Process did not reach ${pattern}: ${output}`);
      return match;
    },
  };
}

let badChecksum = false;
const server = createServer((request, response) => {
  const name = request.url?.slice(1);
  if (name !== basename(archive) && name !== `${basename(archive)}.sha256`) {
    response.writeHead(404).end();
    return;
  }
  if (badChecksum && name.endsWith(".sha256")) {
    response.end(`${"0".repeat(64)}  ${basename(archive)}\n`);
    return;
  }
  createReadStream(join(dirname(archive), name))
    .on("error", () => response.destroy())
    .pipe(response);
});

try {
  for (const directory of [project, home, stubs, join(home, ".lemma/plugins")]) await mkdir(directory, { recursive: true });
  // Prove the package uses its runtime, including the CLI command advertised to agents.
  await writeFile(join(stubs, "node"), "#!/bin/sh\necho 'System Node must not be used' >&2\nexit 99\n");
  await chmod(join(stubs, "node"), 0o755);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  env.LEMMA_RELEASE_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const installer = join(root, "scripts/install.sh");
  await command("sh", [installer]);
  assert.equal((await command(cli, ["--version"])).trim(), `lemma ${version}`);
  assert.match(await command(cli, ["--help"]), /Usage: lemma/);
  await command(cli, ["status", "--json"], 3);
  const first = await realpath(cli);
  await command("sh", [installer]);
  assert.notEqual(await realpath(cli), first, "Reinstall should switch to a fresh, complete release");
  const installed = await realpath(cli);
  badChecksum = true;
  await command("sh", [installer], 1);
  assert.equal(await realpath(cli), installed, "A bad download must leave the installed release intact");
  badChecksum = false;
  console.log("installer: fresh install, update, checksum failure, and bundled runtime passed");

  await command("git", ["init", "--quiet"]);
  await writeFile(join(project, "needle.txt"), "distribution test\n");
  await command("git", ["add", "needle.txt"]);
  const mock = launch(process.execPath, [join(root, "scripts/mock-openai.ts")], { PORT: "0", PACE_MS: "0" });
  const mockUrl = (await mock.ready(/listening on (\S+)/))[1]!;
  await writeFile(
    join(home, ".lemma/config.jsonc"),
    JSON.stringify({
      plugins: {
        transport: { config: { port: 0 } },
        llm: { config: { providers: [{ id: "mock", api: "openai-completions", baseUrl: mockUrl, models: [{ id: "scripted" }] }] } },
      },
    }),
  );
  await writeFile(
    join(home, ".lemma/plugins/installed.ts"),
    `
import { Effect } from "effect";
import { definePlugin } from "@lemma/core";
import { Paths } from "@lemma/contracts";
export default definePlugin({
  id: "installed-check",
  requires: { paths: Paths },
  setup: function* ({ paths }) {
    yield* Effect.sync(() => { if (!paths.home) throw new Error("missing shared host service"); });
  },
});
`,
  );
  const host = launch(cli, ["serve", "--no-open"]);
  await host.ready(/lemma: open /);
  const status = JSON.parse(await command(cli, ["status", "--json"]));
  assert.equal(status.info.cwd, await realpath(project));
  assert.ok(status.plugins.every((plugin: { state: string }) => plugin.state === "active"));
  assert.ok(status.plugins.some((plugin: { id: string }) => plugin.id === "installed-check"));
  const { url, token } = JSON.parse(await readFile(join(home, ".lemma/transport.json"), "utf8")) as { url: string; token: string };
  const page = await fetch(url);
  assert.equal(page.status, 200);
  const html = await page.text();
  const script = /src="([^"]+\.js)"/.exec(html)?.[1];
  assert.ok(script, "Release must serve the built web app");
  assert.equal((await fetch(new URL(script, url))).status, 200);
  assert.equal((await fetch(`${url}/threads/installed-smoke`)).status, 200);
  assert.equal((await fetch(`${url}/api/health`)).status, 401);
  assert.equal((await fetch(`${url}/api/health`, { headers: { authorization: `Bearer ${token}` } })).status, 200);
  const files = await settled(async () => {
    const result = await command(cli, ["workspace", "files", "needle", "--json"]);
    return result.includes("needle.txt") || undefined;
  });
  assert.equal(files, true, "The shipped native file-search module must work");
  const agent = JSON.parse(await command(cli, ["plugins", "config", "agent", "--json"]));
  assert.equal((await command("sh", ["-c", `${agent.values.cli} --version`])).trim(), `lemma ${version}`);
  const turn = await command(cli, ["run", "new", "test installed Lemma", "--model", "mock/scripted", "--follow", "--json"]);
  const result = JSON.parse(turn.trim().split("\n").at(-1)!);
  assert.equal(result.type, "result");
  assert.equal(result.reason, "done");
  assert.equal(result.toolCalls, 1);
  console.log("installed app: host, web assets, auth, TypeScript plugin, native file search, and agent/tool turn passed");
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
