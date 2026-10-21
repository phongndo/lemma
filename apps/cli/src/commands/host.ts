import { Effect, Stream } from "effect";
import { appUrl, HostError, kernelOf, parseConfigValue } from "@lemma/contracts";
import type { ConfigScope, PluginChange, RuntimeEvent, WebComposition } from "@lemma/contracts";
import { callChannel, dropped } from "@lemma/client";
import { CliChannels } from "@lemma/cli";
import { following, ofChannel, received, reconnecting, refined, starting } from "../channels.ts";
import { CliError, defineBuiltin, ExitCode, usage } from "../command.ts";
import type { Builtin, Io } from "../command.ts";
import { checkPlugin } from "../check.ts";
import {
  formatCapabilities,
  formatChannels,
  formatConfig,
  formatEvents,
  formatHooks,
  formatInspectors,
  formatPlugin,
  formatPlugins,
  formatQuestions,
  formatRegistries,
  formatReload,
  formatSnapshot,
  formatStatus,
  formatWebHalves,
} from "../format.ts";
import { openWebPath } from "../open.ts";
import { answering, hearing, hostEvents, noticeLine, questionHandler, toAnswer } from "../questions.ts";

/*
 * The runtime's own commands: what the host serves itself (`RuntimeRpcs`),
 * whatever plugins run. Each domain's commands come from its plugins.
 */

const HOST = "The host";
const PLUGINS = "Plugins";
const LOOK = "Look inside";
const QUESTIONS = "Questions the host asks";

const notFoundPlugin = (id: string) => new HostError({ code: "NotFound", message: `No plugin "${id}"`, subject: id });

const status = defineBuiltin({
  path: ["status"],
  group: HOST,
  summary: "The host: where it runs, who started it, its plugins' states, what it is doing, and who is attached",
  run: ({ connect }) =>
    Effect.gen(function* () {
      const { target, rpc } = yield* connect;
      const [info, plugins, inProgress, clients] = yield* Effect.all(
        [
          rpc["Host.Info"](),
          rpc["Host.Plugins"](),
          // A plugin's to say: unknown when none serves it.
          Effect.orElseSucceed(callChannel(rpc, CliChannels.inProgress, {}), () => undefined),
          rpc["Host.Clients"](),
        ],
        { concurrency: "unbounded" },
      );
      return {
        json: {
          environment: target.name,
          url: target.url,
          source: target.source,
          pid: target.pid,
          startedAt: target.startedAt,
          info,
          plugins,
          inProgress: inProgress ?? null,
          clients,
        },
        text: formatStatus(target, info, plugins, inProgress, clients),
      };
    }),
});

const plugins = defineBuiltin({
  path: ["plugins"],
  group: PLUGINS,
  summary: "Every host plugin: id, version, state (or disabled), source, and why; then the web app's rows and web halves",
  run: ({ connect }) =>
    Effect.gen(function* () {
      const { rpc } = yield* connect;
      const [list, composition] = yield* Effect.all([rpc["Host.Plugins"](), rpc["Web.Composition"]()], { concurrency: "unbounded" });
      return {
        json: list,
        text: [formatPlugins(list), formatWebHalves(composition, new Set(list.map((plugin) => plugin.id)))].filter(Boolean).join("\n\n"),
        ids: list.map((plugin) => plugin.id),
      };
    }),
});

const pluginId = [{ name: "id", description: "A plugin's id (lemma plugins lists them)", required: true }] as const;
const project = { project: { type: "boolean", description: "Write the project's .lemma/config.jsonc (a trusted project) instead of the user's" } } as const;

const enableOrDisable = (enabled: boolean) =>
  defineBuiltin({
    path: ["plugins", enabled ? "enable" : "disable"],
    group: PLUGINS,
    summary: enabled
      ? 'Turn a plugin on, both its halves: removes its "enabled": false'
      : 'Turn a plugin off, both its halves: writes "enabled": false; plugins needing it stop too',
    args: pluginId,
    flags: project,
    run: ({ connect, args, flags }) =>
      Effect.gen(function* () {
        const { rpc } = yield* connect;
        const host = (yield* rpc["Host.Plugins"]()).find((plugin) => plugin.id === args.id);
        // Already so, in the file asked for: nothing to write, and a script reads that it was so (`unchanged`).
        if (
          host !== undefined &&
          host.enabled === enabled &&
          (!enabled || host.state === "active") &&
          (flags.project ? host.scope === "project" : host.scope !== "project")
        )
          return {
            json: { [enabled ? "enabled" : "disabled"]: args.id, started: [], restarted: [], stopped: [], unchanged: true },
            text: `${args.id} is already ${enabled ? "on" : "off"}`,
          };
        const report = yield* rpc["Host.Configure"]({ plugins: { [args.id]: { enabled } }, ...(flags.project ? { scope: "project" as const } : {}) });
        // A plugin with no host half is the web app's: its row is written, and open web apps apply it.
        const applied = host !== undefined ? formatReload(report) : "not a host plugin, so open web apps apply it";
        return { json: { [enabled ? "enabled" : "disabled"]: args.id, ...report }, text: `${enabled ? "enabled" : "disabled"} ${args.id}: ${applied}` };
      }),
  });

const show = defineBuiltin({
  path: ["plugins", "show"],
  group: PLUGINS,
  summary: "One plugin: state and why, what it provides and requires and who is on the other end, its hooks and events, its recent faults",
  args: pluginId,
  run: ({ connect, args }) =>
    Effect.gen(function* () {
      const { rpc } = yield* connect;
      const [info, list] = yield* Effect.all([rpc["Host.Info"](), rpc["Host.Plugins"]()], { concurrency: "unbounded" });
      const plugin = list.find((candidate) => candidate.id === args.id);
      if (plugin === undefined) return yield* Effect.fail(notFoundPlugin(args.id));
      return { json: plugin, text: formatPlugin(list, plugin, info.runtime) };
    }),
});

const restart = defineBuiltin({
  path: ["plugins", "restart"],
  group: PLUGINS,
  summary: "Restart a failed plugin and the plugins it halted",
  args: pluginId,
  flags: { force: { type: "boolean", description: "Also when it is running, unless the host depends on it" } },
  run: ({ connect, args, flags }) =>
    Effect.gen(function* () {
      const { rpc } = yield* connect;
      yield* rpc["Host.RestartPlugin"](flags.force ? { pluginId: args.id, force: true } : { pluginId: args.id });
      return { json: { restarted: args.id }, text: `restarted ${args.id}` };
    }),
});

const config = defineBuiltin({
  path: ["plugins", "config"],
  group: PLUGINS,
  summary: "A plugin's settings: each field, its value or default, and what it does; or set one",
  description:
    "With a key and a value, sets that field in the config file that sets the plugin's config (the user's by default). A web half's value is JSON when it parses, and text otherwise.",
  args: [
    { name: "id", description: "A plugin's id", required: true },
    { name: "key", description: "A field of its config" },
    { name: "value", description: "Its new value" },
  ],
  flags: { ...project, unset: { type: "boolean", description: "Remove the field instead, back to its default" } },
  examples: ["lemma plugins config agent.loop maxSteps 100", "lemma plugins config agent.loop maxSteps --unset"],
  run: ({ connect, args, flags }) =>
    Effect.gen(function* () {
      const { rpc } = yield* connect;
      const id = args.id;
      const key = args.key;
      if (key === undefined) {
        if (flags.unset) return yield* usage("--unset needs a key");
        const plugin = (yield* rpc["Host.Plugins"]()).find((candidate) => candidate.id === id);
        if (plugin === undefined) return yield* Effect.fail(notFoundPlugin(id));
        return { json: { id: plugin.id, fields: plugin.configFields ?? [], ...plugin.config }, text: formatConfig(plugin) };
      }
      if ((args.value === undefined) === !flags.unset) return yield* usage(`plugins config ${id} ${key} needs a value, or --unset`);
      const plugin = (yield* rpc["Host.Plugins"]()).find((candidate) => candidate.id === id);
      if (plugin === undefined) {
        // A web half's: only the web app knows its fields, so the value is JSON when it parses and text otherwise.
        const parsed = flags.unset ? { value: null } : parseConfigValue(undefined, args.value!);
        if ("error" in parsed) return yield* usage(parsed.error);
        const scope: ConfigScope = flags.project ? "project" : "user";
        const report = yield* rpc["Host.Configure"]({ plugins: { [id]: { values: { [key]: parsed.value } } }, ...(scope === "project" ? { scope } : {}) });
        return {
          json: { id, key, ...(flags.unset ? { unset: true } : { value: parsed.value }), scope, ...report },
          text: `${flags.unset ? `unset ${id}.${key}` : `set ${id}.${key} = ${JSON.stringify(parsed.value)}`} in the ${scope} config: not a host plugin, so open web apps apply it`,
        };
      }
      const field = plugin.configFields?.find((candidate) => candidate.key === key);
      if (field === undefined) {
        const keys = (plugin.configFields ?? []).map((candidate) => candidate.key);
        return yield* usage(keys.length ? `${id} has no "${key}"; its fields are ${keys.join(", ")}` : `${id} takes no config`);
      }
      const parsed = flags.unset ? { value: null } : parseConfigValue(field, args.value!);
      if ("error" in parsed) return yield* usage(parsed.error);
      const scope: ConfigScope = flags.project ? "project" : (plugin.configScope ?? "user");
      const change: PluginChange = { values: { [key]: parsed.value } };
      const report = yield* rpc["Host.Configure"]({ plugins: { [id]: change }, ...(scope === "project" ? { scope } : {}) });
      return {
        json: { id, key, ...(flags.unset ? { unset: true } : { value: parsed.value }), scope, ...report },
        text: `${flags.unset ? `unset ${id}.${key}` : `set ${id}.${key} = ${JSON.stringify(parsed.value)}`} in the ${scope} config: ${formatReload(report)}`,
      };
    }),
});

const check = defineBuiltin({
  path: ["plugins", "check"],
  group: PLUGINS,
  summary: "Start a host of its own with a plugin file or folder and say what it made of it; fails on a problem",
  description:
    "The host runs in a home of its own, which is removed afterwards: the plugin's state or fault, what it provides, requires, handles, and adds, and the host's warnings. The check an author outside this repository runs first.",
  args: [{ name: "path", description: "The plugin's file or folder (default: here)" }],
  run: ({ args, io, rerun }) => checkPlugin(args.path, io, rerun),
});

const reload = defineBuiltin({
  path: ["reload"],
  group: PLUGINS,
  summary: "Re-read the config files and plugin directories, and apply them",
  run: ({ connect }) =>
    Effect.gen(function* () {
      const { rpc } = yield* connect;
      const report = yield* rpc["Host.Reload"]();
      return { json: report, text: formatReload(report, "the plugins the reload changes, the transport among them") };
    }),
});

const kernelViews = { capabilities: formatCapabilities, hooks: formatHooks, registries: formatRegistries, events: formatEvents } as const;

const kernel = defineBuiltin({
  path: ["kernel"],
  group: LOOK,
  summary: "The host as its core runs it: each capability and who provides and requires it, each hook's chain, each registry, each event",
  args: [{ name: "view", description: "capabilities (default), hooks, registries, or events" }],
  run: ({ connect, args }) =>
    Effect.gen(function* () {
      const view = args.view ?? "capabilities";
      if (!Object.hasOwn(kernelViews, view)) return yield* usage(`kernel shows capabilities, hooks, registries, or events, not "${view}"`);
      const { rpc } = yield* connect;
      const [info, list] = yield* Effect.all([rpc["Host.Info"](), rpc["Host.Plugins"]()], { concurrency: "unbounded" });
      const key = view as keyof typeof kernelViews;
      const kernelView = kernelOf(list, info.runtime);
      return { json: kernelView[key], text: kernelViews[key](kernelView) };
    }),
});

const inspectors = defineBuiltin({
  path: ["inspectors"],
  group: LOOK,
  summary: "What host plugins let you look into (tools, running turns, commands…), or one inspector's snapshot as tables",
  args: [{ name: "id", description: "An inspector, to print its snapshot" }],
  run: ({ connect, args }) =>
    Effect.gen(function* () {
      const { rpc } = yield* connect;
      if (args.id === undefined) {
        const list = yield* rpc["Host.Inspectors"]();
        return { json: list, text: formatInspectors(list), ids: list.map((inspector) => inspector.id) };
      }
      const snapshot = yield* rpc["Host.Inspect"]({ id: args.id }).pipe(Effect.mapError(starting(args.id)));
      return { json: snapshot, text: formatSnapshot(snapshot) };
    }),
});

const payloadOf = (text: string | undefined): { readonly payload?: unknown } | CliError => {
  if (text === undefined) return {};
  try {
    return { payload: JSON.parse(text) };
  } catch (error) {
    return usage(`The payload must be JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
};

const channelArgs = [
  { name: "id", description: "A channel's id (lemma channels lists them)", required: true },
  { name: "payload", description: "Its payload, as JSON" },
] as const;

const channels = defineBuiltin({
  path: ["channels"],
  group: LOOK,
  summary:
    "What host plugins serve their clients: id, call or stream, what calling it does (read, operate, change, or secret, by which agents' scripts reach it), title, plugin, and what it does",
  run: ({ connect }) =>
    Effect.gen(function* () {
      const { rpc } = yield* connect;
      const list = yield* rpc["Channel.List"]();
      return { json: list, text: formatChannels(list), ids: list.map((channel) => channel.id) };
    }),
});

const channelCall = defineBuiltin({
  path: ["channels", "call"],
  group: LOOK,
  summary: "Call a channel with a JSON payload and print the result",
  args: channelArgs,
  examples: ['lemma channels call sessions.list \'{"cwd": "/repo"}\''],
  run: ({ connect, args }) =>
    Effect.gen(function* () {
      const request = payloadOf(args.payload);
      if (request instanceof CliError) return yield* request;
      const { rpc } = yield* connect;
      // A call with no result (`Schema.Void`) answers `null`.
      const result = yield* Effect.mapError(rpc["Channel.Call"]({ id: args.id, ...request }), refined(args.id));
      return result === null ? { json: null, text: `called ${args.id}: no result` } : { json: result, text: formatSnapshot(result) };
    }),
});

/**
 * Waits while stdout is behind (`Io.drained`), so what is printed goes out at
 * its reader's pace. What the host sends meanwhile waits in the command's
 * queue (`received`), never on the connection.
 */
const caughtUp = (io: Io): Effect.Effect<void> => {
  const drained = io.drained;
  if (drained === undefined) return Effect.void;
  return Effect.callback<void>((resume, signal) => {
    const pending = drained(signal);
    if (pending === undefined) resume(Effect.void);
    else void pending.then(() => resume(Effect.void));
  });
};

/**
 * `channels open`: the stream read once over the command's `Host`, printing
 * what it sends as it is: a connection that drops ends it (exit 3), as its
 * plugin's reload does (`Withdrawn`), rather than opening it again.
 */
const channelOpen = defineBuiltin({
  path: ["channels", "open"],
  group: LOOK,
  summary: "Open a channel's stream and print each element as a line of JSON until it ends or is stopped",
  description: "It fails Withdrawn when its plugin stops or reloads, and ends with a dropped connection.",
  args: channelArgs,
  run: ({ connect, args, io }) =>
    Effect.gen(function* () {
      const request = payloadOf(args.payload);
      if (request instanceof CliError) return yield* request;
      const connection = yield* connect;
      const host = yield* connection.host({ answers: false });
      const elements = yield* received<unknown>((onElement, onEnd) => host.channel.open(args.id, request.payload, onElement, onEnd));
      yield* Stream.runForEach(Stream.mapError(elements, refined(args.id)), (element) =>
        Effect.andThen(
          Effect.sync(() => io.out(JSON.stringify(element))),
          caughtUp(io),
        ),
      );
      return undefined;
    }),
});

const questions = defineBuiltin({
  path: ["questions"],
  group: QUESTIONS,
  summary: "Open questions, with their ids",
  run: ({ connect }) =>
    Effect.gen(function* () {
      const { rpc } = yield* connect;
      const list = yield* rpc["Interaction.List"]();
      return { json: list, text: formatQuestions(list), ids: list.map((question) => question.id) };
    }),
});

const answer = defineBuiltin({
  path: ["answer"],
  group: QUESTIONS,
  summary: "Answer a question: yes/no, text, or an option (its value, label, or number)",
  args: [
    { name: "question", description: "Its id (lemma questions lists them)", required: true },
    { name: "value", description: "The answer", required: true, variadic: true },
  ],
  run: ({ connect, args }) =>
    Effect.gen(function* () {
      const { rpc } = yield* connect;
      const request = (yield* rpc["Interaction.List"]()).find((candidate) => candidate.id === args.question);
      if (request === undefined)
        return yield* new CliError({ code: "NotFound", message: `No open question ${args.question}`, subject: args.question, exit: ExitCode.failed });
      const given = toAnswer(request, args.value.join(" "));
      if (typeof given === "string") return yield* usage(given);
      yield* rpc["Interaction.Answer"]({ id: args.question, answer: given });
      return { json: { answered: args.question, answer: given }, text: `answered "${request.title}"` };
    }),
});

const dismiss = defineBuiltin({
  path: ["dismiss"],
  group: QUESTIONS,
  summary: "Dismiss a question",
  args: [{ name: "question", description: "Its id", required: true }],
  run: ({ connect, args }) =>
    Effect.gen(function* () {
      const { rpc } = yield* connect;
      yield* rpc["Interaction.Dismiss"]({ id: args.question });
      return { json: { dismissed: args.question }, text: `dismissed ${args.question}` };
    }),
});

/** One of the host's own events as a line. */
const hostLine = (event: RuntimeEvent): string => {
  switch (event.type) {
    case "notice":
      return noticeLine(event);
    case "interaction":
      return `question ${event.request.id} (${event.request.type}): ${event.request.title}`;
    case "interaction-closed":
      return `question ${event.id} closed`;
    case "plugins-changed":
      return `plugins: ${event.plugins.map((plugin) => `${plugin.id}=${plugin.state}`).join(" ")}`;
    case "channels-changed":
      return `channels: ${event.channels.map((channel) => channel.id).join(" ")}`;
    case "web-changed":
      return webLine(event.web);
  }
};

const webLine = (web: WebComposition): string => {
  const rows = Object.entries(web.plugins).map(([id, row]) => `${id}${row.enabled === false ? "=off" : ""}${row.config === undefined ? "" : "+config"}`);
  return `web: ${rows.length ? rows.join(" ") : "no rows"}; files ${web.files.length ? web.files.map((file) => `${file.source}/${file.name}`).join(" ") : "none"}`;
};

/**
 * `lemma events`: what the host publishes, as it happens. Its own events
 * (`RuntimeEvent`: notices, questions, and plugin, channel, and web changes),
 * and every stream its plugins serve that opens with no payload (a domain's
 * changes: `agent.activity`, `sessions.changes`, …), or those `--channel`
 * names. A stream that is not served, or that its plugin's reload withdrew, is
 * followed again once it is served (`follow` in `@lemma/client`); one that
 * takes a payload is left out. A dropped connection is reconnected
 * (`reconnecting`): each stream opens again, and the host's own events while
 * it was down are lost. With `--json`, each line is `{"from", "element"}`:
 * `from` is `host` for the host's own events, else the channel.
 */
const events = defineBuiltin({
  path: ["events"],
  group: LOOK,
  summary: "Follow what the host publishes: its own events and its plugins' streams; NDJSON of {from, element} with --json",
  description:
    "Watching answers no question unless --questions says how (then it answers every question, from any client's work). Each stream its plugins serve that takes no payload is followed, or only those --channel names.",
  flags: {
    channel: { type: "string", multiple: true, placeholder: "id", description: "Follow only this stream (repeatable), with the host's own events" },
  },
  run: ({ connect, io, globals, flags }) =>
    Effect.gen(function* () {
      if (globals.answers.length > 0 && globals.questions === undefined)
        return yield* usage("events answers questions only with --questions ask, ignore, or dismiss");
      const connection = yield* connect;
      // Watching never answers unless asked to.
      const { host, events: heard } = yield* hearing(connection, globals.questions !== undefined && answering(io, globals));
      const print = (from: string, element: unknown, text: string | undefined) => {
        if (globals.json) io.out(JSON.stringify({ from, element }));
        else if (text !== undefined) io.out(text);
      };
      const note = (text: string) => {
        if (!globals.json) io.out(text);
      };
      const handle = globals.questions === undefined ? undefined : yield* questionHandler(host, io, globals, undefined);
      yield* hostEvents(heard, (event) => {
        print("host", event, hostLine(event));
        return handle === undefined ? Effect.void : handle(event);
      });
      const streams =
        flags.channel.length > 0
          ? flags.channel
          : (yield* connection.rpc["Channel.List"]()).filter((channel) => channel.kind === "stream").map((channel) => channel.id);
      const explicit = flags.channel.length > 0;
      for (const id of streams)
        yield* following(
          host,
          id,
          () => undefined,
          (element: unknown) => print(id, element, `${id}: ${JSON.stringify(element)}`),
          (error) => {
            // Said once for every stream (`reconnecting`), and opened again on the next connection.
            if (error !== undefined && dropped(error)) return true;
            if (ofChannel(error, id, "InvalidPayload")) {
              if (explicit) note(`${id} takes a payload: lemma channels open ${id} '<json>'`);
              return false;
            }
            if (ofChannel(error, id, "Withdrawn")) note(`${id} withdrawn: its plugin stopped or reloaded; following it again`);
            else if (ofChannel(error, id, "NotFound")) note(`${id} not served: following it once it is`);
            else {
              note(error === undefined ? `${id} ended` : `${id} ended: ${error.message}`);
              return false;
            }
            return true;
          },
        );
      // Until interrupted, or the connection is given up on.
      return yield* reconnecting(host, io, Effect.never);
    }),
});

const open = defineBuiltin({
  path: ["open"],
  group: HOST,
  summary: "Open the web app at one of its addresses: in the desktop app when it runs here, else the browser; prints the address",
  description: "Without a display, or over SSH, it only prints it. With --json it prints {url} and opens nothing.",
  args: [{ name: "path", description: "An address of the web app (default /); lemma sessions open <id> opens a session" }],
  run: ({ connect, args, io, globals }) =>
    Effect.gen(function* () {
      const { target } = yield* connect;
      const path = args.path ?? "/";
      if (!path.startsWith("/")) return yield* usage(`An address of the web app starts with /, as /threads/<id> does, not "${path}"`);
      const url = appUrl(target.url, path, target.token);
      if (!globals.json) openWebPath(io, target, path);
      return { json: { url }, text: url };
    }),
});

export const hostCommands: readonly Builtin[] = [
  status,
  open,
  plugins,
  show,
  enableOrDisable(true),
  enableOrDisable(false),
  restart,
  config,
  check,
  reload,
  kernel,
  inspectors,
  channels,
  channelCall,
  channelOpen,
  events,
  questions,
  answer,
  dismiss,
];
