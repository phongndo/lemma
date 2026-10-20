import { capabilityName, describeReload, hookChain, providerOf, tablesOf, usersOf } from "@lemma/contracts";
import { table as pad, time } from "@lemma/cli";
import type { InProgressInfo } from "@lemma/cli";
import type {
  ChannelInfo,
  ClientInfo,
  HostInfo,
  InspectorInfo,
  InteractionRequest,
  KernelView,
  PluginStatus,
  ReloadResult,
  WebComposition,
} from "@lemma/contracts";
import type { Target } from "./command.ts";

/** Human-readable output of the runtime's own views. `--json` bypasses all of this and prints the contract shapes. */

/** A handler's place in its hook's chain: its phase, when the hook declares phases, and its order (in it). */
const placeOf = (place: { readonly phase?: string | undefined; readonly order: number }) =>
  `${place.phase === undefined ? "" : `${place.phase} · `}order ${place.order}`;

const indent = (text: string, prefix = "    "): string =>
  text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");

const countStates = (plugins: readonly PluginStatus[]): string => {
  const counts = new Map<string, number>();
  for (const plugin of plugins) counts.set(plugin.state, (counts.get(plugin.state) ?? 0) + 1);
  return [...counts].map(([state, count]) => `${count} ${state}`).join(", ");
};

/** `running` is undefined when nothing serves `agent.running`. */
/** What started a host, as `HostInfo.startedBy` says it. */
export const startedByText = (startedBy: string | undefined): string => {
  switch (startedBy) {
    case undefined:
      return "by hand (lemma serve)";
    case "cli":
      return "by lemma serve --detach";
    case "desktop":
      return "by the desktop app, which stops it when it quits";
    case "service":
      return "as a service (lemma service)";
    default:
      return `by ${startedBy}`;
  }
};

/** `desktop, 2 web, cli`: the attached clients by kind. */
const clientsText = (clients: readonly ClientInfo[]): string => {
  const counts = new Map<string, number>();
  for (const client of clients) counts.set(client.kind, (counts.get(client.kind) ?? 0) + 1);
  return [...counts].map(([kind, count]) => (count === 1 ? kind : `${count} ${kind}`)).join(", ") || "none";
};

export const formatStatus = (
  target: Target,
  info: HostInfo,
  plugins: readonly PluginStatus[],
  /** Undefined when the host cannot say (`cli.registry` is off). */
  inProgress: readonly InProgressInfo[] | undefined,
  clients: readonly ClientInfo[],
): string =>
  pad([
    ["environment", `${target.name} (${target.url}${target.source === "local" ? "" : `, from ${target.from}`})`],
    ["host", `${info.pid === undefined ? "" : `pid ${info.pid}, `}transport ${info.version}`],
    ["started", `${info.startedAt === undefined ? "" : `${time(info.startedAt)} `}${startedByText(info.startedBy)}`],
    ["home", info.home],
    ["project", info.cwd],
    ["composition", `${info.composition.id.slice(0, 12)} (${info.composition.plugins.length} plugins)`],
    ["plugins", countStates(plugins) || "none"],
    ["clients", clientsText(clients)],
    [
      "in progress",
      inProgress === undefined
        ? "unknown (cli.registry is off)"
        : inProgress.length === 0
          ? "nothing"
          : inProgress.flatMap((report) => report.items).join("; "),
    ],
  ]);

/** `needs agent, which needs tools, which is off`: from a halted plugin to the one turned off or left out. */
const waitingNote = (plugins: readonly PluginStatus[], plugin: PluginStatus): string => {
  const byId = new Map(plugins.map((candidate) => [candidate.id, candidate]));
  const names: string[] = [];
  let current = plugin;
  while (current.haltedBy !== undefined && !names.includes(current.haltedBy)) {
    names.push(current.haltedBy);
    const next = byId.get(current.haltedBy);
    if (next === undefined || !next.enabled) break;
    current = next;
  }
  const last = byId.get(names.at(-1)!);
  const why = last === undefined ? "" : !last.enabled ? ", which is off" : last.problem !== undefined ? ", which is left out" : "";
  return `needs ${names.join(", which needs ")}${why}`;
};

/** Why a plugin is not simply running, or why it cannot be turned off. */
const pluginNote = (plugins: readonly PluginStatus[], plugin: PluginStatus): string => {
  if (plugin.fault !== undefined)
    return `${plugin.fault.phase}${plugin.fault.operation === undefined ? "" : ` ${plugin.fault.operation}`}: ${plugin.fault.message}`;
  if (plugin.problem !== undefined) return `left out: ${plugin.problem}`;
  if (plugin.haltedBy !== undefined) return plugin.state === "disabled" ? waitingNote(plugins, plugin) : `halted by ${plugin.haltedBy}`;
  if (!plugin.enabled) return `off in the ${plugin.scope ?? "user"} config`;
  return plugin.locked ?? "";
};

export const formatPlugins = (plugins: readonly PluginStatus[]): string =>
  pad(
    plugins.map((plugin) => [
      plugin.id,
      plugin.version ?? "",
      plugin.state,
      `${plugin.source}${plugin.shadows ? " (shadows bundled)" : ""}`,
      pluginNote(plugins, plugin),
    ]),
  );

const show = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value));

/**
 * One plugin as the web app's inspector shows it: its state and why, what it
 * provides and requires and who is on the other end (the host, for what it
 * provides itself: `runtime`), the hooks it intercepts, the events it
 * observes, what it contributes, and its recent faults.
 */
export const formatPlugin = (plugins: readonly PluginStatus[], plugin: PluginStatus, runtime: readonly string[]): string => {
  const lines = [
    `${plugin.id}${plugin.version === undefined ? "" : ` ${plugin.version}`}  ${plugin.state}${plugin.enabled ? "" : " (off)"}  ${plugin.source}${plugin.shadows ? " (shadows bundled)" : ""}`,
    ...(pluginNote(plugins, plugin) === "" ? [] : [`  ${pluginNote(plugins, plugin)}`]),
    "",
    "Provides",
    ...(plugin.provides.length === 0
      ? ["  nothing"]
      : plugin.provides.map((key) => `  ${capabilityName(key)}  used by ${usersOf(plugins, key).join(", ") || "no plugin"}`)),
    "Requires",
    ...(plugin.requires.length === 0
      ? ["  nothing"]
      : plugin.requires.map((key) => `  ${capabilityName(key)}  from ${runtime.includes(key) ? "the host" : (providerOf(plugins, key)?.id ?? "no plugin")}`)),
    "Hooks",
    ...(plugin.hooks?.length
      ? plugin.hooks.map((hook) => {
          const chain = hookChain(plugins, hook.name);
          const at = chain.findIndex((entry) => entry.plugin === plugin.id && entry.phase === hook.phase && entry.order === hook.order);
          return `  ${hook.name}  ${placeOf(hook)}, ${chain.length > 1 ? `${at + 1} of ${chain.length}` : "only handler"}`;
        })
      : ["  none"]),
    "Observes",
    ...(plugin.observes?.length ? plugin.observes.map((event) => `  ${event}`) : ["  none"]),
    "Contributes",
    ...(plugin.contributes?.length
      ? plugin.contributes.map(
          (registry) => `  ${registry.name}  ${registry.keys?.join(", ") ?? (registry.items === 1 ? "1 item" : `${registry.items} items`)}`,
        )
      : ["  nothing"]),
    "Faults",
    ...(plugin.faults?.length
      ? plugin.faults.map(
          (fault) =>
            `  ${new Date(fault.at).toISOString()}  #${fault.sequence} ${fault.phase}${fault.operation === undefined ? "" : ` ${fault.operation}`}: ${fault.message}`,
        )
      : ["  none since the host started"]),
  ];
  return lines.join("\n");
};

/** A plugin's settings: each field with its value (or default), and where it is set. */
export const formatConfig = (plugin: PluginStatus): string => {
  const fields = plugin.configFields ?? [];
  if (fields.length === 0) return `${plugin.id} takes no config`;
  const values = plugin.config?.values ?? {};
  const rows = fields.map((field) => {
    const value = field.secret
      ? plugin.config?.secretsSet.includes(field.key)
        ? "(set)"
        : "(not set)"
      : field.type === "other"
        ? "(edit in config.jsonc)"
        : field.key in values
          ? show(values[field.key])
          : "(not set)";
    const type = field.type === "enum" ? (field.options ?? []).join("|") : field.type;
    return [field.key, type, value, field.description ?? ""];
  });
  return `${pad(rows)}\n\nSet in the ${plugin.configScope ?? "user"} config. lemma plugins config ${plugin.id} <key> <value> (or --unset) changes one.`;
};

/** The web app's rows and files; which plugins exist is known only to the web app, which loads them. */
/**
 * What the host knows of the web app's halves: rows naming plugins the host does not have (the web app's), and the web
 * halves and stylesheets in the plugin directories. Empty when there are none.
 */
export const formatWebHalves = (composition: WebComposition, hostIds: ReadonlySet<string>): string => {
  const rows = Object.entries(composition.plugins)
    .filter(([id]) => !hostIds.has(id))
    .map(([id, row]) => [
      id,
      row.enabled === false ? "off" : row.enabled === true ? "on" : "",
      row.config === undefined ? "" : JSON.stringify(row.config),
      composition.enabledIn[id] ?? composition.configIn[id] ?? "",
    ]);
  const files = composition.files.map((file) => [`${file.source}/${file.name}`, file.kind, file.path]);
  return [
    rows.length ? `Rows for the web app's plugins (its Plugins page lists them all)\n${pad(rows)}` : "",
    files.length ? `Web halves and stylesheets\n${pad(files)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
};

/**
 * What a change did. One the host defers restarts the transport serving the request: it applies once the reply has
 * left, restarting `restarts`.
 */
export const formatReload = (report: ReloadResult, restarts = "the transport"): string =>
  report.deferred ? `applying: the host restarts ${restarts}, so clients reconnect` : (describeReload(report) ?? "nothing changed");

/** A form's fields, a line each: key, type, whether it may be left out, and what it is for. */
export const formLines = (request: Extract<InteractionRequest, { type: "form" }>): string[] =>
  request.fields.map(
    (field) =>
      `  ${field.key} (${field.type === "enum" ? field.options?.join(" | ") : field.type}${field.optional ? `, optional${field.default === undefined ? "" : `, default ${JSON.stringify(field.default)}`}` : ""})${field.description === undefined ? "" : `: ${field.description}`}`,
  );

export const formatQuestions = (questions: readonly InteractionRequest[]): string =>
  questions.length === 0
    ? "No open questions."
    : questions
        .map((question) =>
          [
            `${question.id}  ${question.type}  ${question.title}`,
            // What it is about (the command to approve, say) before the choices.
            ...((question.type === "confirm" || question.type === "select" || question.type === "form") && question.detail !== undefined
              ? [indent(question.detail)]
              : []),
            // Its fields, answered as JSON (`lemma answer <id> '{"key": …}'`).
            ...(question.type === "form" ? formLines(question).map((line) => `  ${line}`) : []),
            ...(question.type === "select"
              ? question.options.map((option, i) => `    ${i + 1}. ${option.value}${option.label === option.value ? "" : ` (${option.label})`}`)
              : []),
          ].join("\n"),
        )
        .join("\n");

/** Each hook's chain, in the order its handlers run. */
export const formatHooks = (kernel: KernelView): string =>
  kernel.hooks.length === 0
    ? "No hooks are intercepted."
    : kernel.hooks
        .map((hook) => `${hook.name}\n${pad(hook.handlers.map((handler, index) => [`  ${index + 1}.`, handler.plugin, placeOf(handler)]))}`)
        .join("\n\n");

/** Each registry and who contributes to it. */
export const formatRegistries = (kernel: KernelView): string =>
  kernel.registries.length === 0
    ? "Nothing is contributed."
    : kernel.registries
        .map(
          (registry) =>
            `${registry.name}  (${registry.items} items)\n${pad(
              registry.contributors.map((contributor) => [`  ${contributor.plugin}`, `${contributor.items}`, contributor.keys.join(", ")]),
            )}`,
        )
        .join("\n\n");

/** Each event and who observes it. */
export const formatEvents = (kernel: KernelView): string =>
  kernel.events.length === 0
    ? "No events are observed."
    : pad([["event", "observers"], ...kernel.events.map((event) => [event.name, event.observers.join(", ")])]);

/** Each capability: who provides it (the host, for what it provides itself), in what state, and who requires it. */
export const formatCapabilities = (kernel: KernelView): string =>
  pad([
    ["capability", "provided by", "required by"],
    ...kernel.capabilities.map((capability) => {
      const providers = [
        ...(capability.runtime ? ["the host"] : []),
        ...capability.providers.map((provider) => `${provider.plugin} (${provider.enabled ? provider.state : "off"})`),
      ];
      return [capability.key, providers.length === 0 ? "NOTHING" : providers.join(", "), capability.users.join(", ")];
    }),
  ]);

export const formatInspectors = (inspectors: readonly InspectorInfo[]): string =>
  inspectors.length === 0
    ? "No inspectors: no running plugin adds one."
    : pad([
        ["inspector", "title", "from", "what it shows"],
        ...inspectors.map((inspector) => [inspector.id, inspector.title, inspector.source, inspector.description ?? ""]),
      ]);

export const formatChannels = (channels: readonly ChannelInfo[]): string =>
  channels.length === 0
    ? "No channels: no running plugin serves one."
    : pad([
        ["channel", "kind", "access", "title", "from", "what it does"],
        ...channels.map((channel) => [channel.id, channel.kind, channel.access ?? "", channel.title ?? "", channel.source, channel.description ?? ""]),
      ]);

/** An inspector's snapshot or a channel call's result: as tables when it has their shape, else as JSON. */
export const formatSnapshot = (value: unknown): string => {
  const tables = tablesOf(value);
  // An object of no tables (`{}`) prints as itself, not as nothing.
  if (tables === undefined || tables.length === 0) return JSON.stringify(value, undefined, 2);
  return tables
    .map((table) => {
      const body = table.rows.length === 0 ? "  (none)" : pad([[...table.columns], ...table.rows.map((row) => [...row])]);
      return table.title === undefined ? body : `${table.title}\n${body}`;
    })
    .join("\n\n");
};
