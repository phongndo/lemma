import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { appUrl } from "@lemma/contracts";
import { readDiscovery } from "@lemma/contracts/discovery";
import { resolvePaths } from "../src/paths.ts";

/**
 * `pnpm dev`: the host, the web app's dev server, and the desktop window on
 * them, for working on lemma.
 *
 * The host runs under `node --watch`, so it restarts when a file it imports
 * changes (a plugin, the contracts, the host itself); a turn the restart cuts
 * off resumes. The web app hot-reloads, through Vite's dev server, which
 * proxies `/rpc` and `/api` to the host. Quitting the window leaves the rest
 * running, and `pnpm dev:desktop` opens it again. Ctrl+C stops everything.
 */

const root = fileURLToPath(new URL("../../..", import.meta.url));
const web = join(root, "apps/web");
const desktop = join(root, "apps/desktop");
// Run directly: a wrapper such as `pnpm exec` does not pass a stop signal on, and would leave them running.
const vite = join(web, "node_modules/vite/bin/vite.js");
/** Electron's launcher, which passes a stop signal on to the app. */
const electron = join(desktop, "node_modules/electron/cli.js");
const project = process.env.INIT_CWD ?? process.cwd();
const { home } = resolvePaths({ env: process.env, cwd: project });
/** The address `pnpm dev:desktop` loads by default. */
const WEB_PORT = 5173;
const STARTUP_TIMEOUT_MS = 30_000;

const say = (message: string) => console.log(`lemma dev: ${message}`);
const discover = () => Effect.runPromise(readDiscovery(home));
/** Whether nothing listens on the port, so what answers there later is the server this starts. */
const free = (port: number) =>
  new Promise<boolean>((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });

const already = await discover();
if (already !== undefined) {
  say(`a host is already running (pid ${already.pid}, ${already.url}). Stop it first, so the one this starts can restart on edits.`);
  process.exit(1);
}
if (!(await free(WEB_PORT))) {
  say(`port ${WEB_PORT} is in use, by another \`pnpm dev\` or \`pnpm dev:web\`? \`lsof -iTCP:${WEB_PORT} -sTCP:LISTEN\` names it.`);
  process.exit(1);
}

const children: ChildProcess[] = [];
let stopping = false;
const stop = (code: number) => {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill("SIGTERM");
};
// A wrapper or the terminal may signal more than once; each part is stopped once, from here.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => stop(0));

/**
 * One part of the dev setup; when it exits by itself, `after` runs, and by
 * default the rest stop too. It runs in its own process group, so a Ctrl+C
 * reaches it only as the one signal sent from here: the host would otherwise
 * get the terminal's and the one `--watch` passes on, and the second would end
 * it partway through shutting down.
 */
const run = (name: string, command: string, args: readonly string[], options: SpawnOptions, after?: () => void) => {
  // No stdin: outside the terminal's group, reading it would stop the process.
  const child = spawn(command, args, { stdio: ["ignore", "inherit", "inherit"], detached: true, ...options });
  children.push(child);
  child.once("exit", (code, signal) => {
    if (stopping) return;
    if (after !== undefined) return after();
    say(`the ${name} exited (${signal ?? code}), so everything stops`);
    stop(code ?? 1);
  });
};
/** Runs a command to its end, as part of starting up; true when it succeeds. */
const once = (command: string, args: readonly string[]) =>
  new Promise<boolean>((resolve) => spawn(command, args, { cwd: root, stdio: "inherit" }).once("exit", (code) => resolve(code === 0)));

// The host's own output stays: watch mode would clear the terminal the web server shares.
run(
  "host",
  process.execPath,
  ["--watch", "--watch-preserve-output", "--conditions=lemma-source", fileURLToPath(new URL("../src/main.ts", import.meta.url)), "--no-open"],
  {
    cwd: project,
    env: { ...process.env, INIT_CWD: project },
  },
);
let host = await discover();
for (const deadline = Date.now() + STARTUP_TIMEOUT_MS; host === undefined && !stopping && Date.now() < deadline; host = await discover()) await sleep(100);
if (host === undefined) {
  if (!stopping) say(`the host did not start listening within ${STARTUP_TIMEOUT_MS / 1000}s`);
  stop(1);
} else {
  run("web server", process.execPath, [vite, "--port", String(WEB_PORT), "--strictPort"], {
    cwd: web,
    env: { ...process.env, LEMMA_HOST_URL: host.url },
  });
  const page = `http://127.0.0.1:${WEB_PORT}`;
  for (let ready = false; !ready && !stopping;) {
    ready = await fetch(page).then(
      (response) => response.ok,
      () => false,
    );
    if (!ready) await sleep(200);
  }
  if (!stopping) say(`in a browser, open ${appUrl(page, "/", host.token)}`);
  // The window's main process loads the core as built.
  if (!stopping && !(await once("pnpm", ["--filter", "@lemma/core", "build"]))) say("the core did not build, so there is no window");
  else if (!stopping) {
    const { ELECTRON_RUN_AS_NODE: _, ...env } = process.env;
    run("window", process.execPath, [electron, "."], { cwd: desktop, env: { ...env, LEMMA_WEB_URL: page } }, () =>
      say("the window quit; `pnpm dev:desktop` opens another, and Ctrl+C stops the rest"),
    );
  }
}
