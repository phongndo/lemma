import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Duration, Effect } from "effect";
import { applyEdits, modify, parse as parseJsonc, printParseErrorCode } from "jsonc-parser";
import type { ParseError } from "jsonc-parser";
import { CliChannels, table } from "@lemma/cli";
import type { CheckResult } from "@lemma/cli";
import { makeHostRpcHttp } from "@lemma/client";
import { HOST_PROTOCOL } from "@lemma/contracts";
import { environmentNameProblem, environmentsPath, LOCAL, normalizeUrl, readDiscovery, readEnvironments, writeEnvironments } from "@lemma/contracts/discovery";
import { isInside, writeFileAtomic } from "@lemma/contracts/fs";
import { hostFiles, resolvePaths } from "@lemma/host/paths";
import { callOn } from "../channels.ts";
import { CliError, defineBuiltin, ExitCode, usage } from "../command.ts";
import type { Builtin, Io } from "../command.ts";
import { connectTo, findTarget, homeOf, noLocalHost, reasonOf, statusOf, toCliError } from "../connect.ts";

/*
 * Setting this client up: which hosts it reaches (`env`), the local host's
 * token, the config files and which projects they trust, and `doctor`. These
 * read and write files; they need no host, but use one when it runs.
 */

const SETUP = "Set up";
const HOSTS = "Hosts this client reaches (docs/remote.md)";
const VERIFY_TIMEOUT = Duration.seconds(10);

// ------------------------------------------------------------------ environments

/** Calls `Host.Info` at `url` with `token`: proof that the pair works, before it is saved. */
const verify = (url: string, token: string) =>
  Effect.flatMap(makeHostRpcHttp(url, token), (rpc) => rpc["Host.Info"]()).pipe(
    Effect.timeoutOrElse({
      duration: VERIFY_TIMEOUT,
      orElse: () =>
        Effect.fail(
          new CliError({
            code: "Unreachable",
            message: `${url} did not answer within ${Duration.toSeconds(VERIFY_TIMEOUT)}s; nothing was written`,
            exit: ExitCode.unavailable,
          }),
        ),
    }),
    Effect.catchTag("RpcClientError", (error) =>
      Effect.fail(
        statusOf(error) === 401
          ? new CliError({
              code: "Unauthorized",
              message: `The host at ${url} rejected the token; nothing was written. \`lemma token\` on that machine prints the right one.`,
              exit: ExitCode.unavailable,
            })
          : new CliError({
              code: "Unreachable",
              message: `Cannot reach a Lemma host at ${url}: ${reasonOf(error)}; nothing was written`,
              exit: ExitCode.unavailable,
            }),
      ),
    ),
  );

/** Whether a host answers at `url` with `token`, and on which protocol: for listing, so it never fails. */
const health = (url: string, token: string): Effect.Effect<string> =>
  Effect.promise(async () => {
    try {
      const response = await fetch(new URL("/api/health", url), { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2_000) });
      if (response.status === 401) return "rejects the token";
      if (!response.ok) return `answers ${response.status}`;
      const protocol = ((await response.json()) as { readonly protocol?: unknown }).protocol;
      return protocol === HOST_PROTOCOL ? "up" : "another version";
    } catch {
      return "down";
    }
  });

const failedWrite = (path: string, cause: unknown) =>
  new CliError({ code: "WriteFailed", message: `Cannot write ${path}: ${cause instanceof Error ? cause.message : String(cause)}`, exit: ExitCode.failed });

const environmentsOf = (io: Io) =>
  readEnvironments(homeOf(io)).pipe(Effect.mapError((error) => new CliError({ code: "NoHost", message: error.message, exit: ExitCode.failed })));

const envList = defineBuiltin({
  path: ["env"],
  group: HOSTS,
  summary: "The hosts this client knows: this machine's (local) and those saved, which commands go to by default, and whether each answers",
  run: ({ io }) =>
    Effect.gen(function* () {
      const home = homeOf(io);
      const file = yield* environmentsOf(io);
      const current = yield* Effect.result(findTarget(io));
      const local = yield* readDiscovery(home);
      const saved = Object.entries(file.environments);
      const states = yield* Effect.forEach(saved, ([, entry]) => health(entry.url, entry.token), { concurrency: "unbounded" });
      const rows = [
        { name: LOCAL, url: local?.url ?? null, state: local === undefined ? "not running" : "up", default: (file.default ?? LOCAL) === LOCAL },
        ...saved.map(([name, entry], i) => ({ name, url: entry.url, state: states[i]!, default: file.default === name })),
      ];
      const using = current._tag === "Success" ? current.success?.name : undefined;
      const overridden = io.env.LEMMA_URL?.trim() ? "LEMMA_URL" : io.env.LEMMA_ENV?.trim() ? `LEMMA_ENV=${io.env.LEMMA_ENV.trim()}` : undefined;
      return {
        json: { environments: rows, default: file.default ?? LOCAL, ...(overridden === undefined ? {} : { overriddenBy: overridden }) },
        text: [
          table([["", "name", "url", "state"], ...rows.map((row) => [row.default ? "*" : "", row.name, row.url ?? "", row.state])]),
          "",
          `* the default.${overridden === undefined ? "" : ` ${overridden} is set, so commands go to ${using ?? "it"}.`} --env <name> picks one for a command.`,
        ].join("\n"),
        ids: rows.map((row) => row.name),
      };
    }),
});

const envAdd = defineBuiltin({
  path: ["env", "add"],
  group: HOSTS,
  summary: "Save a host on another machine by name, after checking its token against it",
  description: "Without --token it takes LEMMA_TOKEN, or asks. A --token argument lands in shell history: leave it out to be asked.",
  args: [
    { name: "name", description: "What to call it: lowercase letters, digits, - and _", required: true },
    { name: "url", description: "Its base URL, such as https://box.tailnet.ts.net", required: true },
  ],
  flags: {
    token: { type: "string", description: "Its token (`lemma token` prints it there)" },
    use: { type: "boolean", description: "Make it the default too" },
  },
  examples: ["lemma env add box https://box.tailnet.ts.net --use"],
  run: ({ io, args, flags }) =>
    Effect.gen(function* () {
      const problem = environmentNameProblem(args.name);
      if (problem !== undefined) return yield* usage(problem);
      const url = normalizeUrl(args.url);
      if (url === undefined) return yield* usage(`"${args.url}" is not a host's base URL: use http(s)://<host>[:<port>], with no path or query`);
      const given = flags.token?.trim() || io.env.LEMMA_TOKEN?.trim();
      const ask = io.ask;
      const token = given || (ask === undefined ? "" : (yield* Effect.promise(() => ask(`Token for ${url} (\`lemma token\` there prints it): `, true))).trim());
      if (token === "") return yield* usage("env add needs the host's token: --token <token>, or LEMMA_TOKEN");
      const info = yield* verify(url, token);
      const home = homeOf(io);
      const file = yield* environmentsOf(io);
      const next = {
        ...(flags.use ? { default: args.name } : file.default === undefined ? {} : { default: file.default }),
        environments: { ...file.environments, [args.name]: { url, token } },
      };
      yield* Effect.tryPromise({ try: () => writeEnvironments(home, next), catch: (cause) => failedWrite(environmentsPath(home), cause) });
      return {
        json: { name: args.name, url, default: next.default ?? LOCAL, home: info.home },
        text: `Saved ${args.name}: ${url} (its home is ${info.home}).${flags.use ? " Commands go to it now." : ` --env ${args.name} uses it; \`lemma env use ${args.name}\` makes it the default.`}`,
      };
    }),
});

const envUse = defineBuiltin({
  path: ["env", "use"],
  group: HOSTS,
  summary: "Make one the default: commands go to it unless --env, LEMMA_ENV, or LEMMA_URL says otherwise; local is this machine's",
  args: [{ name: "name", description: "A saved one's name, or local", required: true }],
  run: ({ io, args }) =>
    Effect.gen(function* () {
      const home = homeOf(io);
      const file = yield* environmentsOf(io);
      if (args.name !== LOCAL && file.environments[args.name] === undefined)
        return yield* new CliError({ code: "UnknownEnvironment", message: `No environment "${args.name}"; \`lemma env\` lists them`, exit: ExitCode.failed });
      const { default: _, ...rest } = file;
      const next = args.name === LOCAL ? rest : { ...rest, default: args.name };
      yield* Effect.tryPromise({ try: () => writeEnvironments(home, next), catch: (cause) => failedWrite(environmentsPath(home), cause) });
      return { json: { default: args.name }, text: `Commands go to ${args.name} now` };
    }),
});

const envRemove = defineBuiltin({
  path: ["env", "remove"],
  group: HOSTS,
  summary: "Forget a saved host (and its token); the default goes back to local if it was the default",
  args: [{ name: "name", description: "A saved one's name", required: true }],
  run: ({ io, args }) =>
    Effect.gen(function* () {
      const home = homeOf(io);
      const file = yield* environmentsOf(io);
      if (file.environments[args.name] === undefined) return { json: { removed: false, name: args.name }, text: `No environment "${args.name}"` };
      const { [args.name]: _, ...environments } = file.environments;
      const next = { ...(file.default === undefined || file.default === args.name ? {} : { default: file.default }), environments };
      yield* Effect.tryPromise({ try: () => writeEnvironments(home, next), catch: (cause) => failedWrite(environmentsPath(home), cause) });
      return { json: { removed: true, name: args.name }, text: `Removed ${args.name}${file.default === args.name ? "; commands go to local now" : ""}` };
    }),
});

const token = defineBuiltin({
  path: ["token"],
  group: HOSTS,
  summary: "This machine's host's token, to give a client on another machine",
  run: ({ io }) =>
    Effect.gen(function* () {
      const home = homeOf(io);
      const local = yield* readDiscovery(home);
      if (local === undefined) return yield* noLocalHost(home);
      return { json: { url: local.url, token: local.token }, text: local.token };
    }),
});

// ------------------------------------------------------------------ config files

interface ConfigText {
  readonly path: string;
  readonly text: string | undefined;
  readonly value: Record<string, unknown> | undefined;
  readonly errors: readonly string[];
}

const readConfigFile = (path: string): Effect.Effect<ConfigText> =>
  Effect.promise(async () => {
    const text = await readFile(path, "utf8").catch(() => undefined);
    if (text === undefined) return { path, text, value: undefined, errors: [] };
    const errors: ParseError[] = [];
    const value = parseJsonc(text, errors, { allowTrailingComma: true }) as unknown;
    return {
      path,
      text,
      value: typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined,
      errors: errors.map((error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`),
    };
  });

/** The config files this directory's host would read: the user's, and the project's when the user's trusts it. */
const configFiles = (io: Io) =>
  Effect.gen(function* () {
    const paths = resolvePaths({ env: io.env, cwd: io.cwd });
    const user = yield* readConfigFile(paths.userConfig);
    const trustedProjects = trustedOf(user);
    const trusted = trustedProjects.some((entry) => isAbsolute(entry) && isInside(entry, paths.cwd));
    const project = yield* readConfigFile(paths.projectConfig);
    return { paths, user, project, trusted, trustedProjects };
  });

const trustedOf = (file: ConfigText): readonly string[] => {
  const value = file.value?.trustedProjects;
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
};

/** Each setting a file makes, as a dotted key and its value: `plugins.agent.loop.config.maxSteps = 100`. */
const settingsOf = (file: ConfigText): { readonly key: string; readonly value: unknown }[] => {
  const plugins = file.value?.plugins;
  const rows: { key: string; value: unknown }[] = [];
  if (typeof plugins === "object" && plugins !== null)
    for (const [id, row] of Object.entries(plugins as Record<string, Record<string, unknown>>)) {
      if (typeof row !== "object" || row === null) continue;
      for (const [field, value] of Object.entries(row)) {
        if (field === "config" && typeof value === "object" && value !== null && !Array.isArray(value))
          for (const [key, inner] of Object.entries(value)) rows.push({ key: `plugins.${id}.config.${key}`, value: inner });
        else rows.push({ key: `plugins.${id}.${field}`, value });
      }
    }
  for (const [key, value] of Object.entries(file.value ?? {})) if (key !== "plugins") rows.push({ key, value });
  return rows;
};

const config = defineBuiltin({
  path: ["config"],
  group: SETUP,
  summary: "What the config files set, for this directory's host: each setting and, with --show-origin, the file it comes from",
  description:
    "The project's file counts only in a trusted project (lemma trust). A project row's enabled and config override the user's for the same plugin; a project config object replaces the user's whole. lemma plugins config <id> shows a plugin's fields and their defaults, and sets one.",
  flags: { "show-origin": { type: "boolean", description: "Say which file each setting comes from" } },
  run: ({ io, flags }) =>
    Effect.gen(function* () {
      const { user, project, trusted } = yield* configFiles(io);
      const files = [{ scope: "user" as const, file: user }, ...(trusted ? [{ scope: "project" as const, file: project }] : [])];
      const rows = files.flatMap(({ scope, file }) => settingsOf(file).map((row) => ({ ...row, scope, file: file.path })));
      const problems = [user, project].filter((file) => file.errors.length > 0).map((file) => `${file.path}: ${file.errors.join("; ")}`);
      const notes = [
        ...problems,
        ...(project.text !== undefined && !trusted ? [`${project.path} is ignored: this project is not trusted (lemma trust add)`] : []),
        ...(user.text === undefined ? [`No ${user.path}: every bundled plugin runs as shipped`] : []),
      ];
      return {
        json: { files: { user: user.path, project: project.path }, trusted, settings: rows, problems },
        text: [
          rows.length === 0
            ? "No settings."
            : table(rows.map((row) => [row.key, JSON.stringify(row.value), ...(flags["show-origin"] ? [`${row.scope}: ${row.file}`] : [])])),
          ...notes,
        ].join("\n"),
      };
    }),
});

const configPath = defineBuiltin({
  path: ["config", "path"],
  group: SETUP,
  summary: "Where the config files are: the user's, and this directory's project's",
  run: ({ io }) =>
    Effect.gen(function* () {
      const { paths, trusted } = yield* configFiles(io);
      return {
        json: { user: paths.userConfig, project: paths.projectConfig, trusted, home: paths.home },
        text: table([
          ["user", paths.userConfig],
          ["project", `${paths.projectConfig}${trusted ? "" : " (ignored: not trusted)"}`],
          ["home", paths.home],
        ]),
      };
    }),
});

/** Writes `trustedProjects` in the user's file, keeping its comments; the host re-reads it. */
const writeTrusted = (path: string, text: string | undefined, entries: readonly string[]) =>
  Effect.tryPromise({
    try: () => {
      const base = text ?? "{}\n";
      const edits = modify(base, ["trustedProjects"], entries.length === 0 ? undefined : [...entries], {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      });
      return writeFileAtomic(path, applyEdits(base, edits), { mode: 0o600 });
    },
    catch: (cause) => failedWrite(path, cause),
  });

const trustList = defineBuiltin({
  path: ["trust"],
  group: SETUP,
  summary: "The projects whose config and plugins the host reads: each directory, and those inside it",
  run: ({ io }) =>
    Effect.gen(function* () {
      const { trustedProjects, trusted, paths } = yield* configFiles(io);
      return {
        json: { trustedProjects, here: { cwd: paths.cwd, trusted } },
        text: [...(trustedProjects.length === 0 ? ["No project is trusted."] : trustedProjects), "", `${paths.cwd} is ${trusted ? "" : "not "}trusted.`].join(
          "\n",
        ),
        ids: [...trustedProjects],
      };
    }),
});

const trustPath = [{ name: "path", description: "The project's directory (default: here)" }] as const;

const trustAdd = defineBuiltin({
  path: ["trust", "add"],
  group: SETUP,
  summary: "Trust a project: its .lemma/config.jsonc and .lemma/plugins load, and may run code and rebind the host",
  description: "Trust only what you would run: a project's plugins run as you, with the host's access.",
  args: trustPath,
  run: ({ io, args }) =>
    Effect.gen(function* () {
      const { user, trustedProjects } = yield* configFiles(io);
      const path = resolve(io.cwd, args.path ?? ".");
      if (trustedProjects.some((entry) => isAbsolute(entry) && isInside(entry, path)))
        return { json: { trusted: path, unchanged: true }, text: `${path} is trusted already` };
      yield* writeTrusted(user.path, user.text, [...trustedProjects, path]);
      return { json: { trusted: path }, text: `Trusted ${path}: a host started there reads its config and plugins` };
    }),
});

const trustRemove = defineBuiltin({
  path: ["trust", "remove"],
  group: SETUP,
  summary: "Stop trusting a project",
  args: trustPath,
  run: ({ io, args }) =>
    Effect.gen(function* () {
      const { user, trustedProjects } = yield* configFiles(io);
      const path = resolve(io.cwd, args.path ?? ".");
      if (!trustedProjects.includes(path)) return { json: { removed: false, path }, text: `${path} is not in trustedProjects` };
      yield* writeTrusted(
        user.path,
        user.text,
        trustedProjects.filter((entry) => entry !== path),
      );
      return { json: { removed: true, path }, text: `No longer trusting ${path}` };
    }),
});

// ------------------------------------------------------------------ doctor

/** The node this CLI runs on must be at least this. */
const NODE_MAJOR = 24;

const webIndex = fileURLToPath(new URL("../../../web/dist/index.html", import.meta.url));

const check = (id: string, title: string, status: CheckResult["status"], message: string, fix?: string): CheckResult => ({
  id,
  title,
  source: "lemma",
  status,
  message,
  ...(fix === undefined ? {} : { fix }),
});

const modeOf = (path: string): number | undefined => {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return undefined;
  }
};

const doctor = defineBuiltin({
  path: ["doctor"],
  group: SETUP,
  summary: "Check this machine's setup and the host commands go to: what is wrong, and what to do about it; fails on a problem",
  description: "Checks that need no host run first; with one running, so do its plugins' own (a provider to use, say).",
  run: ({ io, globals }) =>
    Effect.gen(function* () {
      const home = homeOf(io);
      const files = hostFiles(home);
      const results: CheckResult[] = [];
      const major = Number(process.versions.node.split(".")[0]);
      results.push(
        major >= NODE_MAJOR
          ? check("node", "Node", "ok", `node ${process.versions.node}`)
          : check(
              "node",
              "Node",
              "fail",
              `node ${process.versions.node} is older than ${NODE_MAJOR}`,
              "Run lemma from its dev shell (nix develop) or install Node 24",
            ),
      );
      const homeMode = modeOf(home);
      results.push(
        homeMode === undefined
          ? check("home", "Home", "warn", `${home} does not exist yet`, "The first `lemma serve` creates it")
          : homeMode & 0o077
            ? check("home", "Home", "warn", `${home} is readable by others (mode ${homeMode.toString(8)})`, `chmod 700 ${home}`)
            : check("home", "Home", "ok", home),
      );
      const tokenMode = modeOf(`${home}/token`);
      if (tokenMode !== undefined && tokenMode & 0o077)
        results.push(check("token", "Token", "fail", `${home}/token is readable by others (mode ${tokenMode.toString(8)})`, `chmod 600 ${home}/token`));
      const { user, project, trusted } = yield* configFiles(io);
      for (const [scope, file] of [
        ["user", user],
        ["project", project],
      ] as const) {
        if (file.text === undefined) continue;
        if (scope === "project" && !trusted) {
          results.push(check(`config.${scope}`, "Project config", "warn", `${file.path} is ignored: ${io.cwd} is not trusted`, `lemma trust add ${io.cwd}`));
          continue;
        }
        results.push(
          file.errors.length > 0 || file.value === undefined
            ? check(
                `config.${scope}`,
                `${scope === "user" ? "User" : "Project"} config`,
                "fail",
                `${file.path}: ${file.errors.join("; ") || "not an object"}`,
                "Fix it; lemma serve --safe starts without it meanwhile",
              )
            : check(`config.${scope}`, `${scope === "user" ? "User" : "Project"} config`, "ok", file.path),
        );
      }
      results.push(
        existsSync(webIndex)
          ? check("web", "Web app", "ok", "built")
          : check("web", "Web app", "warn", "not built: the host serves no page", "nix develop -c pnpm --filter @lemma/web-app build"),
      );
      const environments = yield* Effect.result(readEnvironments(home));
      if (environments._tag === "Failure") results.push(check("environments", "Environments", "fail", environments.failure.message));
      // The host commands go to: reachable, on this protocol, and its plugins well.
      const target = yield* Effect.result(findTarget(io, globals.env));
      if (target._tag === "Failure") results.push(check("host", "Host", "fail", target.failure.message));
      else if (target.success === undefined) {
        const lock = existsSync(files.lock);
        results.push(
          check(
            "host",
            "Host",
            "warn",
            `No host runs for ${home}${lock ? `, though ${files.lock} is there (left by one that stopped abruptly; the next start takes it over)` : ""}`,
            "lemma serve (or --detach), or the desktop app",
          ),
        );
      } else {
        const where = target.success;
        const reached = yield* Effect.result(
          Effect.scoped(
            Effect.gen(function* () {
              const connection = yield* connectTo(where);
              const plugins = yield* connection.rpc["Host.Plugins"]();
              const own = yield* Effect.scoped(Effect.flatMap(connection.host({ answers: false }), (host) => callOn(host, CliChannels.checks, {}))).pipe(
                Effect.orElseSucceed(() => [] as readonly CheckResult[]),
              );
              return { plugins, own };
            }),
          ),
        );
        if (reached._tag === "Failure")
          results.push(check("host", "Host", "fail", `${where.name} (${where.url}): ${toCliError(reached.failure, where).message}`));
        else {
          results.push(check("host", "Host", "ok", `${where.name} (${where.url})`));
          const broken = reached.success.plugins.filter((plugin) => plugin.state === "failed" || (plugin.enabled && plugin.problem !== undefined));
          results.push(
            broken.length === 0
              ? check("plugins", "Plugins", "ok", `${reached.success.plugins.filter((plugin) => plugin.state === "active").length} running`)
              : check(
                  "plugins",
                  "Plugins",
                  "fail",
                  broken.map((plugin) => `${plugin.id}: ${plugin.fault?.message ?? plugin.problem ?? plugin.state}`).join("; "),
                  "lemma plugins show <id> says why; lemma plugins restart <id> tries again",
                ),
          );
          results.push(...reached.success.own);
        }
      }
      const failed = results.some((result) => result.status === "fail");
      const mark = { ok: "ok  ", warn: "warn", fail: "FAIL" } as const;
      return {
        json: results,
        text: table(
          results.map((result) => [
            mark[result.status],
            result.title,
            `${result.message}${result.fix === undefined ? "" : `\n${" ".repeat(8)}→ ${result.fix}`}`,
          ]),
        ),
        ...(failed ? { exit: ExitCode.failed } : {}),
      };
    }),
});

export const setupCommands: readonly Builtin[] = [envList, envAdd, envUse, envRemove, token, config, configPath, trustList, trustAdd, trustRemove, doctor];
