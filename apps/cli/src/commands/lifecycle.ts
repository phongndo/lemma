import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Duration, Effect } from "effect";
import { readDiscovery } from "@lemma/contracts/discovery";
import type { Discovery } from "@lemma/contracts/discovery";
import { profileOf } from "@lemma/contracts/profiles";
import { CliChannels } from "@lemma/cli";
import { callChannel } from "@lemma/client";
import { SHUTDOWN_TIMEOUT_MS } from "@lemma/host/limits";
import { hostFiles } from "@lemma/host/paths";
import { CliError, defineBuiltin, ExitCode, usage } from "../command.ts";
import type { Builtin, Globals, Io } from "../command.ts";
import { connect, homeOf, otherProtocol, rootOf, toCliError } from "../connect.ts";
import { startedByText } from "../format.ts";
import { readBuild } from "../release.ts";

/*
 * Starting, stopping, and keeping a host on this machine: the commands that
 * act on the local host whichever environment the others go to.
 */

const RUN = "Run a host";

/** How long `serve --detach` waits for the host it started to listen. */
const START = Duration.seconds(30);

/** These act on this machine's host: `--env` naming another is a mistake. */
const localOnly = (globals: Globals, what: string): CliError | undefined =>
  globals.env !== undefined && globals.env !== "local"
    ? usage(`${what} acts on this machine's host; run it on the machine --env ${globals.env} names`)
    : undefined;

/** The built web app the host serves by default: a checkout's, which `pnpm start` builds. */
const webIndex = fileURLToPath(new URL("../../../web/dist/index.html", import.meta.url));

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** The last `count` lines of `path`, or none without it. */
const tail = (path: string, count: number): Effect.Effect<readonly string[]> =>
  Effect.promise(() =>
    readFile(path, "utf8").then(
      (text) => {
        const lines = text.split("\n").filter((line, i, all) => line !== "" || i < all.length - 1);
        // Not slice(-count): slice(-0) is every line.
        return lines.slice(Math.max(0, lines.length - count));
      },
      () => [],
    ),
  );

/** The host's own flags, from `serve`'s. */
const hostArgs = (flags: { readonly port: number | undefined; readonly host: string | undefined; readonly safe: boolean }): string[] => [
  ...(flags.port === undefined ? [] : ["--port", String(flags.port)]),
  ...(flags.host === undefined ? [] : ["--host", flags.host]),
  ...(flags.safe ? ["--safe"] : []),
];

/** Waits for a host for `home` that `which` accepts to listen, for up to `within`: its entry, or undefined. */
const listening = (home: string, which: (entry: { readonly pid: number }) => boolean, within: Duration.Duration, gone?: () => boolean) =>
  Effect.gen(function* () {
    for (;;) {
      if (gone?.()) return undefined;
      const entry = yield* readDiscovery(home);
      if (entry !== undefined && which(entry)) return entry;
      yield* Effect.sleep("100 millis");
    }
  }).pipe(Effect.timeoutOrElse({ duration: within, orElse: () => Effect.succeed(undefined) }));

/** That no host started, with the end of its log, which says why. */
const notStarted = (home: string, timedOut: boolean, within: Duration.Duration) =>
  Effect.gen(function* () {
    const { log } = hostFiles(home);
    const lines = yield* tail(log, 15);
    return yield* new CliError({
      code: "NotStarted",
      message: `The host did not start${timedOut ? ` within ${Duration.toSeconds(within)}s` : ""}. The end of its log (${log}):\n${lines.join("\n")}`,
      exit: ExitCode.failed,
    });
  });

/** Starts this lemma's host for `home` in the background, for the project at `cwd`, and waits for it to listen. */
const startInBackground = (io: Io, home: string, cwd: string, args: readonly string[]) =>
  Effect.gen(function* () {
    if (io.self === undefined)
      return yield* new CliError({ code: "Unsupported", message: "This lemma cannot start itself in the background", exit: ExitCode.failed });
    const [command, ...rest] = io.self;
    const child = spawn(command!, [...rest, "serve", "--no-open", ...args], {
      cwd,
      env: { ...io.env, INIT_CWD: cwd, LEMMA_STARTED_BY: "cli" } as NodeJS.ProcessEnv,
      detached: true,
      stdio: "ignore",
    });
    let exited: number | null | undefined;
    child.once("exit", (code) => (exited = code));
    child.once("error", () => (exited = -1));
    child.unref();
    const started = yield* listening(
      home,
      (entry) => entry.pid === child.pid,
      START,
      () => exited !== undefined,
    );
    if (started === undefined) return yield* notStarted(home, exited === undefined, START);
    return { url: started.url, pid: started.pid, log: hostFiles(home).log };
  });

const serve = defineBuiltin({
  path: ["serve"],
  group: RUN,
  summary: "Run the host for this machine's home: here in the terminal, or in the background with --detach",
  description:
    "The host every client attaches to: the web app, the desktop app, and this command. There is one per home ($LEMMA_HOME, default ~/.lemma) and profile (--profile, see lemma profile): another start says which runs. --port and --host apply to this run only, over the config files; to keep a host running across reboots and crashes, see lemma service. Its output goes to the terminal and to its log (lemma logs).",
  flags: {
    detach: { type: "boolean", short: "d", description: "Start it in the background and return once it listens; lemma stop stops it" },
    port: { type: "number", description: "Listen on this port, this run only (0: any free one)" },
    host: { type: "string", placeholder: "address", description: "Bind this address, this run only (default loopback; see docs/remote.md before widening it)" },
    safe: {
      type: "boolean",
      description: "Run the bundled plugins as shipped, reading no config file or plugin file: the way back from a customization that keeps it down",
    },
    "no-open": { type: "boolean", description: "Do not open the web app in the browser once it serves" },
  },
  examples: ["lemma serve", "lemma serve --detach", "lemma serve --port 8080 --no-open"],
  run: ({ io, globals, flags }) =>
    Effect.gen(function* () {
      const wrong = localOnly(globals, "serve");
      if (wrong !== undefined) return yield* wrong;
      const home = homeOf(io);
      const profile = profileOf(io.env);
      if (profile !== undefined && !existsSync(home))
        return yield* new CliError({
          code: "NoProfile",
          message: `There is no profile "${profile}" (${home}); \`lemma profile create ${profile}\` makes one`,
          exit: ExitCode.failed,
        });
      const running = yield* readDiscovery(home);
      if (running !== undefined)
        return yield* new CliError({
          code: "Running",
          message: `A host already runs for ${home}: ${running.url} (pid ${running.pid}). \`lemma status\` shows it; \`lemma stop\` stops it.`,
          exit: ExitCode.failed,
        });
      // A note, which --json leaves out: its stderr is the error alone.
      if (!existsSync(webIndex) && !globals.json)
        io.err("lemma: the web app is not built, so the host serves no page: `nix develop -c pnpm --filter @lemma/web-app build` builds it");
      const args = hostArgs(flags);
      if (!flags.detach) {
        if (io.serve === undefined)
          return yield* new CliError({ code: "Unsupported", message: "This lemma cannot run a host in its own process", exit: ExitCode.failed });
        const serveHere = io.serve;
        yield* Effect.promise(() => serveHere([...args, ...(flags["no-open"] ? ["--no-open"] : [])], profileOf(io.env)));
        return undefined;
      }
      const started = yield* startInBackground(io, home, io.cwd, args);
      return {
        json: { url: started.url, pid: started.pid, home, log: started.log },
        text: `Started a host for ${home}: ${started.url} (pid ${started.pid}). Its log is ${started.log}; \`lemma stop\` stops it.`,
      };
    }),
});

/** Asks at the terminal whether to go on; no when there is none. */
const confirm = (io: Io, question: string): Effect.Effect<boolean> =>
  io.ask === undefined ? Effect.succeed(false) : Effect.promise(() => io.ask!(`${question} [y/N] `, false).then((answer) => /^y(es)?$/i.test(answer.trim())));

/** How long a host may take to stop: its own shutdown deadline, and a margin. */
const STOPPING = Duration.millis(SHUTDOWN_TIMEOUT_MS + 5_000);

/** What is known of the running host: what started it, the project it serves, whether in safe mode, and what stopping it would cut off. */
interface Running {
  readonly startedBy: string | undefined;
  readonly cwd: string | undefined;
  readonly safe: boolean;
  readonly items: readonly string[];
}

/**
 * The running host's facts, as it answers them. A host that cannot answer (one on another version of Lemma, whose
 * calls this one cannot read) is known by its transport.json alone, and only with `force`, as what stopping it would
 * cut off is not known; without, the failure says why (`OtherVersion`), and that `--force` goes on.
 */
const runningHost = (io: Io, entry: Discovery, force: boolean, verb: "stop" | "restart") =>
  Effect.gen(function* () {
    const { rpc, target } = yield* connect(io, { env: "local" });
    const answered = yield* Effect.result(
      Effect.all(
        [
          rpc["Host.Info"](),
          // A plugin's to say: a host that cannot is taken to be busy, as it may be.
          callChannel(rpc, CliChannels.inProgress, {}).pipe(
            Effect.map((work) => work.flatMap((report) => report.items)),
            Effect.orElseSucceed(() => ["work it cannot list (cli.registry is off)"]),
          ),
        ],
        { concurrency: "unbounded" },
      ),
    );
    if (answered._tag === "Success") {
      const [info, items] = answered.success;
      return { startedBy: info.startedBy, cwd: info.cwd, safe: info.safe === true, items } satisfies Running;
    }
    if (!force) {
      const why = (yield* otherProtocol(target)) ?? toCliError(answered.failure, target);
      return yield* new CliError({
        code: why.code,
        message: `${why.message}\nlemma ${verb} --force ${verb}s it all the same, not knowing what that cuts off.`,
        exit: why.exit,
        ...(why.subject === undefined ? {} : { subject: why.subject }),
      });
    }
    return { startedBy: entry.startedBy, cwd: entry.cwd, safe: entry.safe === true, items: [] } satisfies Running;
  });

/** Whether to go on stopping `running`: a host the desktop app started, or one with work in progress, only with `force` or a yes at the terminal. */
const agreed = (io: Io, force: boolean, doing: "Stopping" | "Restarting", running: Running) =>
  Effect.gen(function* () {
    const verb = doing === "Stopping" ? "stop" : "restart";
    if (!force && running.startedBy === "desktop")
      return yield* new CliError({
        code: "Owned",
        message: `The desktop app started this host and stops it when it quits: quit the app, or ${verb} it here with --force`,
        exit: ExitCode.failed,
      });
    if (!force && running.items.length > 0) {
      io.err(`${doing} the host cuts off:\n${running.items.map((item) => `  ${item}`).join("\n")}\n(running turns resume when a host starts again)`);
      if (!(yield* confirm(io, `${doing === "Stopping" ? "Stop" : "Restart"} it anyway?`)))
        return yield* new CliError({ code: "Busy", message: `The host has work in progress; --force ${verb}s it anyway`, exit: ExitCode.failed });
    }
  });

/** Waits for the host's process to exit, failing once it has taken longer than a host may. */
const exited = (pid: number) =>
  Effect.gen(function* () {
    const gone = yield* Effect.gen(function* () {
      while (isAlive(pid)) yield* Effect.sleep("100 millis");
      return true;
    }).pipe(Effect.timeoutOrElse({ duration: STOPPING, orElse: () => Effect.succeed(false) }));
    if (!gone)
      return yield* new CliError({
        code: "StillRunning",
        message: `The host (pid ${pid}) did not stop within ${Duration.toSeconds(STOPPING)}s; its log (lemma logs) says what it is waiting on`,
        exit: ExitCode.failed,
      });
  });

const stop = defineBuiltin({
  path: ["stop"],
  group: RUN,
  summary: "Stop this machine's host, saying first what it would cut off",
  description:
    "Turns running are cut off (they resume when a host starts again) and queued prompts wait. With work in progress it asks at a terminal, and otherwise refuses unless --force. A host the desktop app started is the app's to stop; one a service runs is stopped through it.",
  flags: { force: { type: "boolean", description: "Stop it whatever it is doing, and whoever started it" } },
  run: ({ io, globals, flags }) =>
    Effect.gen(function* () {
      const wrong = localOnly(globals, "stop");
      if (wrong !== undefined) return yield* wrong;
      const home = homeOf(io);
      const running = yield* readDiscovery(home);
      if (running === undefined) return { json: { stopped: false, home }, text: `No host runs for ${home}` };
      const host = yield* runningHost(io, running, flags.force, "stop");
      yield* agreed(io, flags.force, "Stopping", host);
      const service = host.startedBy === "service" ? serviceManager(profileOf(io.env)) : undefined;
      if (service !== undefined) service.stop();
      else process.kill(running.pid, "SIGTERM");
      yield* exited(running.pid);
      return {
        json: { stopped: true, pid: running.pid, startedBy: host.startedBy ?? null, cutOff: host.items },
        text: `Stopped the host for ${home} (pid ${running.pid}, started ${startedByText(host.startedBy)})${service === undefined ? "" : "; the service stays installed and starts it again at login (lemma service)"}`,
      };
    }),
});

const restart = defineBuiltin({
  path: ["restart"],
  group: RUN,
  summary: "Restart this machine's host on this lemma: after lemma update, to run the release it installed",
  description:
    "As lemma stop does, it says first what it would cut off; running turns resume once the host is back. A host a service runs restarts through the service, which runs the lemma command and so the release installed last. Any other starts again in the background as it ran: for the same project, on the same port and address, in safe mode if it was; --port, --host, and --safe change that for its new run. A host on another version of Lemma cannot say what it is doing: --force restarts it from what its transport.json says.",
  flags: {
    force: { type: "boolean", description: "Restart it whatever it is doing, and whoever started it" },
    port: { type: "number", description: "Listen on this port, rather than the one it listens on" },
    host: { type: "string", placeholder: "address", description: "Bind this address, this run only (default loopback)" },
    safe: { type: "boolean", description: "Run the bundled plugins as shipped, reading no config file or plugin file" },
  },
  examples: ["lemma restart", "lemma update && lemma restart"],
  run: ({ io, globals, flags }) =>
    Effect.gen(function* () {
      const wrong = localOnly(globals, "restart");
      if (wrong !== undefined) return yield* wrong;
      const home = homeOf(io);
      const running = yield* readDiscovery(home);
      if (running === undefined)
        return yield* new CliError({ code: "NoHost", message: `No host runs for ${home}: lemma serve starts one`, exit: ExitCode.unavailable });
      const host = yield* runningHost(io, running, flags.force, "restart");
      const service = host.startedBy === "service" ? serviceManager(profileOf(io.env)) : undefined;
      // Before asking whether to cut anything off: a restart these flags cannot change is refused whatever the answer.
      if (service !== undefined && (flags.port !== undefined || flags.host !== undefined || flags.safe))
        return yield* usage("A service runs this host as its definition says: --port, --host, and --safe are for one lemma serve started");
      yield* agreed(io, flags.force, "Restarting", host);
      if (service !== undefined) {
        const problems = service.restart();
        if (problems.length > 0) return yield* new CliError({ code: "ServiceFailed", message: problems.join("\n"), exit: ExitCode.failed });
        const within = Duration.sum(STOPPING, START);
        const back = yield* listening(home, (entry) => entry.pid !== running.pid, within);
        if (back === undefined) return yield* notStarted(home, true, within);
        return {
          json: { restarted: true, url: back.url, pid: back.pid, previous: running.pid, startedBy: "service", cutOff: host.items },
          text: `Restarted the host for ${home} through ${service.name}: ${back.url} (pid ${back.pid})`,
        };
      }
      process.kill(running.pid, "SIGTERM");
      yield* exited(running.pid);
      // As it ran: its port (a URL leaves out its scheme's default), the address it bound, and safe mode.
      const url = new URL(running.url);
      const port = flags.port ?? (url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port));
      const args = hostArgs({ port, host: flags.host ?? running.host, safe: flags.safe || host.safe });
      const started = yield* startInBackground(io, home, host.cwd ?? io.cwd, args);
      return {
        json: { restarted: true, url: started.url, pid: started.pid, previous: running.pid, startedBy: "cli", cutOff: host.items, log: started.log },
        text: `Restarted the host for ${home} in the background: ${started.url} (pid ${started.pid}). Its log is ${started.log}; \`lemma stop\` stops it.`,
      };
    }),
});

const logs = defineBuiltin({
  path: ["logs"],
  group: RUN,
  summary: "What this machine's host printed, however it was started; -f follows it",
  flags: {
    follow: { type: "boolean", short: "f", description: "Print what it prints next, until stopped" },
    lines: { type: "number", short: "n", description: "How many of the last lines (default 50)" },
    previous: { type: "boolean", description: "The run before's log, kept once a log grows past 5 MB" },
    desktop: { type: "boolean", description: "The desktop app's own log: a host it started that exited, a start that failed" },
  },
  run: ({ io, globals, flags }) =>
    Effect.gen(function* () {
      const wrong = localOnly(globals, "logs");
      if (wrong !== undefined) return yield* wrong;
      const count = flags.lines ?? 50;
      if (!Number.isInteger(count) || count < 0) return yield* usage("--lines must be a whole number, 0 or more");
      const files = hostFiles(homeOf(io));
      // The desktop app's own log is the root's, whatever profile its windows show.
      const path = flags.desktop ? join(hostFiles(rootOf(io)).logs, "desktop.log") : flags.previous ? files.previousLog : files.log;
      if (!existsSync(path))
        return yield* new CliError({
          code: "NotFound",
          message: `No log at ${path}: ${flags.desktop ? "the desktop app has said nothing yet" : "no host has run for this home yet"}`,
          exit: ExitCode.failed,
        });
      const lines = yield* tail(path, count);
      if (!flags.follow) return { json: { path, lines }, text: lines.join("\n") };
      for (const line of lines) io.out(globals.json ? JSON.stringify({ line }) : line);
      // Read on from the end as it grows; a new run's log (moved aside, so smaller) is read from its start.
      let offset = (yield* Effect.promise(() => stat(path))).size;
      let partial = "";
      for (;;) {
        yield* Effect.sleep("250 millis");
        const size = yield* Effect.promise(() =>
          stat(path).then(
            (info) => info.size,
            () => 0,
          ),
        );
        if (size < offset) offset = 0;
        if (size === offset) continue;
        const chunk = yield* Effect.promise(async () => {
          const handle = await open(path, "r");
          try {
            const buffer = Buffer.alloc(size - offset);
            await handle.read(buffer, 0, buffer.length, offset);
            return buffer.toString("utf8");
          } finally {
            await handle.close();
          }
        });
        offset = size;
        const parts = (partial + chunk).split("\n");
        partial = parts.pop() ?? "";
        for (const line of parts) io.out(globals.json ? JSON.stringify({ line }) : line);
      }
    }),
});

// ------------------------------------------------------------------ services

/** The OS's service manager for the user: systemd on Linux, launchd on macOS. */
interface ServiceManager {
  readonly name: string;
  /** Where its definition goes. */
  readonly file: string;
  readonly render: (command: readonly string[], env: Readonly<Record<string, string>>, log: string) => string;
  readonly install: (start: boolean) => readonly string[];
  readonly uninstall: () => void;
  readonly stop: () => void;
  /** Stops the host it runs and starts it again, from its definition; what went wrong, if anything. */
  readonly restart: () => readonly string[];
  readonly status: () => { readonly installed: boolean; readonly enabled: boolean; readonly active: boolean };
}

const LABEL = "dev.lemma.host";

/** The service's name: one per profile, the default's `lemma` (`dev.lemma.host`), another's `lemma-<profile>`. */
const unitOf = (profile: string | undefined) => (profile === undefined ? "lemma.service" : `lemma-${profile}.service`);
const labelOf = (profile: string | undefined) => (profile === undefined ? LABEL : `${LABEL}.${profile}`);

const run = (command: string, args: readonly string[]) => spawnSync(command, args, { encoding: "utf8" });

/** A word for systemd's command line: quoted when it has to be. */
const systemdWord = (word: string) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `"${word.replace(/(["\\])/g, "\\$1")}"`);

const xml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The service manager's view of the service for `profile` (the default's when undefined). */
const serviceManager = (profile?: string): ServiceManager | undefined => {
  if (process.platform === "linux") {
    const unit = unitOf(profile);
    const file = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd", "user", unit);
    const systemctl = (...args: string[]) => run("systemctl", ["--user", ...args]);
    return {
      name: "systemd",
      file,
      render: (command, env) =>
        [
          "[Unit]",
          profile === undefined ? "Description=Lemma host" : `Description=Lemma host (profile ${profile})`,
          "",
          "[Service]",
          "WorkingDirectory=%h",
          ...Object.entries(env).map(([key, value]) => `Environment=${systemdWord(`${key}=${value}`)}`),
          `ExecStart=${command.map(systemdWord).join(" ")}`,
          "Restart=on-failure",
          "RestartSec=2",
          "",
          "[Install]",
          "WantedBy=default.target",
          "",
        ].join("\n"),
      install: (start) => {
        const said: string[] = [];
        for (const args of [["daemon-reload"], start ? ["enable", "--now", unit] : ["enable", unit]]) {
          const result = systemctl(...args);
          if (result.status !== 0) said.push(`systemctl --user ${args.join(" ")}: ${(result.stderr || result.error?.message || "failed").trim()}`);
        }
        return said;
      },
      uninstall: () => {
        systemctl("disable", "--now", unit);
      },
      stop: () => {
        systemctl("stop", unit);
      },
      restart: () => {
        const result = systemctl("restart", unit);
        return result.status === 0 ? [] : [`systemctl --user restart ${unit}: ${(result.stderr || result.error?.message || "failed").trim()}`];
      },
      status: () => ({
        installed: existsSync(file),
        enabled: systemctl("is-enabled", unit).stdout.trim() === "enabled",
        active: systemctl("is-active", unit).stdout.trim() === "active",
      }),
    };
  }
  if (process.platform === "darwin") {
    const label = labelOf(profile);
    const file = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
    const domain = `gui/${userInfo().uid}`;
    return {
      name: "launchd",
      file,
      render: (command, env, log) =>
        [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
          '<plist version="1.0">',
          "<dict>",
          `  <key>Label</key><string>${label}</string>`,
          `  <key>WorkingDirectory</key><string>${xml(homedir())}</string>`,
          "  <key>ProgramArguments</key>",
          "  <array>",
          ...command.map((word) => `    <string>${xml(word)}</string>`),
          "  </array>",
          "  <key>EnvironmentVariables</key>",
          "  <dict>",
          ...Object.entries(env).map(([key, value]) => `    <key>${xml(key)}</key><string>${xml(value)}</string>`),
          "  </dict>",
          "  <key>RunAtLoad</key><true/>",
          "  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>",
          // What it prints before its own log is open, a failure to start among it.
          `  <key>StandardOutPath</key><string>${xml(log)}</string>`,
          `  <key>StandardErrorPath</key><string>${xml(log)}</string>`,
          "</dict>",
          "</plist>",
          "",
        ].join("\n"),
      install: (start) => {
        if (!start) return [];
        run("launchctl", ["bootout", `${domain}/${label}`]);
        const result = run("launchctl", ["bootstrap", domain, file]);
        return result.status === 0 ? [] : [`launchctl bootstrap ${domain} ${file}: ${(result.stderr || "failed").trim()}`];
      },
      uninstall: () => {
        run("launchctl", ["bootout", `${domain}/${label}`]);
      },
      stop: () => {
        // KeepAlive restarts only an unsuccessful exit: a host stopped by SIGTERM exits cleanly and stays down.
        run("launchctl", ["kill", "SIGTERM", `${domain}/${label}`]);
      },
      restart: () => {
        const result = run("launchctl", ["kickstart", "-k", `${domain}/${label}`]);
        return result.status === 0 ? [] : [`launchctl kickstart -k ${domain}/${label}: ${(result.stderr || "failed").trim()}`];
      },
      status: () => {
        const loaded = run("launchctl", ["print", `${domain}/${label}`]);
        return { installed: existsSync(file), enabled: loaded.status === 0, active: loaded.status === 0 && /state = running/.test(loaded.stdout) };
      },
    };
  }
  return undefined;
};

/**
 * What a service runs: `serve`, for the home and profile this command uses, of the `lemma` command the installer
 * links, so that once restarted it runs the release installed last (`lemma update`); else this lemma's own, as a
 * checkout runs it.
 */
const serviceCommand = (io: Io): readonly string[] | undefined => {
  const { link } = readBuild();
  if (link !== undefined) return [link, "serve", "--no-open"];
  return io.self === undefined ? undefined : [...io.self, "serve", "--no-open"];
};

const serviceDefinition = (command: readonly string[], io: Io, manager: ServiceManager) => {
  const profile = profileOf(io.env);
  const env: Record<string, string> = {
    LEMMA_STARTED_BY: "service",
    ...(io.env.LEMMA_HOME === undefined ? {} : { LEMMA_HOME: rootOf(io) }),
    ...(profile === undefined ? {} : { LEMMA_PROFILE: profile }),
  };
  return { command, text: manager.render(command, env, join(hostFiles(homeOf(io)).logs, "service.log")) };
};

const noManager = () =>
  new CliError({ code: "Unsupported", message: `lemma service knows systemd (Linux) and launchd (macOS), not ${process.platform}`, exit: ExitCode.failed });

const SERVICE = "Run a host";

const serviceInstall = defineBuiltin({
  path: ["service", "install"],
  group: SERVICE,
  summary: "Keep a host running as a user service (systemd or launchd): started at login, restarted after a crash",
  description:
    "It runs lemma serve, for the profile --profile names (one service each): an installed release's lemma command, so once restarted (lemma restart) it runs the release lemma update installed; a checkout's node and sources, which under Nix may be garbage-collected or moved: declare that service in your system configuration instead, from what --print shows (systemd.user.services, launchd.user.agents). On Linux, `loginctl enable-linger $USER` keeps it running without a login session.",
  flags: {
    print: { type: "boolean", description: "Print the definition and write nothing" },
    "no-start": { type: "boolean", description: "Install and enable it, but start it at the next login rather than now" },
  },
  run: ({ io, flags }) =>
    Effect.gen(function* () {
      const manager = serviceManager(profileOf(io.env));
      if (manager === undefined) return yield* noManager();
      const named = serviceCommand(io);
      if (named === undefined)
        return yield* new CliError({ code: "Unsupported", message: "This lemma cannot name itself for a service", exit: ExitCode.failed });
      const { command, text } = serviceDefinition(named, io, manager);
      if (flags.print) return { json: { manager: manager.name, file: manager.file, command, definition: text }, text };
      const home = homeOf(io);
      const running = yield* readDiscovery(home);
      const start = !flags["no-start"];
      if (start && running !== undefined)
        return yield* new CliError({
          code: "Running",
          message: `A host already runs for ${home} (pid ${running.pid}): stop it first (lemma stop), or install with --no-start`,
          exit: ExitCode.failed,
        });
      yield* Effect.promise(async () => {
        await mkdir(dirname(manager.file), { recursive: true });
        await writeFile(manager.file, text);
      });
      const problems = manager.install(start);
      if (problems.length > 0)
        return yield* new CliError({ code: "ServiceFailed", message: `Wrote ${manager.file}, but:\n${problems.join("\n")}`, exit: ExitCode.failed });
      const notes = [
        `Installed ${manager.file} (${manager.name})${start ? ", and started it" : "; it starts at the next login"}.`,
        ...(command.some((word) => word.startsWith("/nix/store/"))
          ? [
              "It names paths in the Nix store, which garbage collection may remove: prefer declaring it in your Nix configuration (lemma service install --print).",
            ]
          : []),
        ...(manager.name === "systemd" ? ["`loginctl enable-linger $USER` keeps it running without a login session."] : []),
      ];
      return { json: { manager: manager.name, file: manager.file, command, started: start }, text: notes.join("\n") };
    }),
});

const serviceUninstall = defineBuiltin({
  path: ["service", "uninstall"],
  group: SERVICE,
  summary: "Stop the user service and remove it",
  run: ({ io }) =>
    Effect.gen(function* () {
      const manager = serviceManager(profileOf(io.env));
      if (manager === undefined) return yield* noManager();
      if (!existsSync(manager.file)) return { json: { removed: false, file: manager.file }, text: `No service at ${manager.file}` };
      manager.uninstall();
      yield* Effect.promise(() => rm(manager.file, { force: true }));
      if (manager.name === "systemd") run("systemctl", ["--user", "daemon-reload"]);
      return { json: { removed: true, file: manager.file }, text: `Stopped and removed ${manager.file}` };
    }),
});

const serviceStatus = defineBuiltin({
  path: ["service"],
  group: SERVICE,
  summary: "Whether a user service keeps a host running here: installed, enabled, running",
  run: ({ io }) =>
    Effect.gen(function* () {
      const manager = serviceManager(profileOf(io.env));
      if (manager === undefined) return yield* noManager();
      const state = manager.status();
      return {
        json: { manager: manager.name, file: manager.file, ...state },
        text: state.installed
          ? `${manager.file} (${manager.name}): ${state.enabled ? "enabled" : "not enabled"}, ${state.active ? "running" : "not running"}`
          : `No service: lemma service install installs one (${manager.name})`,
      };
    }),
});

export const lifecycleCommands: readonly Builtin[] = [serve, stop, restart, logs, serviceStatus, serviceInstall, serviceUninstall];
