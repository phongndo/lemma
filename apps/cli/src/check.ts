import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { Deferred, Effect } from "effect";
import type { PluginStatus } from "@lemma/contracts";
import { CliError, ExitCode } from "./command.ts";
import type { Io, Output, Unattached } from "./command.ts";

/*
 * `lemma plugins check [path]`: a plugin as the host makes of it, before it is installed. A host of its own starts in
 * a home of its own with the plugin linked into its plugins directory, and the plugin's state, fault, what it provides
 * and requires, the hooks it handles, what it adds, and what the host warned of it are read back as any client reads
 * them; then the host stops and the home is removed. It is the check an author outside this repository runs first.
 */

const cliMain = fileURLToPath(new URL("./main.ts", import.meta.url));
/** How long a host has to start, and to exit once asked to stop: past its plugins' dispose deadlines (10 s). */
const START_MS = 30_000;
const STOP_MS = 15_000;

/** How a command runs another (`run` in cli.ts), with `io` changed: to read a host's answers as JSON. */
export type Runner = (argv: readonly string[], io: Io) => Promise<number>;

const fail = (code: string, message: string) => new CliError({ code, message, exit: ExitCode.failed });

/** Writes `home`'s config: the transport on a free port, and `optional` plugins not required to start. */
const configure = (home: string, optional: readonly string[] = []) =>
  writeFile(
    join(home, "config.jsonc"),
    `${JSON.stringify({ plugins: { "transport.server": { config: { port: 0 } }, ...Object.fromEntries(optional.map((id) => [id, { required: false }])) } }, null, 2)}\n`,
  );

/** A home of its own with the plugin at `path` (a file or a folder) linked into its plugins directory, removed when the scope closes. */
const homeWith = (path: string) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const home = await mkdtemp(join(tmpdir(), "lemma-check-"));
      await configure(home);
      await mkdir(join(home, "plugins"));
      await symlink(path, join(home, "plugins", basename(path)), statSync(path).isDirectory() ? "dir" : "file");
      return home;
    }),
    (home) => Effect.promise(() => rm(home, { recursive: true, force: true })),
  );

/** A folder plugin's `package.json`, or why it cannot be read: the host takes a folder whose manifest it cannot parse for no plugin, and says nothing. */
const readManifest = (path: string): { readonly manifest?: { readonly lemma?: { readonly web?: unknown } }; readonly problem?: string } => {
  try {
    return { manifest: JSON.parse(readFileSync(path, "utf8")) as { readonly lemma?: { readonly web?: unknown } } };
  } catch (error) {
    return { problem: `Its package.json cannot be read: ${error instanceof Error ? error.message : String(error)}` };
  }
};

/** The plugins a host's diagnostics name (`lemma: error [notes]: …`). */
const named = (lines: readonly string[]) => [...new Set(lines.flatMap((line) => /^lemma: (?:error|warning) \[([^\]]+)\]/.exec(line)?.[1] ?? []))];

/**
 * Stops a host: SIGTERM, then, if it has not exited within `STOP_MS` (something the plugin started keeps it running:
 * a timer, a socket, a child process), SIGKILL. Resolves with whether it exited as asked.
 */
const stopHost = (child: ChildProcess): Promise<boolean> =>
  new Promise((done) => {
    if (child.exitCode !== null || child.signalCode !== null) return done(true);
    let forced = false;
    const timer = setTimeout(() => {
      forced = true;
      child.kill("SIGKILL");
    }, STOP_MS);
    child.once("exit", () => {
      clearTimeout(timer);
      done(!forced);
    });
    child.kill("SIGTERM");
  });

/**
 * A host of its own in `home`, until the scope closes: what it printed, once it serves (`started`), has ended
 * (`ended`), or did neither within `START_MS`; and `stop`, which stops it, if it runs, saying whether it exited as
 * asked.
 */
const hostIn = (home: string, env: Readonly<Record<string, string | undefined>>) =>
  Effect.gen(function* () {
    const ready = yield* Deferred.make<boolean>();
    const lines: string[] = [];
    const child = yield* Effect.acquireRelease(
      Effect.sync(() =>
        spawn(process.execPath, ["--conditions=lemma-source", cliMain, "serve", "--no-open"], {
          env: { ...process.env, ...env, LEMMA_HOME: home, LEMMA_URL: undefined, LEMMA_TOKEN: undefined } as NodeJS.ProcessEnv,
          stdio: ["ignore", "pipe", "pipe"],
        }),
      ),
      (child) => Effect.promise(() => stopHost(child)),
    );
    for (const stream of [child.stdout, child.stderr]) {
      createInterface({ input: stream }).on("line", (line) => {
        lines.push(line);
        // Printed once it serves, after its plugins have started.
        if (line.startsWith("lemma: open ")) Deferred.doneUnsafe(ready, Effect.succeed(true));
      });
    }
    child.on("close", () => Deferred.doneUnsafe(ready, Effect.succeed(false)));
    const started = yield* Deferred.await(ready).pipe(Effect.timeoutOrElse({ duration: START_MS, orElse: () => Effect.succeed(false) }));
    const ended = child.exitCode !== null || child.signalCode !== null;
    return { started, ended, lines, stop: Effect.promise(() => stopHost(child)) };
  });

/** Runs `argv` against the host in `home` and reads its JSON answer. */
const ask = (run: Runner, io: Io, home: string, argv: readonly string[]) =>
  Effect.promise(async () => {
    let out = "";
    let err = "";
    const code = await run([...argv, "--json"], {
      ...io,
      env: { ...io.env, LEMMA_HOME: home, LEMMA_URL: undefined, LEMMA_TOKEN: undefined },
      out: (text) => void (out += `${text}\n`),
      err: (text) => void (err += `${text}\n`),
    });
    return code === 0 ? (JSON.parse(out) as unknown) : { error: err.trim() };
  });

/** One plugin from the checked path, as the host made of it. */
export interface Checked {
  readonly id: string;
  readonly state: string;
  readonly fault?: string;
  readonly provides: readonly string[];
  readonly requires: readonly string[];
  readonly hooks: readonly string[];
  readonly adds: readonly string[];
  /** What the host printed of it: a warning, an error. */
  readonly warnings: readonly string[];
}

/** `lemma plugins check [path]`: a host of its own with the plugin in it, then what it made of it, and stopped. */
export const checkPlugin = (path: string | undefined, io: Io, run: Runner): Unattached => {
  const plugin = resolve(io.cwd, path ?? ".");
  return {
    unattached: Effect.gen(function* () {
      if (!existsSync(plugin)) return yield* fail("NotFound", `${plugin} does not exist`);
      const home = yield* homeWith(plugin);
      let host = yield* hostIn(home, io.env);
      // A plugin of one's own is required to start, so one that fails keeps the host down (it exits, naming it): once
      // more, not required, so the host starts with it failed, and says why as it says of any plugin.
      const failing = named(host.lines);
      if (!host.started && host.ended && failing.length > 0) {
        yield* Effect.promise(() => configure(home, failing));
        host = yield* hostIn(home, io.env);
      }
      if (!host.started) {
        // A host neither serving nor ended is still starting: it goes before anything else does.
        const ended = host.ended;
        if (!ended) yield* host.stop;
        // What it said, but its advice to start without plugin files, which is no help here.
        const said = host.lines.filter((line) => !line.startsWith("lemma: --safe"));
        const why = ended ? "The host did not start with it:" : `The host had not started with it after ${START_MS / 1000} s:`;
        return {
          json: { started: false, ...(ended ? {} : { timedOut: true }), output: said },
          text: [why, ...said.map((line) => `  ${line}`)].join("\n"),
          exit: ExitCode.failed,
        } satisfies Output;
      }
      const listed = yield* ask(run, io, home, ["plugins"]);
      if (!Array.isArray(listed)) return yield* fail("Failed", `Could not list the host's plugins: ${(listed as { readonly error?: string }).error ?? ""}`);
      const own = (listed as readonly PluginStatus[]).filter((status) => status.source === "user");
      const checked: Checked[] = own.map((status) => ({
        id: status.id,
        state: status.state === "disabled" ? (status.enabled ? "not loaded" : "off") : status.state,
        ...(status.fault === undefined ? {} : { fault: status.fault.message }),
        provides: status.provides,
        requires: status.requires,
        hooks: (status.hooks ?? []).map((hook) => hook.name),
        adds: (status.contributes ?? []).map((registry) => `${registry.name}: ${registry.keys?.join(", ") ?? `${registry.items} item(s)`}`),
        warnings: host.lines.filter((line) => (line.includes(`[${status.id}]`) || line.includes(`"${status.id}"`)) && /warning|error|fail/.test(line)),
      }));
      // Stopped before the report, so a plugin that keeps it running (a timer it never clears) is reported too.
      const stopped = yield* host.stop;
      const folder = statSync(plugin).isDirectory();
      const read = folder && existsSync(join(plugin, "package.json")) ? readManifest(join(plugin, "package.json")) : undefined;
      const web = typeof read?.manifest?.lemma?.web === "string" ? read.manifest.lemma.web : undefined;
      // A web half's id is its file's name, or its folder's: the host knows it by that.
      const name = folder ? basename(plugin) : basename(plugin, extname(plugin));
      const problems = [
        ...(read?.problem === undefined ? [] : [read.problem]),
        ...(read?.manifest?.lemma?.web !== undefined && web === undefined ? ["Its package.json's lemma.web is not a path"] : []),
        ...(own.length === 0 ? [`No host half loaded from ${plugin}: see the host's output`] : []),
        ...(web !== undefined && !existsSync(join(plugin, web)) ? [`Its web half ${web} does not exist`] : []),
        ...(web !== undefined && own.length > 0 && !own.some((status) => status.id === name)
          ? [
              `Its folder is named ${name}, its plugin ${own.map((status) => status.id).join(", ")}: name the folder for its plugin, so the host knows its web half's id`,
            ]
          : []),
        ...checked.flatMap((status) =>
          status.state === "active" ? [] : [`${status.id} is ${status.state}${status.fault === undefined ? "" : `: ${status.fault}`}`],
        ),
        ...(stopped
          ? []
          : [
              `The host did not exit within ${STOP_MS / 1000} s of being asked to stop: something the plugin started (a timer, a socket, a child process) keeps it running`,
            ]),
      ];
      const text = [
        ...checked.flatMap((status) => [
          `${status.id}: ${status.state}`,
          ...(status.provides.length === 0 ? [] : [`  provides ${status.provides.join(", ")}`]),
          ...(status.requires.length === 0 ? [] : [`  requires ${status.requires.join(", ")}`]),
          ...(status.hooks.length === 0 ? [] : [`  handles ${status.hooks.join(", ")}`]),
          ...status.adds.map((added) => `  adds ${added}`),
          ...status.warnings.map((line) => `  ${line}`),
        ]),
        ...(web === undefined ? [] : [`web half: ${web}`]),
        ...(problems.length === 0 ? ["no problems found"] : ["problems:", ...problems.map((problem) => `  ${problem}`)]),
        ...(own.length === 0 ? host.lines.map((line) => `  ${line}`) : []),
      ].join("\n");
      return {
        json: { plugins: checked, ...(web === undefined ? {} : { web }), problems, ...(own.length === 0 ? { output: host.lines } : {}) },
        text,
        ...(problems.length === 0 ? {} : { exit: ExitCode.failed }),
      } satisfies Output;
    }),
  };
};
