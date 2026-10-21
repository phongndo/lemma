import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { Deferred, Effect } from "effect";
import type { Scope } from "effect";
import type { PluginStatus } from "@lemma/contracts";
import { HOST_FLAGS } from "@lemma/host/launch";
import { SHUTDOWN_TIMEOUT_MS } from "@lemma/host/limits";
import { CliError, ExitCode } from "./command.ts";
import type { Failure, Io, Output } from "./command.ts";

/*
 * `lemma plugins check [path]`: a plugin as the host makes of it, before it is installed. A host of its own starts in
 * a home of its own with the plugin linked into its plugins directory, and the plugin's state, fault, what it provides
 * and requires, the hooks it handles, what it adds, and what the host warned of it are read back as any client reads
 * them; then the host stops and the home is removed. It is the check an author outside this repository runs first.
 */

// From this file's folder, which is the bundle's too (`dist/lemma.mjs`): the launcher either way, as `lemma serve` runs.
const launcher = fileURLToPath(new URL("../bin/lemma.js", import.meta.url));
/**
 * How long a host has to start; to stop once asked (`lemma: stopped`), past its own limit; and then to exit, which it
 * does at once unless something its plugin started keeps it running.
 */
const START_MS = 30_000;
const STOP_MS = SHUTDOWN_TIMEOUT_MS + 5_000;
/** How long the host has to answer the check, once it serves: a plugin blocking its event loop holds the answer back. */
const ASK_MS = 15_000;
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

/** What a host's stop, and the failed first host's (`failed`), say of the plugin. */
const stopProblems = (stopped: Stopped, failed: Stopped | undefined): string[] => [
  ...(stopped === "lingered"
    ? [`The host stopped but did not exit: something the plugin started (a timer, a socket, a child process) keeps it running`]
    : stopped === "stuck"
      ? [`The host did not finish stopping within ${STOP_MS / 1000} s of being asked to`]
      : stopped === "orphaned"
        ? ["Processes the plugin started were still running once the host had exited"]
        : []),
  ...(failed === "orphaned" ? ["Processes the plugin started were still running once its host had failed to start"] : []),
];

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

/** Each host's stop, once begun: stopping it again says the same, and signals no group its pid may lead by then. */
const stops = new WeakMap<ChildProcess, Promise<Stopped>>();

/**
 * Stops a host: SIGTERM, then, once it says it is done (`stopped`), `EXIT_MS` to exit, else, or if it never says so
 * within `STOP_MS`, its whole process group is killed.
 */
const stopHost = (child: ChildProcess, stopped: Promise<void>): Promise<Stopped> => {
  const stopping = stops.get(child) ?? stopOnce(child, stopped);
  stops.set(child, stopping);
  return stopping;
};
const stopOnce = (child: ChildProcess, stopped: Promise<void>): Promise<Stopped> =>
  new Promise((done) => {
    // Never spawned: nothing runs.
    if (child.pid === undefined) return done("exited");
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
 * a process group of its own, so stopping it stops whatever its plugin started there (a process the plugin starts in a
 * group of its own is out of reach, and goes unreported), and the terminal's Ctrl-C reaches the check alone, which
 * stops it. Its stdin is a pipe from the check (`LEMMA_SUPERVISED`), so a check that dies without stopping it (a second
 * Ctrl-C, a SIGKILL) stops it all the same.
 */
const hostIn = (home: string, env: Readonly<Record<string, string | undefined>>) =>
  Effect.gen(function* () {
    const ready = yield* Deferred.make<boolean>();
    let doneStopping!: () => void;
    const stopped = new Promise<void>((resolve) => (doneStopping = resolve));
    const lines: string[] = [];
    const child = yield* Effect.acquireRelease(
      Effect.sync(() =>
        spawn(process.execPath, ["--conditions=lemma-source", ...HOST_FLAGS, launcher, "serve", "--no-open"], {
          env: {
            ...process.env,
            ...env,
            LEMMA_HOME: home,
            // The check's own home is the default profile's: a profile the caller's shell names is none of its.
            LEMMA_PROFILE: undefined,
            LEMMA_URL: undefined,
            LEMMA_TOKEN: undefined,
            LEMMA_ENV: undefined,
            LEMMA_SUPERVISED: "1",
          } as NodeJS.ProcessEnv,
          stdio: ["pipe", "pipe", "pipe"],
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
    let unspawned = false;
    child.on("error", (error) => {
      // Not started at all (it is spawned once, and stopped only by signals, which fail quietly).
      if (child.pid !== undefined) return;
      unspawned = true;
      lines.push(`lemma: error: could not start a host: ${error.message}`);
      Deferred.doneUnsafe(ready, Effect.succeed(false));
    });
    const started = yield* Deferred.await(ready).pipe(Effect.timeoutOrElse({ duration: START_MS, orElse: () => Effect.succeed(false) }));
    const ended = unspawned || child.exitCode !== null || child.signalCode !== null;
    return { started, ended, lines, stop: Effect.promise(() => stopHost(child, stopped)) };
  });

/** Runs `argv` against the host in `home` and reads its JSON answer, or what failed (within `ASK_MS`). */
const ask = (run: Runner, io: Io, home: string, argv: readonly string[]): Effect.Effect<unknown> =>
  Effect.promise(async () => {
    let out = "";
    let err = "";
    const code = await run([...argv, "--json"], {
      ...io,
      env: { ...io.env, LEMMA_HOME: home, LEMMA_PROFILE: undefined, LEMMA_URL: undefined, LEMMA_TOKEN: undefined, LEMMA_ENV: undefined },
      out: (text) => void (out += `${text}\n`),
      err: (text) => void (err += `${text}\n`),
    });
    return code === 0 ? (JSON.parse(out) as unknown) : { error: err.trim() };
  }).pipe(Effect.timeoutOrElse({ duration: ASK_MS, orElse: () => Effect.succeed({ error: `no answer within ${ASK_MS / 1000} s` }) }));

/** One plugin from the checked path, as the host made of it. */
export interface Checked {
  readonly id: string;
  readonly state: string;
  readonly fault?: string;
  readonly provides: readonly string[];
  readonly requires: readonly string[];
  /** The domain contracts it says it is written against, as `name@version`; absent when it says nothing. */
  readonly uses?: readonly string[];
  readonly hooks: readonly string[];
  readonly adds: readonly string[];
  /** What the host printed of it: a warning, an error. */
  readonly warnings: readonly string[];
}

/** `lemma plugins check [path]`: a host of its own with the plugin in it, then what it made of it, and stopped. */
export const checkPlugin = (path: string | undefined, io: Io, run: Runner): Effect.Effect<Output, Failure, Scope.Scope> => {
  const plugin = resolve(io.cwd, path ?? ".");
  return Effect.gen(function* () {
    if (!existsSync(plugin)) return yield* fail("NotFound", `${plugin} does not exist`);
    const home = yield* homeWith(plugin);
    let host = yield* hostIn(home, io.env);
    // A plugin of one's own is required to start, so one that fails keeps the host down (it exits, naming it): once
    // more, not required, so the host starts with it failed, and says why as it says of any plugin.
    const failing = named(host.lines);
    // How the first host, failed, left things: stopped first, so the retry starts as clean as it did.
    let failed: Stopped | undefined;
    if (!host.started && host.ended && failing.length > 0) {
      failed = yield* host.stop;
      yield* Effect.promise(() => configure(home, failing));
      host = yield* hostIn(home, io.env);
    }
    if (!host.started) {
      // A host neither serving nor ended is still starting: it goes before anything else does, and one that ended
      // takes its group with it, so either says what it left.
      const ended = host.ended;
      const problems = stopProblems(yield* host.stop, failed);
      // What it said, but its advice to start without plugin files, which is no help here.
      const said = host.lines.filter((line) => !line.startsWith("lemma: --safe"));
      const why = ended ? "The host did not start with it:" : `The host had not started with it after ${START_MS / 1000} s:`;
      return {
        json: { started: false, ...(ended ? {} : { timedOut: true }), output: said, ...(problems.length === 0 ? {} : { problems }) },
        text: [why, ...said.map((line) => `  ${line}`), ...(problems.length === 0 ? [] : ["problems:", ...problems.map((problem) => `  ${problem}`)])].join(
          "\n",
        ),
        exit: ExitCode.failed,
      } satisfies Output;
    }
    const listed = yield* ask(run, io, home, ["plugins"]);
    if (!Array.isArray(listed)) {
      // The host it started, unanswering: what it printed says why (a stall names the plugin), and its stop what it left.
      const problems = [`Could not list the host's plugins: ${(listed as { readonly error?: string }).error ?? ""}`, ...stopProblems(yield* host.stop, failed)];
      return {
        json: { problems, output: host.lines },
        text: ["problems:", ...problems.map((problem) => `  ${problem}`), ...host.lines.map((line) => `  ${line}`)].join("\n"),
        exit: ExitCode.failed,
      } satisfies Output;
    }
    const own = (listed as readonly PluginStatus[]).filter((status) => status.source === "user");
    const checked: Checked[] = own.map((status) => ({
      id: status.id,
      state: status.state === "disabled" ? (status.enabled ? "not loaded" : "off") : status.state,
      ...(status.fault === undefined ? {} : { fault: status.fault.message }),
      provides: status.provides,
      requires: status.requires,
      ...(status.uses === undefined ? {} : { uses: status.uses }),
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
      ...stopProblems(stopped, failed),
    ];
    const text = [
      ...checked.flatMap((status) => [
        `${status.id}: ${status.state}`,
        ...(status.provides.length === 0 ? [] : [`  provides ${status.provides.join(", ")}`]),
        ...(status.requires.length === 0 ? [] : [`  requires ${status.requires.join(", ")}`]),
        ...(status.uses === undefined
          ? [
              `  warning: it names no contract versions (uses: ["lemma/tools@1", …], or [] for none), so a change to a contract it uses will not be caught when it loads`,
            ]
          : status.uses.length === 0
            ? []
            : [`  uses ${status.uses.join(", ")}`]),
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
  });
};
