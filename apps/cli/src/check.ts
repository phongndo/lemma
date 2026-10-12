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
/**
 * How long a host has to start; to stop once asked (`lemma: stopped`), past its own shutdown limit (40 s); and then to
 * exit, which it does at once unless something its plugin started keeps it running.
 */
const START_MS = 30_000;
const STOP_MS = 45_000;
const EXIT_MS = 2_000;

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
 * How a host stopped: `exited` as asked; `lingered`, done stopping but kept running by something its plugin started
 * (a timer, a socket, a child process); `stuck`, not done stopping within `STOP_MS`; `orphaned`, exited, leaving
 * processes its plugin started running.
 */
type Stopped = "exited" | "lingered" | "stuck" | "orphaned";

/** Kills the host's process group (it leads one of its own: `hostIn`), and so whatever its plugin started; true if any was left. */
const killGroup = (child: ChildProcess): boolean => {
  if (child.pid === undefined) return false;
  try {
    process.kill(-child.pid, "SIGKILL");
    return true;
  } catch {
    return false;
  }
};

/**
 * Stops a host: SIGTERM, then, once it says it is done (`stopped`), `EXIT_MS` to exit, else, or if it never says so
 * within `STOP_MS`, its whole process group is killed.
 */
const stopHost = (child: ChildProcess, stopped: Promise<void>): Promise<Stopped> =>
  new Promise((done) => {
    if (child.exitCode !== null || child.signalCode !== null) return done(killGroup(child) ? "orphaned" : "exited");
    let outcome: Stopped = "exited";
    const kill = (why: Stopped) => {
      outcome = why;
      killGroup(child);
      child.kill("SIGKILL");
    };
    let exiting: ReturnType<typeof setTimeout> | undefined;
    const stuck = setTimeout(() => kill("stuck"), STOP_MS);
    void stopped.then(() => {
      clearTimeout(stuck);
      exiting = setTimeout(() => kill("lingered"), EXIT_MS);
    });
    child.once("exit", () => {
      clearTimeout(stuck);
      clearTimeout(exiting);
      // Exited as asked, but what its plugin started outlives it.
      if (killGroup(child) && outcome === "exited") outcome = "orphaned";
      done(outcome);
    });
    child.kill("SIGTERM");
  });

/**
 * A host of its own in `home`, until the scope closes: what it printed, once it serves (`started`), has ended
 * (`ended`), or did neither within `START_MS`; and `stop`, which stops it, if it runs, saying how (`Stopped`). It leads
 * a process group of its own, so stopping it stops whatever its plugin started, and the terminal's Ctrl-C reaches the
 * check alone, which stops it.
 */
const hostIn = (home: string, env: Readonly<Record<string, string | undefined>>) =>
  Effect.gen(function* () {
    const ready = yield* Deferred.make<boolean>();
    let doneStopping!: () => void;
    const stopped = new Promise<void>((resolve) => (doneStopping = resolve));
    const lines: string[] = [];
    const child = yield* Effect.acquireRelease(
      Effect.sync(() =>
        spawn(process.execPath, ["--conditions=lemma-source", cliMain, "serve", "--no-open"], {
          env: { ...process.env, ...env, LEMMA_HOME: home, LEMMA_URL: undefined, LEMMA_TOKEN: undefined } as NodeJS.ProcessEnv,
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
        }),
      ),
      (child) => Effect.promise(() => stopHost(child, stopped)),
    );
    for (const stream of [child.stdout, child.stderr]) {
      createInterface({ input: stream }).on("line", (line) => {
        lines.push(line);
        // Printed once it serves, after its plugins have started; and once it is done stopping.
        if (line.startsWith("lemma: open ")) Deferred.doneUnsafe(ready, Effect.succeed(true));
        if (line === "lemma: stopped") doneStopping();
      });
    }
    child.on("close", () => Deferred.doneUnsafe(ready, Effect.succeed(false)));
    const started = yield* Deferred.await(ready).pipe(Effect.timeoutOrElse({ duration: START_MS, orElse: () => Effect.succeed(false) }));
    const ended = child.exitCode !== null || child.signalCode !== null;
    return { started, ended, lines, stop: Effect.promise(() => stopHost(child, stopped)) };
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
        ...(stopped === "lingered"
          ? [`The host stopped but did not exit: something the plugin started (a timer, a socket, a child process) keeps it running`]
          : stopped === "stuck"
            ? [`The host did not finish stopping within ${STOP_MS / 1000} s of being asked to`]
            : stopped === "orphaned"
              ? ["Processes the plugin started were still running once the host had exited"]
              : []),
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
