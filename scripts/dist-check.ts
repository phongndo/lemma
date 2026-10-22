import assert from "node:assert/strict";
import { once } from "node:events";
import { createReadStream, existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hostTarget, packageName, parsePackageName, version as checkoutVersion } from "./dist-config.ts";
import { startTrial } from "./dist-trial.ts";
import { settled } from "./e2e.ts";

/*
 * Installs a release archive for this platform (`pnpm dist` builds it at the checkout's version; or pass its path) as a
 * user would, with scripts/install.sh, outside the checkout and with a `node` on PATH that fails (dist-trial.ts), and
 * as npm's lemma-harness fetches it, then runs it: a host, the web app it serves, a plugin file in TypeScript, the
 * native file search, the CLI the agent is told of, and an agent's turn that runs a tool, on the scripted provider (no
 * API key).
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const archive = resolve(process.argv[2] ?? join(root, "dist", `${packageName(checkoutVersion, hostTarget())}.tar.gz`));
const named = parsePackageName(basename(archive));
assert.ok(named, `${basename(archive)} is not named as a release archive, lemma-v<version>-<target>.tar.gz`);
assert.equal(named.target, hostTarget(), `${basename(archive)} is for another platform than this one`);
const { version } = named;
const trial = await startTrial("dist-check");
const { command, launch, lemmaHome } = trial;
const bin = join(trial.temporary, "user's bin");
const data = join(trial.temporary, "data");
const lemma = join(bin, "lemma");
/** The host lemma restart started, in the background, which the check stops at its end. */
let restartedPid: number | undefined;
Object.assign(trial.env, { LEMMA_VERSION: version, LEMMA_INSTALL_DIR: bin, LEMMA_DATA_DIR: data });

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
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  trial.env.LEMMA_RELEASE_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  trial.env.LEMMA_RELEASE_API_URL = `${trial.env.LEMMA_RELEASE_BASE_URL}/api`;

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

  // Installed by version, it is pinned: it follows no channel, so checks none, until one is named.
  assert.equal((JSON.parse(await command(lemma, ["version", "--json"])) as { channel?: string }).channel, undefined);
  assert.deepEqual(JSON.parse(await command(lemma, ["update", "--check", "--json"])), { version, newer: false });
  await command(lemma, ["update"], 2);

  // A channel's newest, as the API says, and what lemma version and lemma update make of the install.
  await command("sh", [installer], 0, { LEMMA_VERSION: undefined, LEMMA_CHANNEL: "nightly" });
  const about = JSON.parse(await command(lemma, ["version", "--json"])) as Record<string, unknown>;
  assert.deepEqual(
    { ...about, commit: typeof about.commit, built: typeof about.built, root: typeof about.root },
    {
      version,
      kind: "release",
      installer: "script",
      update: "lemma update",
      channel: "nightly",
      link: lemma,
      dataDir: data,
      node: about.node,
      commit: "string",
      built: "string",
      root: "string",
    },
    "lemma version says what the release is and how it was installed",
  );
  assert.deepEqual(JSON.parse(await command(lemma, ["update", "--check", "--json"])), {
    version,
    channel: "nightly",
    newest: version,
    newer: false,
  });
  const before = await realpath(lemma);
  assert.deepEqual(JSON.parse(await command(lemma, ["update", "--channel", "stable", "--json"])), {
    updated: true,
    from: version,
    version,
    installer: "script",
    channel: "stable",
    root: dirname(dirname(await realpath(lemma))),
    link: lemma,
    command: lemma,
    host: null,
  });
  assert.notEqual(await realpath(lemma), before, "lemma update installs with the installer the release carries");
  assert.equal((JSON.parse(await command(lemma, ["version", "--json"])) as { channel: string }).channel, "stable");
  const service = JSON.parse(await command(lemma, ["service", "install", "--print", "--json"])) as { command: string[] };
  assert.deepEqual(service.command, [lemma, "serve", "--no-open"], "a service runs the lemma the installer links, so the newest release");
  console.log("installer: install, reinstall, pruning, a bad checksum, channels, lemma version, and lemma update passed");

  // npm's lemma-harness, as npm installs it: its launcher fetches this release into a directory of its own the first
  // time it runs, on whatever Node.js runs it (packaging/npm).
  const npmData = join(trial.temporary, "npm");
  const launcher = join(trial.temporary, "npm prefix/lib/node_modules/lemma-harness");
  await cp(join(root, "packaging/npm"), launcher, { recursive: true });
  const manifest = JSON.parse(await readFile(join(launcher, "package.json"), "utf8")) as Record<string, unknown>;
  await writeFile(join(launcher, "package.json"), JSON.stringify({ ...manifest, version }));
  const npmLemma = (args: readonly string[]) => command(process.execPath, [join(launcher, "bin/lemma.js"), ...args], 0, { LEMMA_NPM_DIR: npmData });
  assert.equal((await npmLemma(["--version"])).trim(), version);
  const viaNpm = JSON.parse(await npmLemma(["version", "--json"])) as Record<string, unknown>;
  assert.deepEqual(
    { installer: viaNpm.installer, channel: viaNpm.channel, link: viaNpm.link, root: viaNpm.root },
    { installer: "npm", channel: "stable", link: join(npmData, "current/bin/lemma"), root: join(npmData, basename(archive, ".tar.gz")) },
    "npm's lemma runs the release it fetched, and says npm installed it",
  );
  assert.deepEqual(JSON.parse(await npmLemma(["update", "--check", "--json"])), { version, channel: "stable", newest: version, newer: false });
  console.log("npm: lemma-harness fetches its release, runs it, and checks for updates on stable passed");

  await trial.provide();
  // A user's plugin file, in TypeScript, importing what the host links into the home.
  await mkdir(join(lemmaHome, "plugins"));
  await writeFile(
    join(lemmaHome, "plugins/greet.ts"),
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
  const serving = JSON.parse(await readFile(join(lemmaHome, "transport.json"), "utf8")) as { url: string; pid: number };
  const restarted = JSON.parse(await command(lemma, ["restart", "--json"])) as { url: string; pid: number; previous: number };
  assert.deepEqual([restarted.url, restarted.previous], [serving.url, serving.pid], "lemma restart starts the host again where it was");
  restartedPid = restarted.pid;
  const plugins = await trial.checkHost(lemma, version);
  assert.ok(
    plugins.some((plugin) => plugin.id === "greet"),
    "the plugin file loads",
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
  await trial.close();
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
}
