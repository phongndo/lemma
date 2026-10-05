import { contentText, joinCommandLine, MCP_HIDDEN, recordDuration, recordName, recordStatus, RECORD_KIND_LABEL, tablesOf } from "@lemma/contracts";
import type {
  CommandInfo,
  InspectorInfo,
  KernelView,
  DirectoryListing,
  FileSearchResult,
  GitBranch,
  HostInfo,
  InteractionRequest,
  LedgerRecord,
  McpLogEntry,
  McpServerInfo,
  McpServerSpec,
  McpToolInfo,
  ModelInfo,
  PluginStatus,
  ProviderInfo,
  QueuedPrompt,
  SectionDiff,
  SessionEvent,
  SessionInfo,
  TrajectoryRequest,
  TrajectoryStep,
  TrajectoryTurn,
  UiComposition,
  Usage,
  WorkspaceStatus,
} from "@lemma/contracts";
import type { Target } from "./command.ts";
import type { TurnResult } from "./live.ts";

/** Human-readable output. `--json` bypasses all of this and prints the contract shapes. */

const pad = (rows: readonly (readonly string[])[]): string => {
  const widths = rows.reduce<number[]>((acc, row) => row.map((cell, i) => Math.max(acc[i] ?? 0, cell.length)), []);
  return rows
    .map((row) =>
      row
        .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]!)))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
};

const time = (ms: number): string => {
  const date = new Date(ms);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
};

const countStates = (plugins: readonly PluginStatus[]): string => {
  const counts = new Map<string, number>();
  for (const plugin of plugins) counts.set(plugin.state, (counts.get(plugin.state) ?? 0) + 1);
  return [...counts].map(([state, count]) => `${count} ${state}`).join(", ");
};

export const formatStatus = (target: Target, info: HostInfo, plugins: readonly PluginStatus[], running: readonly string[]): string =>
  pad([
    ["host", `${target.url} (${target.pid === undefined ? `from ${target.from}` : `pid ${target.pid}`}, transport ${info.version})`],
    ["home", info.home],
    ["project", info.cwd],
    ["composition", `${info.composition.id.slice(0, 12)} (${info.composition.plugins.length} plugins)`],
    ["plugins", countStates(plugins) || "none"],
    ["running", running.length ? running.join(", ") : "none"],
  ]);

/** `needs agent, which needs tools, which is off`: from a halted plugin to the one turned off. */
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
  return `needs ${names.join(", which needs ")}${last !== undefined && !last.enabled ? ", which is off" : ""}`;
};

/** Why a plugin is not simply running, or why it cannot be turned off. */
const pluginNote = (plugins: readonly PluginStatus[], plugin: PluginStatus): string => {
  if (plugin.fault !== undefined)
    return `${plugin.fault.phase}${plugin.fault.operation === undefined ? "" : ` ${plugin.fault.operation}`}: ${plugin.fault.message}`;
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

const capability = (key: string) => key.slice(key.lastIndexOf("/") + 1);

/**
 * One plugin as the web app's inspector shows it: its state and why, what it
 * provides and requires and who is on the other end, the hooks it intercepts,
 * the events it observes, what it contributes, and its recent faults.
 */
export const formatPlugin = (plugins: readonly PluginStatus[], plugin: PluginStatus): string => {
  const users = (key: string) => plugins.filter((other) => other.requires.includes(key)).map((other) => other.id);
  const provider = (key: string) =>
    (plugins.find((other) => other.enabled && other.provides.includes(key)) ?? plugins.find((other) => other.provides.includes(key)))?.id;
  const handlers = (name: string) =>
    plugins
      .flatMap((other) => other.hooks?.filter((hook) => hook.name === name).map((hook) => ({ id: other.id, order: hook.order })) ?? [])
      .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
  const lines = [
    `${plugin.id}${plugin.version === undefined ? "" : ` ${plugin.version}`}  ${plugin.state}${plugin.enabled ? "" : " (off)"}  ${plugin.source}${plugin.shadows ? " (shadows bundled)" : ""}`,
    ...(pluginNote(plugins, plugin) === "" ? [] : [`  ${pluginNote(plugins, plugin)}`]),
    "",
    "Provides",
    ...(plugin.provides.length === 0 ? ["  nothing"] : plugin.provides.map((key) => `  ${capability(key)}  used by ${users(key).join(", ") || "no plugin"}`)),
    "Requires",
    ...(plugin.requires.length === 0 ? ["  nothing"] : plugin.requires.map((key) => `  ${capability(key)}  from ${provider(key) ?? "no plugin"}`)),
    "Hooks",
    ...(plugin.hooks?.length
      ? plugin.hooks.map((hook) => {
          const all = handlers(hook.name);
          return `  ${hook.name}  order ${hook.order}, ${all.length > 1 ? `${all.findIndex((entry) => entry.id === plugin.id) + 1} of ${all.length}` : "only handler"}`;
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
export const formatUi = (ui: UiComposition): string => {
  const rows = Object.entries(ui.plugins).map(([id, row]) => [
    id,
    row.enabled === false ? "off" : row.enabled === true ? "on" : "",
    row.config === undefined ? "" : JSON.stringify(row.config),
    ui.enabledIn[id] ?? ui.configIn[id] ?? "",
  ]);
  const files = ui.files.map((file) => [`${file.source}/${file.name}`, file.kind, file.path]);
  return [
    rows.length ? `Rows\n${pad(rows)}` : "No ui rows: every web app plugin runs with its default config.",
    files.length ? `Files\n${pad(files)}` : "No UI files in ~/.lemma/ui.",
  ].join("\n\n");
};

export const formatReload = (report: {
  readonly started: readonly string[];
  readonly restarted: readonly string[];
  readonly stopped: readonly string[];
  readonly failed?: readonly string[] | undefined;
  readonly deferred?: boolean | undefined;
}): string => {
  if (report.deferred) return "applying: the host restarts the plugins that use it, the transport among them, so clients reconnect";
  const parts = [
    report.started.length ? `started ${report.started.join(", ")}` : "",
    report.restarted.length ? `restarted ${report.restarted.join(", ")}` : "",
    report.stopped.length ? `stopped ${report.stopped.join(", ")}` : "",
    report.failed?.length ? `failed ${report.failed.join(", ")}` : "",
  ].filter(Boolean);
  return parts.length ? parts.join("; ") : "nothing changed";
};

export const formatSessions = (sessions: readonly SessionInfo[], withCwd: boolean): string =>
  pad(
    sessions.map((session) => [
      session.id,
      time(session.updatedAt),
      [session.title ?? "(untitled)", session.pinned ? "[pinned]" : "", session.archived ? "[archived]" : ""].filter(Boolean).join(" "),
      ...(withCwd ? [session.cwd] : []),
    ]),
  );

/** Long tool output is cut to its first lines; `--json` has the full content. */
const MAX_LINES = 12;

const clip = (text: string): string => {
  const lines = text.trimEnd().split("\n");
  return lines.length <= MAX_LINES ? lines.join("\n") : [...lines.slice(0, MAX_LINES), `… ${lines.length - MAX_LINES} more lines`].join("\n");
};

const texts = (content: readonly { readonly type: string; readonly text?: string }[]): string =>
  content.map((part) => (part.type === "text" ? (part.text ?? "") : `[${part.type}]`)).join("\n");

const eventLines = (event: SessionEvent): string[] => {
  const data = event.data;
  switch (data.type) {
    case "message": {
      const message = data.message;
      if (message.role === "user") return [`── user`, texts(message.content)];
      if (message.role === "toolResult") return [`── ${message.toolName}${message.isError ? " (error)" : ""}`, clip(texts(message.content))];
      const lines = [`── assistant (${message.provider}/${message.model})`];
      for (const part of message.content) {
        if (part.type === "text") lines.push(part.text);
        else if (part.type === "toolCall") lines.push(`→ ${part.name} ${JSON.stringify(part.arguments)}`);
      }
      if (message.errorMessage !== undefined) lines.push(`error: ${message.errorMessage}`);
      return lines;
    }
    case "attempt":
      return [`── failed model call (${data.message.stopReason})${data.message.errorMessage === undefined ? "" : `: ${data.message.errorMessage}`}`];
    case "compaction":
      return [`── compacted ${data.tokensBefore} tokens (${data.source})`, clip(data.summary)];
    case "turn-end":
      return data.reason === "done" ? [] : [`── turn ended: ${data.reason}${data.error === undefined ? "" : ` — ${data.error}`}`];
    default:
      return [];
  }
};

/** The session header and the current branch as a transcript. Request headers are left to `--json`. */
export const formatSession = (info: SessionInfo, branch: readonly SessionEvent[]): string => {
  const header = pad([
    ["session", `${info.id}${info.title === undefined ? "" : `  ${info.title}`}`],
    ["cwd", info.cwd],
    ["created", time(info.createdAt)],
    ["updated", time(info.updatedAt)],
    ["events", `${info.lastSeq} (${branch.length} on the current branch)`],
  ]);
  const body = branch.flatMap(eventLines);
  return body.length ? `${header}\n\n${body.join("\n")}` : header;
};

const count = (n: number): string => n.toLocaleString("en-US");

const tokens = (n: number): string => (n < 1_000 ? String(n) : n < 100_000 ? `${(n / 1_000).toFixed(1)}k` : `${Math.round(n / 1_000)}k`);

const seconds = (ms: number): string => (ms < 1_000 ? `${Math.max(0, Math.round(ms))}ms` : `${(ms / 1_000).toFixed(1)}s`);

/** Input counts cache reads and writes, as providers bill them. */
const usageText = (usage: Usage): string => {
  const parts = [`↑${tokens(usage.input + usage.cacheRead + usage.cacheWrite)}`, `↓${tokens(usage.output)}`];
  if (usage.cacheRead > 0) parts.push(`cache ${tokens(usage.cacheRead)}`);
  if (usage.cost.total > 0) parts.push(`$${usage.cost.total.toFixed(usage.cost.total < 0.01 ? 4 : 3)}`);
  return parts.join(" ");
};

const shortModel = (ref: string): string => ref.slice(ref.indexOf("/") + 1);

const stepLine = (step: TrajectoryStep): string[] => {
  const request = step.request;
  const response = step.response;
  const timing = response?.timing;
  const calls = step.tools.map((run) => `${run.call.name}${run.result?.isError ? "!" : ""}`);
  return [
    `  ${step.index}`,
    step.stepId,
    request === undefined ? "(no request)" : `${shortModel(request.model)}${request.thinking === undefined ? "" : ` (${request.thinking})`}`,
    request === undefined ? "" : `${request.messages} msg${request.messages === 1 ? "" : "s"}`,
    response === undefined
      ? step.attempts.length
        ? `failed: ${step.attempts.at(-1)!.message.errorMessage ?? step.attempts.at(-1)!.message.stopReason}`
        : "running"
      : usageText(response.message.usage),
    timing?.firstTokenAt === undefined ? "" : `ttft ${seconds(timing.firstTokenAt - timing.startedAt)}`,
    timing === undefined ? "" : seconds(timing.endedAt - timing.startedAt),
    calls.length ? `→ ${calls.join(", ")}` : "",
  ];
};

const firstLine = (text: string, max = 80): string => {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** One line per step under a header per turn; `inspect --step` has the detail. */
export const formatTrajectory = (turns: readonly TrajectoryTurn[]): string => {
  if (turns.length === 0) return "No turns on the current branch.";
  return turns
    .map((turn) => {
      const prompt = turn.prompt?.content.map((part) => (part.type === "text" ? part.text : "[image]")).join(" ") ?? "";
      const header = [
        `Turn ${turn.index}`,
        turn.end?.reason ?? "running",
        `${turn.steps.length} step${turn.steps.length === 1 ? "" : "s"}`,
        usageText(turn.usage),
        ...(turn.endedAt === undefined ? [] : [seconds(turn.endedAt - turn.startedAt)]),
      ].join(" · ");
      return [
        header,
        ...(prompt ? [`  "${firstLine(prompt)}"`] : []),
        ...(turn.end?.error === undefined ? [] : [`  error: ${turn.end.error}`]),
        pad(turn.steps.map(stepLine)),
      ].join("\n");
    })
    .join("\n\n");
};

const indent = (text: string, prefix = "    "): string =>
  text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");

/** Everything about one step: the request as sent and who contributed each part, the response, and the tool runs. */
export const formatStep = (turn: TrajectoryTurn, step: TrajectoryStep): string => {
  const lines = [`Turn ${turn.index}, step ${step.index} of ${turn.steps.length} (${step.stepId})`];
  const request = step.request;
  if (request === undefined) {
    lines.push("", "No request was logged for this step.");
  } else {
    const sectionChars = request.sections.reduce((sum, section) => sum + section.chars, 0);
    const toolChars = request.tools.reduce((sum, tool) => sum + tool.chars, 0);
    lines.push(
      "",
      pad([
        ["request", request.eventId],
        ["model", `${request.model}${request.thinking === undefined ? "" : `, thinking ${request.thinking}`}`],
        ["composition", request.composition],
        ["history", `${request.messages} messages`],
      ]),
    );
    lines.push("", `System prompt: ${count(sectionChars)} chars in ${request.sections.length} section${request.sections.length === 1 ? "" : "s"}`);
    for (const section of request.sections) {
      lines.push(`  ${section.id} from ${section.source}, ${count(section.chars)} chars${section.changed ? " (changed)" : ""}`);
      if (section.text) lines.push(indent(clip(section.text)));
    }
    if (request.sections.length > 0 && request.sections.every((section) => section.text === undefined) && request.system !== undefined) {
      lines.push("  (the logged system prompt does not split by the recorded sizes)", indent(clip(request.system)));
    }
    lines.push("", `Tools: ${request.tools.length} (${count(toolChars)} chars)`);
    if (request.tools.length) {
      lines.push(pad(request.tools.map((tool) => [`  ${tool.name}`, `from ${tool.source}`, `${count(tool.chars)} chars`, tool.changed ? "(changed)" : ""])));
    }
    if (request.removed.length) lines.push("", `Removed since the previous request: ${request.removed.join(", ")}`);
  }
  for (const attempt of step.attempts) {
    lines.push(
      "",
      `Failed call (${attempt.message.stopReason}) after ${seconds(attempt.timing.endedAt - attempt.timing.startedAt)}: ${attempt.message.errorMessage ?? ""}`.trimEnd(),
    );
  }
  const response = step.response;
  if (response !== undefined) {
    const timing = response.timing;
    lines.push(
      "",
      [
        `Response: ${response.message.stopReason}`,
        usageText(response.message.usage),
        ...(timing?.firstTokenAt === undefined ? [] : [`ttft ${seconds(timing.firstTokenAt - timing.startedAt)}`]),
        ...(timing === undefined ? [] : [seconds(timing.endedAt - timing.startedAt)]),
      ].join(" · "),
    );
    const text = response.message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    if (text) lines.push(indent(clip(text)));
  }
  if (step.tools.length) {
    lines.push("", "Tool runs:");
    lines.push(
      pad(
        step.tools.map((run) => [
          `  ${run.call.name}`,
          run.result === undefined ? "no result" : run.result.isError ? "error" : "ok",
          run.timing === undefined ? "" : seconds(run.timing.endedAt - run.timing.startedAt),
          firstLine(JSON.stringify(run.call.arguments), 60),
        ]),
      ),
    );
  }
  return lines.join("\n");
};

const NAME_CHARS = 100;

/** The ledger as a table, one row per record: where it is, what it is, how it went, and what it said or did. */
export const formatRecords = (records: readonly LedgerRecord[], running: boolean): string => {
  if (records.length === 0) return "No records match.";
  const rows = records.map((record) => {
    const step = record.kind === "assistant" || record.kind === "tool" ? `${record.turn.index}.${record.step.index}` : `${record.turn.index}`;
    const request = record.kind === "assistant" || record.kind === "system" ? `#${record.requestNumber}` : "";
    const duration = recordDuration(record);
    const usage = record.kind === "assistant" ? record.message.usage : undefined;
    const name = recordName(record).replace(/\s+/g, " ");
    return [
      step,
      request,
      RECORD_KIND_LABEL[record.kind],
      recordStatus(record, running),
      duration === undefined ? "" : seconds(duration),
      usage === undefined ? "" : `${tokens(usage.input + usage.cacheRead + usage.cacheWrite)}/${tokens(usage.output)}`,
      name.length > NAME_CHARS ? `${name.slice(0, NAME_CHARS - 1)}…` : name,
    ];
  });
  return pad([["step", "req", "kind", "status", "time", "tokens", "name"], ...rows]);
};

/** Every system section in full, headed by the plugin that contributed it. */
export const formatSystem = (request: TrajectoryRequest): string => {
  const blocks = request.sections.map((section) =>
    [
      `── ${section.id} from ${section.source}, ${count(section.chars)} chars${section.changed ? " (changed)" : ""}`,
      section.text ?? "(not recoverable from the log)",
    ].join("\n"),
  );
  if (request.sections.every((section) => section.text === undefined) && request.system !== undefined) {
    blocks.push(["── whole prompt (the logged prompt does not split by the recorded sizes)", request.system].join("\n"));
  }
  return blocks.join("\n\n");
};

/** Every tool definition, headed by the plugin that contributed it. */
export const formatTools = (request: TrajectoryRequest): string =>
  request.tools
    .map((tool) =>
      [
        `── ${tool.name} from ${tool.source}, ${count(tool.chars)} chars${tool.changed ? " (changed)" : ""}`,
        ...(tool.spec === undefined ? [] : [tool.spec.description, JSON.stringify(tool.spec.parameters, null, 2)]),
      ].join("\n"),
    )
    .join("\n\n") || "No tools.";

/** Section-by-section changes to the system prompt, as unified-style lines. */
export const formatDiff = (diff: readonly SectionDiff[], first: boolean): string => {
  if (first) return "This is the first request; everything in it is new. Use --system to read it.";
  if (diff.length === 0) return "The system prompt is unchanged from the request before.";
  return diff
    .map((section) =>
      [
        `── ${section.id} from ${section.source} (${section.status})`,
        ...section.lines.map((line) => `${line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "} ${line.text}`),
      ].join("\n"),
    )
    .join("\n\n");
};

export const formatModels = (models: readonly ModelInfo[]): string =>
  models.length === 0
    ? "No models. Log in to a provider (lemma providers, lemma login <provider>), or use --all."
    : pad([
        ["model", "name", "context", "thinking", "input", "$/M in/out"],
        ...models.map((model) => [
          model.ref,
          model.name,
          tokens(model.contextWindow),
          model.reasoning ? model.thinkingLevels.join(",") : "no",
          model.input.join(","),
          model.cost.input === 0 && model.cost.output === 0 ? "" : `${model.cost.input}/${model.cost.output}`,
        ]),
      ]);

export const formatProviders = (providers: readonly ProviderInfo[]): string =>
  pad([
    ["provider", "name", "configured", "from", "login"],
    ...providers.map((provider) => [
      provider.id,
      provider.name,
      provider.configured ? "yes" : "no",
      provider.source ?? "",
      provider.auth.map((auth) => auth.type).join(", "),
    ]),
  ]);

export const formatCommands = (commands: readonly CommandInfo[]): string =>
  commands.length === 0
    ? "No commands."
    : pad([["command", "title", "category", "from"], ...commands.map((command) => [command.id, command.title, command.category ?? "", command.source])]);

/** Prompts waiting for a turn: mode, request id, age, and their text on one line. */
export const formatQueue = (queue: readonly QueuedPrompt[]): string =>
  queue.length === 0
    ? "Nothing queued."
    : pad([
        ["mode", "request", "queued", "prompt"],
        ...queue.map((queued) => [
          queued.mode,
          queued.requestId,
          new Date(queued.at).toISOString(),
          contentText(queued.content).replace(/\s+/g, " ").trim().slice(0, 100),
        ]),
      ]);

export const formatQuestions = (questions: readonly InteractionRequest[]): string =>
  questions.length === 0
    ? "No open questions."
    : questions
        .map((question) =>
          [
            `${question.id}  ${question.type}  ${question.title}`,
            // What it is about (the command to approve, say) before the choices.
            ...((question.type === "confirm" || question.type === "select") && question.detail !== undefined ? [indent(question.detail)] : []),
            ...(question.type === "select"
              ? question.options.map((option, i) => `    ${i + 1}. ${option.value}${option.label === option.value ? "" : ` (${option.label})`}`)
              : []),
          ].join("\n"),
        )
        .join("\n");

/** The reply (unless it was streamed) and a one-line summary of how the turn ended. */
export const formatTurnResult = (turn: TurnResult, withText: boolean): string => {
  const summary = [
    `turn ${turn.reason}`,
    `${turn.steps} step${turn.steps === 1 ? "" : "s"}`,
    `${turn.toolCalls} tool call${turn.toolCalls === 1 ? "" : "s"}`,
    ...(turn.usage === undefined ? [] : [usageText(turn.usage)]),
    ...(turn.duration === undefined ? [] : [seconds(turn.duration)]),
    `session ${turn.session}`,
  ].join(" · ");
  return [...(withText && turn.text ? [turn.text.trimEnd(), ""] : []), `── ${summary}`, ...(turn.error === undefined ? [] : [`error: ${turn.error}`])].join(
    "\n",
  );
};

export const formatWorkspace = (status: WorkspaceStatus): string => {
  if (!status.exists) return `${status.path}: does not exist`;
  const git = status.git;
  if (git === undefined) return `${status.path}: not a git repository`;
  return pad([
    ["path", status.path],
    ["branch", git.branch ?? `(detached at ${git.head ?? "?"})`],
    ["head", git.head ?? "(no commits)"],
    ["changes", String(git.changes)],
    ...(git.upstream === undefined ? [] : [["upstream", `${git.upstream} (ahead ${git.ahead}, behind ${git.behind})`]]),
    ...(git.worktreeOf === undefined ? [] : [["worktree of", git.worktreeOf]]),
  ]);
};

export const formatBranches = (branches: readonly GitBranch[]): string =>
  branches.length === 0
    ? "No branches."
    : pad(
        branches.map((branch) => [
          branch.current ? "*" : " ",
          branch.name,
          branch.remote ? "remote" : "",
          time(branch.updatedAt),
          branch.worktree === undefined ? "" : `in ${branch.worktree}`,
        ]),
      );

export const formatListing = (listing: DirectoryListing): string =>
  [listing.parent, ...listing.entries.map((entry) => `  ${entry.name}/${entry.git ? "  (git)" : ""}`), ...(listing.truncated ? ["  …"] : [])].join("\n");

export const formatFiles = (result: FileSearchResult): string =>
  [
    ...(result.entries.length === 0 ? ["No matches."] : result.entries.map((entry) => (entry.kind === "directory" ? `${entry.path}/` : entry.path))),
    ...(result.truncated ? ["…"] : []),
    ...(result.indexing === true ? ["(still reading the directory: some may be missing)"] : []),
  ].join("\n");

/** Each hook's chain, in the order its handlers run. */
export const formatHooks = (kernel: KernelView): string =>
  kernel.hooks.length === 0
    ? "No hooks are intercepted."
    : kernel.hooks
        .map((hook) => `${hook.name}\n${pad(hook.handlers.map((handler, index) => [`  ${index + 1}.`, handler.plugin, `order ${handler.order}`]))}`)
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

/** Each capability: who provides it, in what state, and who requires it. */
export const formatCapabilities = (kernel: KernelView): string =>
  pad([
    ["capability", "provided by", "required by"],
    ...kernel.capabilities.map((capability) => [
      capability.key,
      capability.providers.length === 0
        ? "NOTHING"
        : capability.providers.map((provider) => `${provider.plugin} (${provider.enabled ? provider.state : "off"})`).join(", "),
      capability.users.join(", "),
    ]),
  ]);

export const formatInspectors = (inspectors: readonly InspectorInfo[]): string =>
  inspectors.length === 0
    ? "No inspectors: no running plugin adds one."
    : pad([
        ["inspector", "title", "from", "what it shows"],
        ...inspectors.map((inspector) => [inspector.id, inspector.title, inspector.source, inspector.description ?? ""]),
      ]);

/** An inspector's snapshot: as tables when it has their shape, else as JSON. */
export const formatSnapshot = (value: unknown): string => {
  const tables = tablesOf(value);
  if (tables === undefined) return JSON.stringify(value, undefined, 2);
  return tables
    .map((table) => {
      const body = table.rows.length === 0 ? "  (none)" : pad([[...table.columns], ...table.rows.map((row) => [...row])]);
      return table.title === undefined ? body : `${table.title}\n${body}`;
    })
    .join("\n\n");
};

// ------------------------------------------------------------------ MCP servers

/** `npx -y @scope/server` for a server run as a command, else its URL. */
const mcpTarget = (spec: McpServerSpec): string => (spec.command === undefined ? (spec.url ?? "") : joinCommandLine([spec.command, ...(spec.args ?? [])]));

const mcpLabel = (info: McpServerInfo): string => (info.spec.name === undefined || info.spec.name === info.id ? info.id : `${info.id} (${info.spec.name})`);

const clock = (ms: number): string => {
  const date = new Date(ms);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
};

const mcpStatus = (info: McpServerInfo): string => (info.status === "auth" ? "needs sign-in" : info.status);

const hints = (tool: McpToolInfo): string =>
  [tool.hints.readOnly ? "read-only" : "", tool.hints.destructive ? "destructive" : "", tool.hints.openWorld ? "open-world" : ""].filter(Boolean).join(", ");

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Why a server lists no tools. */
const mcpNoTools = (info: McpServerInfo): string => {
  switch (info.status) {
    case "ready":
      return "No tools.";
    case "auth":
      return "No tools listed: it needs a sign-in.";
    case "error":
      return "No tools listed: it did not connect.";
    case "starting":
      return "No tools listed yet: it is connecting.";
    case "off":
      return "No tools listed: it is off.";
  }
};

/** One row per server: what it is called, how it is doing, how many of its tools are on, and where it is. */
export const formatMcpServers = (servers: readonly McpServerInfo[]): string =>
  servers.length === 0
    ? "No MCP servers. `lemma mcp add` adds one from its URL, its command, or a config."
    : pad([
        ["server", "status", "tools", "transport"],
        ...servers.map((info) => {
          const target = mcpTarget(info.spec).replace(/^https?:\/\//, "");
          return [
            mcpLabel(info),
            // An error's reason, cut to a short line; `show` has all of it.
            info.status === "error" ? `error: ${firstLine(info.error ?? "no reason given", 40)}` : mcpStatus(info),
            info.tools.length === 0 ? "-" : `${info.tools.filter((tool) => tool.enabled).length}/${info.tools.length}`,
            `${info.type} ${target.length > 50 ? `${target.slice(0, 49)}…` : target}`,
          ];
        }),
      ]);

/** Its tools, one row each: on or off, the server's name, title, and hints. */
const formatMcpTools = (tools: readonly McpToolInfo[]): string => {
  const rows = tools.map((tool) => [`  ${tool.enabled ? "on" : "off"}`, tool.name, tool.title ?? "", hints(tool)]);
  // A column no tool fills (no titles, no hints) is left out rather than shown as a gap.
  const used = rows[0]!.map((_, column) => rows.some((row) => row[column] !== ""));
  return [`Tools (${tools.filter((tool) => tool.enabled).length} of ${tools.length} on)`, pad(rows.map((row) => row.filter((_, column) => used[column])))].join(
    "\n",
  );
};

/** `MCP_HIDDEN` is a credential the host keeps to itself; anything else (a `${NAME}` included) is shown as written. */
const shown = (value: string): string => (value === MCP_HIDDEN ? "(hidden)" : value);

/** Rows with the label on the first only. */
const labelled = (label: string, values: readonly string[]): string[][] => values.map((value, index) => [index === 0 ? label : "", value]);

/** Everything about one server: its status, config, what it reported, what it lacks, and its tools. */
export const formatMcpServer = (info: McpServerInfo): string => {
  const spec = info.spec;
  const status = `${mcpStatus(info)} (since ${time(info.since)}${info.retryAt === undefined ? "" : `, trying again at ${clock(info.retryAt)}`})`;
  const rows: string[][] = [
    ["status", status],
    // Why it is in `error` or `auth`, which may run to several lines.
    ...labelled("reason", info.error?.trimEnd().split("\n") ?? []),
    ["transport", info.type],
  ];
  if (info.type === "stdio") {
    rows.push(["command", mcpTarget(spec)]);
    if (spec.cwd !== undefined) rows.push(["cwd", spec.cwd]);
    rows.push(
      ...labelled(
        "env",
        Object.entries(spec.env ?? {}).map(([key, value]) => `${key}=${shown(value)}`),
      ),
    );
  } else {
    rows.push(["url", spec.url ?? ""]);
    rows.push(
      ...labelled(
        "headers",
        Object.entries(spec.headers ?? {}).map(([key, value]) => `${key}: ${shown(value)}`),
      ),
    );
    if (info.signedIn !== undefined) rows.push(["sign-in", info.signedIn ? "signed in" : "not signed in"]);
    const oauth = spec.oauth;
    if (oauth !== undefined) {
      const parts = [
        oauth.clientId === undefined ? "" : `client ${oauth.clientId}`,
        oauth.clientSecret === undefined ? "" : `secret ${shown(oauth.clientSecret)}`,
        oauth.scopes === undefined ? "" : `scopes ${oauth.scopes.join(" ")}`,
        oauth.callbackPort === undefined ? "" : `callback port ${oauth.callbackPort}`,
      ].filter(Boolean);
      if (parts.length) rows.push(["oauth", parts.join(", ")]);
    }
  }
  rows.push(["secrets", info.secrets.length ? info.secrets.join(", ") : "none"]);
  if (spec.toolTimeoutMs !== undefined) rows.push(["tool timeout", seconds(spec.toolTimeoutMs)]);
  if (spec.startupTimeoutMs !== undefined) rows.push(["startup timeout", seconds(spec.startupTimeoutMs)]);
  rows.push(["saved in", `the ${info.scope} config`]);
  if (info.server !== undefined) {
    const server = info.server;
    rows.push([
      "server",
      `${server.title ?? server.name} ${server.version}${server.title === undefined || server.title === server.name ? "" : ` (${server.name})`}`,
    ]);
  }
  if (info.protocol !== undefined) rows.push(["protocol", info.protocol]);
  if (info.status === "ready")
    rows.push(["offers", `${plural(info.tools.length, "tool")}, ${plural(info.resources, "resource")}, ${plural(info.prompts, "prompt")}`]);
  // Tools turned off are listed with the rest once it connects; until then only the config knows them.
  if (info.tools.length === 0 && spec.disabledTools?.length) rows.push(["tools off", spec.disabledTools.join(", ")]);

  const lines = [mcpLabel(info), pad(rows.map(([label, value]) => [`  ${label}`, value!]))];
  if (info.status === "auth") lines.push(`Sign in with lemma mcp login ${info.id}.`);
  if (info.status === "error") lines.push(`lemma mcp logs ${info.id} shows what it printed.`);
  for (const name of info.missing) {
    lines.push(
      `warning: \${${name}} is not set: no secret of ${info.id}'s and nothing in the host's environment sets it (the web app's Settings → MCP servers stores one)`,
    );
  }
  if (info.instructions !== undefined && info.instructions.trim() !== "") lines.push("", "Instructions", indent(info.instructions.trim()));
  lines.push("", info.tools.length === 0 ? mcpNoTools(info) : formatMcpTools(info.tools));
  return lines.join("\n");
};

const logSource = (entry: McpLogEntry): string => (entry.source === "server" && entry.level !== undefined ? `server ${entry.level}` : entry.source);

/** Oldest first: when, from where, and what; a line's continuation lines sit under its text. */
export const formatMcpLogs = (entries: readonly McpLogEntry[]): string =>
  entries.length === 0
    ? "Nothing logged."
    : pad(
        entries.flatMap((entry) =>
          entry.text
            .trimEnd()
            .split("\n")
            .map((line, index) => (index === 0 ? [clock(entry.at), logSource(entry), line] : ["", "", line])),
        ),
      );
