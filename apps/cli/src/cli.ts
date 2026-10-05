import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { Effect } from "effect";
import type { Scope } from "effect";
import {
  appUrl,
  branchOf,
  FILE_SEARCH_LIMIT,
  HostError,
  kernelOf,
  NewThreadRoute,
  ThreadRoute,
  parseConfigValue,
  LEDGER_SORTS,
  ledger,
  parseLedgerFilter,
  promptDiff,
  rebuildRequest,
  recordStart,
  recordsBetween,
  recordSummary,
  sortRecords,
  trajectory,
} from "@lemma/contracts";
import type { ConfigScope, LedgerSort, PluginChange, TrajectoryStep, TrajectoryTurn } from "@lemma/contracts";
import { makeHostRpc, makeHostRpcHttp, rpcUrl } from "@lemma/client";
import { resolvePaths } from "@lemma/plugin-host";
import { CliError, ExitCode, usage } from "./command.ts";
import type { Command, Connection, Failure, Io, Options, Output, QuestionPolicy, Target, Unattached } from "./command.ts";
import {
  formatConfig,
  formatDiff,
  formatPlugin,
  formatPlugins,
  formatRecords,
  formatReload,
  formatSession,
  formatSessions,
  formatStatus,
  formatStep,
  formatSystem,
  formatTools,
  formatTrajectory,
  formatUi,
  formatHooks,
  formatRegistries,
  formatEvents,
  formatCapabilities,
  formatInspectors,
  formatSnapshot,
} from "./format.ts";
import {
  answerCommand,
  cancelCommand,
  dismissCommand,
  doCommand,
  eventsCommand,
  loginCommand,
  logoutCommand,
  modelsCommand,
  providersCommand,
  listCommandsCommand,
  queueCommand,
  questionsCommand,
  runCommand,
  withdrawCommand,
} from "./live.ts";
import { mcpCommand } from "./mcp.ts";
import { findTarget, noLocalHost, reasonOf, remoteCommand, statusOf, tokenCommand } from "./remote.ts";
import { workspaceCommand } from "./workspace.ts";

export { CliError, ExitCode } from "./command.ts";
export type { Connection, Io } from "./command.ts";

export const USAGE = `Usage: lemma <command> [options] [--json]

Everything the web app can do, from a shell. Every command except serve, remote,
and token talks to a running host: the one LEMMA_URL (with LEMMA_TOKEN) names,
else the one in $LEMMA_HOME/remote.json, else the local host found in
$LEMMA_HOME/transport.json ($LEMMA_HOME defaults to ~/.lemma).

Host
  serve                          Run the host in this terminal (always here, never remote)
  status                         Host, composition, plugin states, running turns
  plugins                        Every plugin: id, version, state (or "disabled"), source, and why
  plugins enable <id>            Turn a plugin on: removes its "enabled" row from the user config
  plugins disable <id>           Turn a plugin off: writes "enabled": false; plugins needing it stop too
    --project                    ...in the project's .lemma/config.jsonc instead (a trusted project)
  plugins show <id>              One plugin: state and why, what it provides and requires and who is on
                                 the other end, the hooks and events it takes part in, its recent faults
  plugins restart <id>           Restart a failed plugin and the plugins it halted
    --force                      ...also when it is running, unless the host depends on it
  plugins config <id>            Its settings: each field, its value or default, and what it does
  plugins config <id> <key> <value>
                                 Set one field in the config file that sets its config (user by default)
    --unset                      ...remove the field instead, back to its default
  reload                         Re-read config files and apply them

A host on another machine (docs/remote.md)
  remote                         Which host commands go to (LEMMA_URL, remote.json, or local) and its URL
  remote set <url> [--token <t>] Use the host at <url> from now on: checks the token against it, then
                                 writes $LEMMA_HOME/remote.json (the token: --token, LEMMA_TOKEN, or asked)
  remote clear                   Remove remote.json: back to the local host
  token                          The local host's token, to give a client on another machine

Web app (plugins the web app loads: bundled, and files in ~/.lemma/ui)
  ui                             The "ui" rows of the config files and the UI files found
  ui enable <id>                 Turn a web app plugin on (--project: in the project's config)
  ui disable <id>                Turn one off; open web apps apply it at once
  ui config <id> <key> <value>   Set one field of its config (JSON or text; --unset removes it)
  events [--session <id>]        Follow everything the host publishes (NDJSON with --json)

Sessions and turns
  session list [--cwd <dir>]     Sessions for a directory (default: the current one); --all for every one
  session show <id>              Session info and its current branch as a transcript
  session new [--cwd <dir>]      Create a session (default: the current directory)
  session title <id> <title>     Rename a session
  session pin|unpin <id>         Keep a session at the top of the web app's sidebar, or stop
  session archive|unarchive <id> Hide a session from the sidebar (it stays on disk), or bring it back
  session delete <id>            Delete a session's log for good (refused while a turn runs in it)
  session checkout <id> <event>  Move the session's leaf: the next prompt branches from that event
  run <id|new> <prompt…>         Send a prompt and wait for the turn to end
    --model <provider/model>     Model for this turn (see lemma models)
    --thinking <level>           off, minimal, low, medium, high, xhigh, max
    --image <file>               Attach an image (repeatable)
    --follow                     Stream the turn: text, tool calls, results (NDJSON with --json)
    --cwd <dir>                  Directory for a new session
    --when-busy <mode>           While a turn runs: follow-up (default: the next turn), steer (join it
                                 after its current step), or reject (fail Busy). --steer: --when-busy steer
    --request-id <id>            Send it exactly once: the same id again waits for (or reports) the turn
                                 that placed it rather than placing it twice
  cancel <id>                    Cancel the session's running turn
  queue <id>                     Prompts waiting for a turn: mode, request id, and text
  withdraw <id> <request>        Take a prompt out of the queue
  open [<id> [<view>]]           Open the web app at a session (a new thread without one) in the browser,
                                 in a view such as trajectory; prints the address. --json: print it only

Commands (what the web app's command palette runs; plugins add them)
  do                             List commands: id, title, category, and the plugin that added it
  do <command>                   Run one in the current directory (or --cwd); --session <id> for its session
                                 Its questions are answered like a login's (see --questions, --answer)

Questions the host asks (logins, tools that confirm)
  questions                      Open questions, with their ids
  answer <question> <value>      Answer one: yes/no, text, or an option (value, label, or number)
  dismiss <question>             Dismiss one
    While run, login, mcp login, do, or events --questions … is attached:
    --questions ask|ignore|dismiss   ask at the terminal (default when there is one), leave them
                                     to another client such as the web app (default otherwise), or dismiss
    --answer <value>               Answer the next question with this (repeatable, in order)

Providers and models
  providers                      Providers, whether they are configured, and how to log in
  login <provider> [--method api_key|oauth]
  logout <provider>
  models [--all]                 Models you can use now (--all: every known model)

MCP servers (tools from Model Context Protocol servers, through the mcp plugin)
  mcp [list]                     Each server: status, tools on/total, transport and target
  mcp show <id>                  One server: status, config (hidden values as such), secrets, unset
                                 variables, what the server reported, its instructions and tools
  mcp add <url>                  Add the server at a URL
  mcp add -- <command> [args…]   Add a server the host runs as a command; leading K=V words set its env
  mcp add -                      Add the servers in a config read from standard input (from a README,
                                 Claude, Cursor, VS Code, OpenCode…), or given as one argument.
                                 add keeps credential-looking values out of the config, as secrets,
                                 and never replaces a server: a taken id gets a suffix (-2)
    --name <id>                  Its id, in place of the one the URL or command suggests
    --project                    Save in the project's config
  mcp remove|restart <id>
  mcp login <id>                 Sign in to a URL server: prints the page to open (questions as for login)
  mcp logout <id>                Forget its sign-in
  mcp logs <id>                  What it printed and logged recently

Workspace (the project directory; --path defaults to the current one)
  workspace status [path]        Whether it exists, git branch, head, changes, upstream
  workspace branches [path]      Local branches by recency, then remote-only ones
  workspace checkout <branch> [--create] [--path <dir>]
  workspace worktree <branch> [--base <ref>] [--path <dir>]
                                 A linked worktree on a new branch, as the web app's "new worktree"
  workspace mkdir <path>         Create a directory
  workspace browse [partial]     Complete a directory path, as the add-project dialog does
  workspace files [query…] [--limit <n>] [--path <dir>]
                                 Its files and directories matching the query, best first, as the composer's @ finds them

Inspect (the web app's Trajectory view)
  kernel [capabilities]          Each capability: who provides it, in what state, and who requires it
  kernel hooks                   Each hook's chain, in the order its handlers run
  kernel registries              Each registry and what each plugin contributes to it
  kernel events                  Each event and who observes it
  inspectors                     What host plugins let you look into (tools, running turns, commands…)
  inspectors <id>                One inspector's snapshot, as tables
  inspect <id>                   Turns and steps: model, history, usage, timing, tools
  inspect <id> --records         Every record (prompt, system change, model call, tool run) as a table
    --filter <query>             is:error, is:running, kind:model, tool:bash, turn:2, req:5, text,
                                 and -term to exclude (implies --records)
    --sort <column> [--desc]     time, name, status, type, tokens, or duration
    --range <from>..<to>         Only records active in that span, as offsets from the first
                                 record (90s, 1m30s, 500ms; either side may be empty)
  inspect <id> --request <r>     One request: each system section and tool with the plugin that
                                 contributed it, then the response and tool runs. <r> is a request
                                 number (5), <turn>.<step> (2.1), a step id, or "last"
    --system                     ...only the system prompt, section by section
    --tools                      ...only the tool definitions
    --diff                       ...how its system prompt differs from the request before
    --rebuilt                    ...the exact request sent to the model, as JSON
  inspect <id> --step <step>     Same as --request

Options
  --json      Print results as JSON (errors as {"error": {...}} on stderr)
  -h, --help  Show this help

Exit codes: 0 ok, 1 the host refused or failed the request (or the turn failed),
2 usage error, 3 no running host or it could not be reached.`;

const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** `90s`, `1m30s`, `500ms`, `2m`, or bare seconds, in milliseconds. */
export const parseOffset = (text: string): number | undefined => {
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text) * 1000;
  const units: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
  let total = 0;
  const rest = text.replace(/(\d+(?:\.\d+)?)(ms|s|m|h)/g, (_, value: string, unit: string) => {
    total += Number(value) * units[unit]!;
    return "";
  });
  return rest === "" && text !== "" ? total : undefined;
};

/** Opens `url` with the system's handler, without waiting for it. */
const openBrowser = (url: string) =>
  Effect.sync(() => {
    const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
    spawn(command, [url], { detached: true, stdio: "ignore" })
      .on("error", () => {})
      .unref();
  });

/** The web app's address for a session (checked to exist) or a new thread, with the token; opened unless `--json`. */
const openCommand =
  (sessionId: string | undefined, view: string | undefined, options: Options): Command =>
  ({ target, rpc }) =>
    Effect.gen(function* () {
      if (sessionId !== undefined) yield* rpc.Session.Get({ sessionId });
      const path = sessionId === undefined ? NewThreadRoute.href({}) : ThreadRoute.href({ id: sessionId, ...(view === undefined ? {} : { view }) });
      const url = appUrl(target.url, path, target.token);
      if (!options.json) yield* openBrowser(url);
      return { json: { url }, text: url };
    });

const route = (positionals: readonly string[], options: Options, io: Io): Command | Unattached | CliError => {
  const [command, sub, arg, ...rest] = positionals;
  const extra = (count: number) => (positionals.length > count ? usage(`Unexpected argument "${positionals[count]}"`) : undefined);
  switch (command) {
    case "status":
      return (
        extra(1) ??
        (({ target, rpc }) =>
          Effect.all([rpc.Host.Info(), rpc.Host.Plugins(), rpc.Agent.Running()], { concurrency: "unbounded" }).pipe(
            Effect.map(([info, plugins, running]) => ({
              json: { url: target.url, source: target.source, pid: target.pid, startedAt: target.startedAt, info, plugins, running },
              text: formatStatus(target, info, plugins, running),
            })),
          ))
      );
    case "remote":
      return remoteCommand(sub, arg, rest, io, options);
    case "token":
      return extra(1) ?? tokenCommand(io);
    case "plugins":
      if (sub === undefined || sub === "list") {
        return (
          extra(sub === undefined ? 1 : 2) ?? (({ rpc }) => Effect.map(rpc.Host.Plugins(), (plugins) => ({ json: plugins, text: formatPlugins(plugins) })))
        );
      }
      if (sub === "restart") {
        if (arg === undefined) return usage("plugins restart needs a plugin id");
        return (
          extra(3) ??
          (({ rpc }) =>
            Effect.as(rpc.Host.RestartPlugin(options.force ? { pluginId: arg, force: true } : { pluginId: arg }), {
              json: { restarted: arg },
              text: `restarted ${arg}`,
            }))
        );
      }
      if (sub === "enable" || sub === "disable") {
        if (arg === undefined) return usage(`plugins ${sub} needs a plugin id`);
        const enabled = sub === "enable";
        return (
          extra(3) ??
          (({ rpc }) =>
            Effect.map(rpc.Host.Configure({ plugins: { [arg]: { enabled } }, ...(options.project ? { scope: "project" as const } : {}) }), (report) => ({
              json: { [enabled ? "enabled" : "disabled"]: arg, ...report },
              text: `${enabled ? "enabled" : "disabled"} ${arg}: ${formatReload(report)}`,
            })))
        );
      }
      if (sub === "show") {
        if (arg === undefined) return usage("plugins show needs a plugin id");
        return (
          extra(3) ??
          (({ rpc }) =>
            Effect.flatMap(rpc.Host.Plugins(), (plugins) => {
              const plugin = plugins.find((candidate) => candidate.id === arg);
              return plugin === undefined
                ? Effect.fail(new HostError({ code: "NotFound", message: `No plugin "${arg}"`, subject: arg }))
                : Effect.succeed({ json: plugin, text: formatPlugin(plugins, plugin) });
            }))
        );
      }
      if (sub === "config") {
        if (arg === undefined) return usage("plugins config needs a plugin id");
        const [key, value, ...more] = rest;
        if (more.length) return usage(`Unexpected argument "${more[0]}"`);
        if (key === undefined) {
          return ({ rpc }) =>
            Effect.flatMap(rpc.Host.Plugins(), (plugins) => {
              const plugin = plugins.find((candidate) => candidate.id === arg);
              return plugin === undefined
                ? Effect.fail(new HostError({ code: "NotFound", message: `No plugin "${arg}"`, subject: arg }))
                : Effect.succeed({ json: { id: plugin.id, fields: plugin.configFields ?? [], ...plugin.config }, text: formatConfig(plugin) });
            });
        }
        if ((value === undefined) === !options.unset) return usage("plugins config <id> <key> needs a value, or --unset");
        return ({ rpc }) =>
          Effect.gen(function* () {
            const plugin = (yield* rpc.Host.Plugins()).find((candidate) => candidate.id === arg);
            if (plugin === undefined) return yield* new HostError({ code: "NotFound", message: `No plugin "${arg}"`, subject: arg });
            const field = plugin.configFields?.find((candidate) => candidate.key === key);
            if (field === undefined) {
              const keys = (plugin.configFields ?? []).map((candidate) => candidate.key);
              return yield* new HostError({
                code: "Usage",
                message: keys.length ? `${arg} has no "${key}"; its fields are ${keys.join(", ")}` : `${arg} takes no config`,
                subject: arg,
              });
            }
            const parsed = options.unset ? { value: null } : parseConfigValue(field, value!);
            if ("error" in parsed) return yield* new HostError({ code: "Usage", message: parsed.error, subject: arg });
            const scope: ConfigScope = options.project ? "project" : (plugin.configScope ?? "user");
            const change: PluginChange = { values: { [key]: parsed.value } };
            const report = yield* rpc.Host.Configure({ plugins: { [arg]: change }, ...(scope === "project" ? { scope } : {}) });
            return {
              json: { id: arg, key, ...(options.unset ? { unset: true } : { value: parsed.value }), scope, ...report },
              text: `${options.unset ? `unset ${arg}.${key}` : `set ${arg}.${key} = ${JSON.stringify(parsed.value)}`} in the ${scope} config: ${formatReload(report)}`,
            };
          });
      }
      return usage(`Unknown plugins command "${sub}"`);
    case "ui":
      return uiCommand(sub, arg, rest, options);
    case "reload":
      return extra(1) ?? (({ rpc }) => Effect.map(rpc.Host.Reload(), (report) => ({ json: report, text: formatReload(report) })));
    case "events":
      return extra(1) ?? eventsCommand;
    case "session":
      return sessionCommand(sub, arg, rest, options, io);
    case "run": {
      if (sub === undefined || (positionals.length < 3 && options.images.length === 0)) return usage("run needs a session id (or new) and a prompt");
      if (options.thinking !== undefined && !THINKING.has(options.thinking)) return usage(`--thinking must be one of ${[...THINKING].join(", ")}`);
      return runCommand(sub, positionals.slice(2));
    }
    case "open":
      return extra(3) ?? openCommand(sub, arg, options);
    case "cancel":
      if (sub === undefined) return usage("cancel needs a session id");
      return extra(2) ?? cancelCommand(sub);
    case "queue":
      if (sub === undefined) return usage("queue needs a session id");
      return extra(2) ?? queueCommand(sub);
    case "withdraw":
      if (sub === undefined || arg === undefined) return usage("withdraw needs a session id and a request id (see lemma queue)");
      return extra(3) ?? withdrawCommand(sub, arg);
    case "do":
      if (sub === undefined) return listCommandsCommand;
      return extra(2) ?? doCommand(sub);
    case "questions":
      return extra(1) ?? questionsCommand;
    case "answer":
      if (sub === undefined || arg === undefined) return usage("answer needs a question id and a value");
      return answerCommand(sub, positionals.slice(2));
    case "dismiss":
      if (sub === undefined) return usage("dismiss needs a question id");
      return extra(2) ?? dismissCommand(sub);
    case "providers":
      return extra(1) ?? providersCommand;
    case "models":
      return extra(1) ?? modelsCommand;
    case "login":
      if (sub === undefined) return usage("login needs a provider id (see lemma providers)");
      return extra(2) ?? loginCommand(sub);
    case "logout":
      if (sub === undefined) return usage("logout needs a provider id");
      return extra(2) ?? logoutCommand(sub);
    case "workspace":
      return workspaceCommand(sub, positionals.slice(2), io, options);
    case "mcp":
      return mcpCommand(positionals.slice(1), options, io);
    case "kernel": {
      const views = { hooks: formatHooks, registries: formatRegistries, events: formatEvents, capabilities: formatCapabilities } as const;
      const view = sub ?? "capabilities";
      if (!Object.hasOwn(views, view)) return usage(`kernel shows hooks, registries, events, or capabilities, not "${view}"`);
      return (
        extra(2) ??
        (({ rpc }) =>
          Effect.map(rpc.Host.Plugins(), (plugins) => {
            const kernel = kernelOf(plugins);
            const key = view as keyof typeof views;
            return { json: kernel[key], text: views[key](kernel) };
          }))
      );
    }
    case "inspectors":
      if (sub === undefined)
        return extra(1) ?? (({ rpc }) => Effect.map(rpc.Host.Inspectors(), (inspectors) => ({ json: inspectors, text: formatInspectors(inspectors) })));
      return extra(2) ?? (({ rpc }) => Effect.map(rpc.Host.Inspect({ id: sub }), (snapshot) => ({ json: snapshot, text: formatSnapshot(snapshot) })));
    case "inspect":
      if (sub === undefined) return usage("inspect needs a session id");
      return extra(2) ?? inspectCommand(sub, options);
    case undefined:
      return usage("No command given");
    default:
      return usage(`Unknown command "${command}"`);
  }
};

/** The web app plans its own composition from these rows; the host only stores them and tells open web apps. */
const uiCommand = (sub: string | undefined, arg: string | undefined, rest: readonly string[], options: Options): Command | CliError => {
  const scope = options.project ? { scope: "project" as const } : {};
  switch (sub) {
    case undefined:
    case "list":
      if (arg !== undefined) return usage(`Unexpected argument "${arg}"`);
      return ({ rpc }) => Effect.map(rpc.Ui.Composition(), (ui) => ({ json: ui, text: formatUi(ui) }));
    case "enable":
    case "disable": {
      if (arg === undefined) return usage(`ui ${sub} needs a plugin id`);
      if (rest.length) return usage(`Unexpected argument "${rest[0]}"`);
      const enabled = sub === "enable";
      return ({ rpc }) =>
        Effect.map(rpc.Ui.Configure({ plugins: { [arg]: { enabled } }, ...scope }), (ui) => ({
          json: ui,
          text: `${enabled ? "enabled" : "disabled"} ${arg} in the ${options.project ? "project" : "user"} config; open web apps apply it`,
        }));
    }
    case "config": {
      const [key, value, ...more] = rest;
      if (arg === undefined || key === undefined) return usage("ui config needs a plugin id and a key");
      if (more.length) return usage(`Unexpected argument "${more[0]}"`);
      if ((value === undefined) === !options.unset) return usage("ui config <id> <key> needs a value, or --unset");
      // Only the web app knows the plugin's fields, so the value is JSON when it parses and text otherwise.
      const parsed = options.unset ? { value: null } : parseConfigValue(undefined, value!);
      if ("error" in parsed) return usage(parsed.error);
      return ({ rpc }) =>
        Effect.map(rpc.Ui.Configure({ plugins: { [arg]: { values: { [key]: parsed.value } } }, ...scope }), (ui) => ({
          json: ui,
          text: `${options.unset ? `unset ${arg}.${key}` : `set ${arg}.${key} = ${JSON.stringify(parsed.value)}`}; open web apps apply it`,
        }));
    }
    default:
      return usage(`Unknown ui command "${sub}"`);
  }
};

const sessionCommand = (sub: string | undefined, arg: string | undefined, rest: readonly string[], options: Options, io: Io): Command | CliError => {
  switch (sub) {
    case "list": {
      if (arg !== undefined) return usage(`Unexpected argument "${arg}"`);
      if (options.all && options.cwd !== undefined) return usage("Use either --all or --cwd");
      const cwd = options.all ? undefined : resolve(io.cwd, options.cwd ?? ".");
      return ({ rpc }) =>
        Effect.map(rpc.Session.List(cwd === undefined ? {} : { cwd }), (sessions) => ({
          json: sessions,
          text: sessions.length ? formatSessions(sessions, cwd === undefined) : `No sessions${cwd === undefined ? "" : ` in ${cwd}`}.`,
        }));
    }
    case "show":
      if (arg === undefined) return usage("session show needs a session id");
      if (rest.length) return usage(`Unexpected argument "${rest[0]}"`);
      return ({ rpc }) =>
        Effect.gen(function* () {
          const [info, events] = yield* Effect.all([rpc.Session.Get({ sessionId: arg }), rpc.Session.Events({ sessionId: arg })], { concurrency: "unbounded" });
          const branch = branchOf(events, info.leaf);
          return { json: { info, branch }, text: formatSession(info, branch) };
        });
    case "new":
      if (arg !== undefined) return usage(`Unexpected argument "${arg}"`);
      return ({ rpc }) => Effect.map(rpc.Session.Create({ cwd: resolve(io.cwd, options.cwd ?? ".") }), (info) => ({ json: info, text: info.id }));
    case "title": {
      const title = rest.join(" ").trim();
      if (arg === undefined || title === "") return usage("session title needs a session id and a title");
      return ({ rpc }) => Effect.map(rpc.Session.SetTitle({ sessionId: arg, title }), (info) => ({ json: info, text: `${info.id}  ${info.title ?? ""}` }));
    }
    case "pin":
    case "unpin":
    case "archive":
    case "unarchive": {
      if (arg === undefined) return usage(`session ${sub} needs a session id`);
      if (rest.length) return usage(`Unexpected argument "${rest[0]}"`);
      const marks = sub === "pin" || sub === "unpin" ? { pinned: sub === "pin" } : { archived: sub === "archive" };
      const done = { pin: "pinned", unpin: "unpinned", archive: "archived", unarchive: "unarchived" }[sub];
      return ({ rpc }) => Effect.map(rpc.Session.Mark({ sessionId: arg, ...marks }), (info) => ({ json: info, text: `${info.id}  ${done}` }));
    }
    case "delete":
      if (arg === undefined) return usage("session delete needs a session id");
      if (rest.length) return usage(`Unexpected argument "${rest[0]}"`);
      return ({ rpc }) => Effect.map(rpc.Session.Delete({ sessionId: arg }), () => ({ json: { id: arg, deleted: true }, text: `${arg}  deleted` }));
    case "checkout": {
      const eventId = rest[0];
      if (arg === undefined || eventId === undefined) return usage("session checkout needs a session id and an event id");
      if (rest.length > 1) return usage(`Unexpected argument "${rest[1]}"`);
      return ({ rpc }) =>
        Effect.map(rpc.Session.Checkout({ sessionId: arg, eventId }), (info) => ({
          json: info,
          text: `${info.id} now continues from ${eventId}; the next prompt starts a new branch there`,
        }));
    }
    default:
      return usage(
        sub === undefined
          ? "session needs a command: list, show, new, title, pin, unpin, archive, unarchive, delete, or checkout"
          : `Unknown session command "${sub}"`,
      );
  }
};

const inspectCommand = (sessionId: string, options: Options): Command | CliError => {
  const selector = options.step;
  const listing = options.records || options.filter !== undefined || options.sort !== undefined || options.range !== undefined;
  if (options.view !== undefined && selector === undefined) return usage(`--${options.view} needs --request`);
  if (selector !== undefined && listing) return usage("Use either --request or --records/--filter/--sort/--range");
  if (options.sort !== undefined && !(LEDGER_SORTS as readonly string[]).includes(options.sort))
    return usage(`--sort must be one of ${LEDGER_SORTS.join(", ")}`);
  let range: { from: number | undefined; to: number | undefined } | undefined;
  if (options.range !== undefined) {
    const [from, to, ...more] = options.range.split("..");
    const start = from === undefined || from === "" ? undefined : parseOffset(from);
    const end = to === undefined || to === "" ? undefined : parseOffset(to);
    if (to === undefined || more.length > 0 || (from !== "" && start === undefined) || (to !== "" && end === undefined)) {
      return usage("--range looks like 30s..1m30s (either side may be empty)");
    }
    range = { from: start, to: end };
  }
  return ({ rpc }) =>
    Effect.gen(function* () {
      const [info, events] = yield* Effect.all([rpc.Session.Get({ sessionId }), rpc.Session.Events({ sessionId })], { concurrency: "unbounded" });
      const branch = branchOf(events, info.leaf);
      const turns = trajectory(branch);
      if (listing) {
        const running = turns.at(-1)?.end === undefined;
        let records = ledger(turns).filter(parseLedgerFilter(options.filter ?? ""));
        if (range !== undefined && records.length > 0) {
          const origin = Math.min(...ledger(turns).map(recordStart));
          records = recordsBetween(records, origin + (range.from ?? 0), range.to === undefined ? Infinity : origin + range.to);
        }
        records = sortRecords(records, (options.sort ?? "time") as LedgerSort, options.desc, running);
        return { json: records.map((record) => recordSummary(record, running)), text: formatRecords(records, running) };
      }
      if (selector === undefined) return { json: { info, turns }, text: formatTrajectory(turns) };
      const found = findStep(turns, selector);
      if (found === undefined) {
        return yield* new CliError({
          code: "NotFound",
          message: `No request "${selector}" on the current branch of ${sessionId}`,
          subject: selector,
          exit: ExitCode.failed,
        });
      }
      const request = found.step.request;
      if (options.view !== undefined && request === undefined) {
        return yield* new CliError({
          code: "NotFound",
          message: `Step ${found.turn.index}.${found.step.index} logged no request`,
          subject: selector,
          exit: ExitCode.failed,
        });
      }
      switch (options.view) {
        case "system":
          return { json: request!.sections, text: formatSystem(request!) };
        case "tools":
          return { json: request!.tools, text: formatTools(request!) };
        case "diff": {
          const requests = turns.flatMap((turn) => turn.steps.flatMap((step) => (step.request === undefined ? [] : [step.request])));
          const previous = requests[requests.indexOf(request!) - 1];
          const diff = promptDiff(previous, request!);
          return { json: { previous: previous?.eventId, sections: diff }, text: formatDiff(diff, previous === undefined) };
        }
        case "rebuilt": {
          const rebuilt = rebuildRequest(branch, request!.eventId, sessionId);
          return { json: rebuilt, text: JSON.stringify(rebuilt, null, 2) };
        }
        case undefined:
          return { json: { info, turn: found.turn.index, step: found.step }, text: formatStep(found.turn, found.step) };
      }
    });
};

/** A step by request number, by `<turn>.<step>` (1-based), by step id, or the last step that sent a request. */
const findStep = (turns: readonly TrajectoryTurn[], selector: string): { turn: TrajectoryTurn; step: TrajectoryStep } | undefined => {
  const all = turns.flatMap((turn) => turn.steps.map((step) => ({ turn, step })));
  const requests = all.filter(({ step }) => step.request !== undefined);
  if (selector === "last") return requests.at(-1);
  if (/^\d+$/.test(selector)) return requests[Number(selector) - 1];
  const position = /^(\d+)\.(\d+)$/.exec(selector);
  if (position !== null) {
    const turn = turns[Number(position[1]) - 1];
    const step = turn?.steps[Number(position[2]) - 1];
    return turn === undefined || step === undefined ? undefined : { turn, step };
  }
  return all.find(({ step }) => step.stepId === selector);
};

/**
 * The host commands go to (see `findTarget`): one-shot HTTP calls for most
 * commands, and a WebSocket (opened only when a command follows events) for
 * streaming and questions, as the web app uses.
 */
const connect = (io: Io): Effect.Effect<Connection, Failure, Scope.Scope> =>
  Effect.gen(function* () {
    const target = yield* findTarget(io);
    if (target === undefined) return yield* noLocalHost(resolvePaths({ env: io.env, cwd: io.cwd }).home);
    const rpc = yield* makeHostRpcHttp(target.url, target.token);
    const live = yield* Effect.cached(makeHostRpc(rpcUrl(target.url, target.token)));
    return { target, rpc, live };
  });

/** A remote target that cannot be reached is the remote's "no host"; a local one that was found but did not answer is unreachable. */
const toCliError = (error: Failure, target?: Target): CliError => {
  if (error instanceof CliError) return error;
  if (error instanceof HostError) {
    return new CliError({
      code: error.code,
      message: error.message,
      ...(error.subject === undefined ? {} : { subject: error.subject }),
      exit: ExitCode.failed,
    });
  }
  const remote = target !== undefined && target.source !== "local" ? target : undefined;
  // `filterStatusOk` turns a rejected token into a failed send; the response status says which it was.
  if (statusOf(error) === 401) {
    const message =
      remote === undefined
        ? "The host rejected the token in transport.json"
        : `The host at ${remote.url} rejected the token from ${remote.from}. \`lemma token\` there prints the current one; ${remote.source === "env" ? "set LEMMA_TOKEN to it" : `save it with \`lemma remote set ${remote.url} --token <token>\``}.`;
    return new CliError({ code: "Unauthorized", message, exit: ExitCode.unavailable });
  }
  if (remote !== undefined) {
    return new CliError({
      code: "NoHost",
      message: `No Lemma host answers at ${remote.url} (from ${remote.from}): ${reasonOf(error)}. Check that the host runs on that machine and that this one can reach it, or ${remote.source === "env" ? "unset LEMMA_URL" : "run `lemma remote clear`"} to use the local host.`,
      exit: ExitCode.unavailable,
    });
  }
  return new CliError({ code: "Unreachable", message: `Cannot reach the host: ${error.message}`, exit: ExitCode.unavailable });
};

const report = (io: Io, json: boolean, error: CliError): number => {
  if (json) {
    io.err(JSON.stringify({ error: { code: error.code, message: error.message, ...(error.subject === undefined ? {} : { subject: error.subject }) } }));
  } else {
    io.err(`lemma: ${error.message}`);
  }
  return error.exit;
};

const QUESTION_POLICIES = new Set(["ask", "ignore", "dismiss"]);

/**
 * Runs one command (anything but `serve`) and returns the exit code. `reach`
 * finds and connects to the host; tests pass one that reaches a fake.
 */
export async function run(argv: readonly string[], io: Io, reach: (io: Io) => Effect.Effect<Connection, Failure, Scope.Scope> = connect): Promise<number> {
  const wantsJson = argv.includes("--json");
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        json: { type: "boolean", default: false },
        all: { type: "boolean", default: false },
        cwd: { type: "string" },
        step: { type: "string" },
        request: { type: "string" },
        filter: { type: "string" },
        records: { type: "boolean", default: false },
        system: { type: "boolean", default: false },
        tools: { type: "boolean", default: false },
        diff: { type: "boolean", default: false },
        rebuilt: { type: "boolean", default: false },
        sort: { type: "string" },
        desc: { type: "boolean", default: false },
        range: { type: "string" },
        model: { type: "string" },
        thinking: { type: "string" },
        image: { type: "string", multiple: true, default: [] },
        follow: { type: "boolean", short: "f", default: false },
        questions: { type: "string" },
        answer: { type: "string", multiple: true, default: [] },
        method: { type: "string" },
        create: { type: "boolean", default: false },
        base: { type: "string" },
        path: { type: "string" },
        limit: { type: "string" },
        session: { type: "string" },
        force: { type: "boolean", default: false },
        project: { type: "boolean", default: false },
        unset: { type: "boolean", default: false },
        token: { type: "string" },
        "request-id": { type: "string" },
        "when-busy": { type: "string" },
        steer: { type: "boolean", default: false },
        name: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    return report(io, wantsJson, usage(error instanceof Error ? error.message : String(error)));
  }
  const { positionals, values } = parsed;
  if (values.help) {
    io.out(USAGE);
    return ExitCode.ok;
  }
  const views = (["system", "tools", "diff", "rebuilt"] as const).filter((view) => values[view]);
  if (views.length > 1) return report(io, values.json, usage(`Use one of ${views.map((view) => `--${view}`).join(", ")}`));
  if (values.request !== undefined && values.step !== undefined) return report(io, values.json, usage("Use either --request or --step"));
  if (values.questions !== undefined && !QUESTION_POLICIES.has(values.questions))
    return report(io, values.json, usage("--questions must be ask, ignore, or dismiss"));
  const whenBusy = values.steer ? "steer" : values["when-busy"];
  if (values.steer && values["when-busy"] !== undefined && values["when-busy"] !== "steer")
    return report(io, values.json, usage("Use either --steer or --when-busy"));
  const limit = values.limit === undefined ? undefined : Number(values.limit);
  if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1 && limit <= FILE_SEARCH_LIMIT))
    return report(io, values.json, usage(`--limit must be a whole number from 1 to ${FILE_SEARCH_LIMIT}`));
  if (whenBusy !== undefined && whenBusy !== "steer" && whenBusy !== "follow-up" && whenBusy !== "reject")
    return report(io, values.json, usage("--when-busy must be steer, follow-up, or reject"));
  const options: Options = {
    json: values.json,
    all: values.all,
    cwd: values.cwd,
    step: values.request ?? values.step,
    filter: values.filter,
    records: values.records,
    view: views[0],
    sort: values.sort,
    desc: values.desc,
    range: values.range,
    model: values.model,
    thinking: values.thinking,
    images: values.image,
    follow: values.follow,
    questions: values.questions as QuestionPolicy | undefined,
    answers: values.answer,
    method: values.method,
    create: values.create,
    base: values.base,
    path: values.path,
    limit,
    session: values.session,
    force: values.force,
    project: values.project,
    unset: values.unset,
    token: values.token,
    requestId: values["request-id"],
    whenBusy,
    name: values.name,
  };
  const command = route(positionals, options, io);
  if (command instanceof CliError) return report(io, options.json, command);

  const program: Effect.Effect<Output | undefined, Failure, Scope.Scope> =
    typeof command === "function"
      ? Effect.flatMap(reach(io), (connection) => command(connection, io, options).pipe(Effect.mapError((error) => toCliError(error, connection.target))))
      : command.unattached;
  const result = await Effect.runPromise(Effect.scoped(program).pipe(Effect.either));
  if (result._tag === "Left") return report(io, options.json, toCliError(result.left));
  const output = result.right;
  if (output === undefined) return ExitCode.ok;
  io.out(options.json ? JSON.stringify(output.json, null, output.compact ? undefined : 2) : output.text);
  return output.exit ?? ExitCode.ok;
}
