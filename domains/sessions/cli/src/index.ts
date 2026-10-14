import { resolve } from "node:path";
import { Effect } from "effect";
import type { Context } from "effect";
import { definePlugin, Registries } from "@lemma/core";
import {
  branchOf,
  LEDGER_SORTS,
  ledger,
  parseLedgerFilter,
  promptDiff,
  rebuildRequest,
  recordStart,
  recordsBetween,
  recordSummary,
  SessionChannels,
  sortRecords,
  ThreadRoute,
  trajectory,
} from "@lemma/sessions";
import type { LedgerSort, SessionLogUpdate, TrajectoryStep, TrajectoryTurn } from "@lemma/sessions";
import { callHere, CliCommandError, CliCommands, defineCliCommand, followHere, usageError } from "@lemma/cli";
import { formatDiff, formatRecords, formatSession, formatSessions, formatStep, formatSystem, formatTools, formatTrajectory } from "./format.ts";

type Reader = Context.Service.Shape<typeof Registries>;

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

/** A step by request number, by `<turn>.<step>` (1-based), by step id, or the last step that sent a request. */
export const findStep = (turns: readonly TrajectoryTurn[], selector: string): { turn: TrajectoryTurn; step: TrajectoryStep } | undefined => {
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

const session = [{ name: "id", description: "A session's id (lemma sessions list)", required: true }] as const;

const readSession = (registries: Reader, sessionId: string) =>
  Effect.all([callHere(registries, SessionChannels.get, { sessionId }), callHere(registries, SessionChannels.events, { sessionId })], {
    concurrency: "unbounded",
  });

const mark = (registries: Reader, verb: "pin" | "unpin" | "archive" | "unarchive") =>
  defineCliCommand({
    path: ["sessions", verb],
    summary:
      verb === "pin"
        ? "Keep a session at the top of the web app's sidebar"
        : verb === "unpin"
          ? "Stop keeping a session at the top"
          : verb === "archive"
            ? "Hide a session from the sidebar (it stays on disk)"
            : "Bring an archived session back",
    args: session,
    run: ({ args }) =>
      Effect.map(
        callHere(registries, SessionChannels.mark, {
          sessionId: args.id,
          ...(verb === "pin" || verb === "unpin" ? { pinned: verb === "pin" } : { archived: verb === "archive" }),
        }),
        (info) => ({
          json: info,
          text: `${info.id}  ${{ pin: "pinned", unpin: "unpinned", archive: "archived", unarchive: "unarchived" }[verb]}`,
          ids: [info.id],
        }),
      ),
  });

/** The web app's view names a session's address takes after its id, as `ThreadRoute` does. */
const VIEWS = ["trajectory"];

export const sessionCommands = (registries: Reader) => [
  defineCliCommand({
    path: ["sessions", "list"],
    summary: "Sessions in a directory (default: here), most recently updated first; --all for every one",
    flags: {
      cwd: { type: "string", placeholder: "dir", description: "The directory (on the host's machine) whose sessions to list" },
      all: { type: "boolean", description: "Every session, wherever it is" },
      limit: { type: "number", short: "n", description: "At most this many" },
    },
    run: ({ cwd, flags }) =>
      Effect.gen(function* () {
        if (flags.all && flags.cwd !== undefined) return yield* usageError("Use either --all or --cwd");
        const dir = flags.all ? undefined : resolve(cwd, flags.cwd ?? ".");
        const all = yield* callHere(registries, SessionChannels.list, dir === undefined ? {} : { cwd: dir });
        const sessions = flags.limit === undefined ? all : all.slice(0, Math.max(0, flags.limit));
        return {
          json: sessions,
          text: sessions.length ? formatSessions(sessions, dir === undefined) : `No sessions${dir === undefined ? "" : ` in ${dir}`}.`,
          ids: sessions.map((info) => info.id),
        };
      }),
  }),
  defineCliCommand({
    path: ["sessions", "show"],
    summary: "A session's info and its current branch as a transcript",
    args: session,
    run: ({ args }) =>
      Effect.gen(function* () {
        const [info, events] = yield* readSession(registries, args.id);
        const branch = branchOf(events, info.leaf);
        return { json: { info, branch }, text: formatSession(info, branch) };
      }),
  }),
  defineCliCommand({
    path: ["sessions", "new"],
    summary: "Create a session in a directory (default: here); prints its id",
    flags: { cwd: { type: "string", placeholder: "dir", description: "Its directory, on the host's machine" } },
    run: ({ cwd, flags }) =>
      Effect.map(callHere(registries, SessionChannels.create, { cwd: resolve(cwd, flags.cwd ?? ".") }), (info) => ({
        json: info,
        text: info.id,
        ids: [info.id],
      })),
  }),
  defineCliCommand({
    path: ["sessions", "title"],
    summary: "Rename a session",
    args: [...session, { name: "title", description: "Its new title", required: true, variadic: true }],
    run: ({ args }) =>
      Effect.map(callHere(registries, SessionChannels.setTitle, { sessionId: args.id, title: args.title.join(" ").trim() }), (info) => ({
        json: info,
        text: `${info.id}  ${info.title ?? ""}`,
        ids: [info.id],
      })),
  }),
  mark(registries, "pin"),
  mark(registries, "unpin"),
  mark(registries, "archive"),
  mark(registries, "unarchive"),
  defineCliCommand({
    path: ["sessions", "delete"],
    summary: "Delete a session's log for good (refused while a turn runs in it)",
    args: session,
    run: ({ args }) =>
      Effect.as(callHere(registries, SessionChannels.delete, { sessionId: args.id }), {
        json: { id: args.id, deleted: true },
        text: `${args.id}  deleted`,
        ids: [args.id],
      }),
  }),
  defineCliCommand({
    path: ["sessions", "checkout"],
    summary: "Move a session's leaf to an event: the next prompt branches from there",
    args: [...session, { name: "event", description: "An event's id (lemma sessions show --json lists them)", required: true }],
    run: ({ args }) =>
      Effect.map(callHere(registries, SessionChannels.checkout, { sessionId: args.id, eventId: args.event }), (info) => ({
        json: info,
        text: `${info.id} now continues from ${args.event}; the next prompt starts a new branch there`,
      })),
  }),
  defineCliCommand({
    path: ["sessions", "open"],
    summary: "Open a session in the web app, in a view such as trajectory; prints its address",
    description: "With --json it prints the address's path and opens nothing.",
    args: [...session, { name: "view", description: `A view of it: ${VIEWS.join(", ")}` }],
    run: ({ args, json, out }) =>
      Effect.gen(function* () {
        yield* callHere(registries, SessionChannels.get, { sessionId: args.id });
        const path = ThreadRoute.href({ id: args.id, ...(args.view === undefined ? {} : { view: args.view }) });
        if (!json) out.open({ path });
        return { json: { path } };
      }),
  }),
  defineCliCommand({
    path: ["sessions", "inspect"],
    summary: "A session's turns and steps: model, history, usage, timing, tools; or its records, or one request in full",
    description:
      "As the web app's Trajectory view shows it. --records lists every record (prompt, system change, model call, tool run); --request shows one request: each system section and tool with the plugin that contributed it, then the response and tool runs.",
    args: session,
    flags: {
      records: { type: "boolean", description: "Every record as a table" },
      filter: {
        type: "string",
        placeholder: "query",
        description: "is:error, is:running, kind:model, tool:bash, turn:2, req:5, text, and -term to exclude (implies --records)",
      },
      sort: { type: "string", values: LEDGER_SORTS, description: "Sort the records by a column" },
      desc: { type: "boolean", description: "Sort descending" },
      range: {
        type: "string",
        placeholder: "from..to",
        description: "Only records active in that span, as offsets from the first (90s, 1m30s, 500ms; either side may be empty)",
      },
      request: { type: "string", placeholder: "r", description: 'One request: its number (5), <turn>.<step> (2.1), a step id, or "last"' },
      system: { type: "boolean", description: "With --request: only the system prompt, section by section" },
      tools: { type: "boolean", description: "With --request: only the tool definitions" },
      diff: { type: "boolean", description: "With --request: how its system prompt differs from the request before" },
      rebuilt: { type: "boolean", description: "With --request: the exact request sent to the model, as JSON" },
    },
    examples: ['lemma sessions inspect 01J… --filter "is:error tool:bash"', "lemma sessions inspect 01J… --request last --system"],
    run: ({ args, flags }) =>
      Effect.gen(function* () {
        const views = (["system", "tools", "diff", "rebuilt"] as const).filter((view) => flags[view]);
        if (views.length > 1) return yield* usageError(`Use one of ${views.map((view) => `--${view}`).join(", ")}`);
        const view = views[0];
        const selector = flags.request;
        const listing = flags.records || flags.filter !== undefined || flags.sort !== undefined || flags.range !== undefined;
        if (view !== undefined && selector === undefined) return yield* usageError(`--${view} needs --request`);
        if (selector !== undefined && listing) return yield* usageError("Use either --request or --records/--filter/--sort/--range");
        let range: { from: number | undefined; to: number | undefined } | undefined;
        if (flags.range !== undefined) {
          const [from, to, ...more] = flags.range.split("..");
          const start = from === undefined || from === "" ? undefined : parseOffset(from);
          const end = to === undefined || to === "" ? undefined : parseOffset(to);
          if (to === undefined || more.length > 0 || (from !== "" && start === undefined) || (to !== "" && end === undefined))
            return yield* usageError("--range looks like 30s..1m30s (either side may be empty)");
          range = { from: start, to: end };
        }
        const sessionId = args.id;
        const [info, events] = yield* readSession(registries, sessionId);
        const branch = branchOf(events, info.leaf);
        const turns = trajectory(branch);
        if (listing) {
          const running = turns.at(-1)?.end === undefined;
          let records = ledger(turns).filter(parseLedgerFilter(flags.filter ?? ""));
          if (range !== undefined && records.length > 0) {
            const origin = Math.min(...ledger(turns).map(recordStart));
            records = recordsBetween(records, origin + (range.from ?? 0), range.to === undefined ? Infinity : origin + range.to);
          }
          records = sortRecords(records, (flags.sort ?? "time") as LedgerSort, flags.desc, running);
          return { json: records.map((record) => recordSummary(record, running)), text: formatRecords(records, running) };
        }
        if (selector === undefined) return { json: { info, turns }, text: formatTrajectory(turns) };
        const found = findStep(turns, selector);
        if (found === undefined)
          return yield* new CliCommandError({
            reason: "NotFound",
            message: `No request "${selector}" on the current branch of ${sessionId}`,
            subject: selector,
          });
        const request = found.step.request;
        if (view !== undefined && request === undefined)
          return yield* new CliCommandError({
            reason: "NotFound",
            message: `Step ${found.turn.index}.${found.step.index} logged no request`,
            subject: selector,
          });
        switch (view) {
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
      }),
  }),
  defineCliCommand({
    path: ["sessions", "watch"],
    summary: "Follow what is appended to a session's log from now on, until stopped; NDJSON of its events with --json",
    args: session,
    run: ({ args, json, out }) =>
      Effect.gen(function* () {
        const sessionId = args.id;
        // From now: what it has already, `lemma sessions show` prints.
        let after = (yield* callHere(registries, SessionChannels.get, { sessionId })).lastSeq;
        const show = (update: SessionLogUpdate) => {
          const events = update.type === "appended" ? [update.event] : update.events;
          for (const event of events) {
            if (event.seq <= after) continue;
            after = event.seq;
            if (json) out.json(event);
            else
              out.line(
                `#${event.seq} ${event.data.type}${"turnId" in event.data && typeof event.data.turnId === "string" ? ` turn ${event.data.turnId}` : ""}`,
              );
          }
        };
        yield* followHere(
          registries,
          SessionChannels.log,
          () => ({ sessionId, after }),
          (update) => Effect.sync(() => show(update)),
        );
      }),
  }),
];

/**
 * The sessions' commands for the `lemma` command (`CliCommands`): `sessions
 * list|show|new|title|pin|unpin|archive|unarchive|delete|checkout|open|inspect|watch`.
 * It reaches the sessions through their channels, so it requires nothing.
 */
export default definePlugin({
  id: "sessions.cli",
  version: "0.1.0",
  setup: function* (_, owner) {
    const registries = yield* Registries;
    for (const command of sessionCommands(registries)) yield* owner.add(CliCommands, command);
  },
});
