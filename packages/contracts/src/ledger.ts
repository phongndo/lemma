import type { AssistantMessage, TextContent, ToolSpec, UserMessage } from "./llm.ts";
import type { Timing } from "./sessions.ts";
import type { TrajectoryRequest, TrajectoryStep, TrajectoryToolRun, TrajectoryTurn } from "./trajectory.ts";

/**
 * The Trajectory ledger: one flat, ordered list of records (the system prompt
 * when it is first sent or changes, each user prompt, each model call, each
 * tool run) projected from `trajectory(branch)`, plus the timeline spans they
 * occupy. Pure, so the view only renders.
 */

interface Base {
  /** Stable key: the event id behind the record. */
  readonly id: string;
  readonly turn: TrajectoryTurn;
  /** Starts a turn in the ledger (gets the turn label). */
  readonly turnStart: boolean;
}

export interface SystemRecord extends Base {
  readonly kind: "system";
  readonly request: TrajectoryRequest;
  readonly requestNumber: number;
  /** The previous request's section texts, for the diff; absent on the first request. */
  readonly previous?: ReadonlyMap<string, string>;
}
export interface UserRecord extends Base {
  readonly kind: "user";
  readonly message: UserMessage;
  readonly at: number;
}
export interface AssistantRecord extends Base {
  readonly kind: "assistant";
  readonly step: TrajectoryStep;
  /** 1-based over the session: every model call sent a request. */
  readonly requestNumber: number;
  readonly message: AssistantMessage;
  readonly timing?: Timing;
  /** A failed or cancelled call (an `attempt`), not part of the model's history. */
  readonly failed: boolean;
}
export interface ToolRecord extends Base {
  readonly kind: "tool";
  readonly step: TrajectoryStep;
  readonly run: TrajectoryToolRun;
  readonly spec?: ToolSpec;
}

export type LedgerRecord = SystemRecord | UserRecord | AssistantRecord | ToolRecord;
type Draft = LedgerRecord extends infer R ? (R extends LedgerRecord ? Omit<R, "turn" | "turnStart"> : never) : never;

export const contentText = (content: readonly { readonly type: string; readonly text?: string }[]): string =>
  content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("\n");

export function ledger(turns: readonly TrajectoryTurn[]): LedgerRecord[] {
  const records: LedgerRecord[] = [];
  let requestNumber = 0;
  let previous: Map<string, string> | undefined;
  for (const turn of turns) {
    let first = true;
    const push = (record: Draft) => {
      records.push({ ...record, turn, turnStart: first } as LedgerRecord);
      first = false;
    };
    if (turn.prompt !== undefined) {
      push({ kind: "user", id: `${turn.turnId}:prompt`, message: turn.prompt, at: turn.startedAt });
    }
    // Prompts the turn placed later, each after the step it followed.
    const steersAfter = (index: number) => {
      for (const steer of turn.steers) if (steer.after === index) push({ kind: "user", id: steer.eventId, message: steer.message, at: steer.at });
    };
    steersAfter(0);
    for (const step of turn.steps) {
      const request = step.request;
      if (request !== undefined) {
        requestNumber++;
        const changed = request.sections.some((section) => section.changed) || request.removed.length > 0;
        if (changed) {
          push({ kind: "system", id: `${request.eventId}:system`, request, requestNumber, ...(previous === undefined ? {} : { previous }) });
        }
        previous = new Map(request.sections.map((section) => [section.id, section.text ?? ""]));
      }
      const specs = new Map(request?.tools.flatMap((tool) => (tool.spec === undefined ? [] : [[tool.name, tool.spec] as const])) ?? []);
      for (const attempt of step.attempts) {
        push({ kind: "assistant", id: attempt.eventId, step, requestNumber, message: attempt.message, timing: attempt.timing, failed: true });
      }
      if (step.response !== undefined) {
        const response = step.response;
        push({
          kind: "assistant",
          id: response.eventId,
          step,
          requestNumber,
          message: response.message,
          failed: false,
          ...(response.timing === undefined ? {} : { timing: response.timing }),
        });
      }
      for (const run of step.tools) {
        const spec = specs.get(run.call.name);
        push({ kind: "tool", id: run.eventId ?? run.call.id, step, run, ...(spec === undefined ? {} : { spec }) });
      }
      steersAfter(step.index);
    }
  }
  return records;
}

/** The request behind a record, for the request inspector. */
export const recordRequest = (record: LedgerRecord): TrajectoryRequest | undefined =>
  record.kind === "system" ? record.request : record.kind === "user" ? undefined : record.step.request;

export type LedgerLane = 0 | 1 | 2;
export interface LedgerSpan {
  readonly record: LedgerRecord;
  readonly lane: LedgerLane;
  readonly start: number;
  /** Absent while the record is still running. */
  readonly end?: number;
  /** Time to first token, for model spans. */
  readonly ttft?: number;
  readonly error: boolean;
}

/** Where each record sits in time: lane 0 input, 1 model, 2 tools. System prompts have no duration and no span. */
export function ledgerSpans(records: readonly LedgerRecord[]): LedgerSpan[] {
  const out: LedgerSpan[] = [];
  for (const record of records) {
    if (record.kind === "user") out.push({ record, lane: 0, start: record.at, end: record.at, error: false });
    if (record.kind === "assistant") {
      const timing = record.timing;
      const start = timing?.startedAt ?? record.step.request?.at ?? record.step.startedAt;
      out.push({
        record,
        lane: 1,
        start,
        ...(timing === undefined ? {} : { end: timing.endedAt }),
        ...(timing?.firstTokenAt === undefined ? {} : { ttft: timing.firstTokenAt - timing.startedAt }),
        error: record.failed,
      });
    }
    if (record.kind === "tool" && record.run.timing !== undefined) {
      out.push({ record, lane: 2, start: record.run.timing.startedAt, end: record.run.timing.endedAt, error: record.run.result?.isError === true });
    }
  }
  return out;
}

/** Lines of `before` and `after` marked kept, removed, or added (longest common subsequence). */
export function lineDiff(before: string, after: string): { readonly kind: "same" | "del" | "add"; readonly text: string }[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const table: number[][] = Array.from({ length: a.length + 1 }, () => Array.from({ length: b.length + 1 }, () => 0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const out: { kind: "same" | "del" | "add"; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ kind: "same", text: a[i]! });
      i++;
      j++;
    } else if (i < a.length && (j >= b.length || table[i + 1]![j]! >= table[i]![j + 1]!)) {
      out.push({ kind: "del", text: a[i]! });
      i++;
    } else {
      out.push({ kind: "add", text: b[j]! });
      j++;
    }
  }
  return out;
}

/** Record text the search box matches against. */
const recordText = (record: LedgerRecord): string => {
  switch (record.kind) {
    case "system":
      return record.request.sections.map((section) => `${section.id} ${section.source} ${section.text ?? ""}`).join(" ");
    case "user":
      return contentText(record.message.content);
    case "assistant":
      return contentText(record.message.content as readonly { type: string; text?: string }[]) + (record.message.errorMessage ?? "");
    case "tool":
      return `${record.run.call.name} ${JSON.stringify(record.run.call.arguments)} ${record.run.result === undefined ? "" : contentText(record.run.result.content)}`;
  }
};

export const RECORD_KIND_LABEL = { system: "system", user: "user", assistant: "model", tool: "tool" } as const;

export const recordFailed = (record: LedgerRecord) =>
  (record.kind === "assistant" && record.failed) || (record.kind === "tool" && record.run.result?.isError === true);
export const recordDuration = (record: LedgerRecord): number | undefined => {
  if (record.kind === "assistant") return record.timing === undefined ? undefined : record.timing.endedAt - record.timing.startedAt;
  if (record.kind === "tool") return record.run.timing === undefined ? undefined : record.run.timing.endedAt - record.run.timing.startedAt;
  return undefined;
};
/**
 * The filter box, after DevTools': space-separated terms that must all hold.
 * `is:error`, `is:running`, `kind:tool` (user, model, tool, system),
 * `tool:bash`, `turn:2`, `req:5`, plain text, and `-term` to negate any of them.
 */
export const parseLedgerFilter = (input: string) => {
  const terms = input
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((raw) => {
      const negate = raw.startsWith("-") && raw.length > 1;
      const term = (negate ? raw.slice(1) : raw).toLowerCase();
      const [key, value] = term.includes(":") ? [term.slice(0, term.indexOf(":")), term.slice(term.indexOf(":") + 1)] : ["", term];
      const test = (record: LedgerRecord): boolean => {
        switch (key) {
          case "is":
            return value === "error"
              ? recordFailed(record)
              : value === "running"
                ? recordDuration(record) === undefined && (record.kind === "tool" || record.kind === "assistant")
                : false;
          case "kind":
          case "type":
            return RECORD_KIND_LABEL[record.kind].startsWith(value) || record.kind.startsWith(value);
          case "tool":
            return record.kind === "tool" && record.run.call.name.toLowerCase().includes(value);
          case "turn":
            return String(record.turn.index) === value;
          case "req":
            return (
              record.kind !== "user" &&
              String(record.kind === "system" ? record.requestNumber : record.kind === "assistant" ? record.requestNumber : "") === value
            );
          default:
            return recordText(record).toLowerCase().includes(term);
        }
      };
      return { negate, test };
    });
  return (record: LedgerRecord) => terms.every((term) => term.test(record) !== term.negate);
};

const firstLine = (text: string) =>
  text
    .trim()
    .split("\n")
    .find((line) => line.trim() !== "")
    ?.trim() ?? "";
const thinkingText = (message: AssistantMessage) => message.content.flatMap((part) => (part.type === "thinking" ? [part.thinking] : [])).join("\n\n");
const toolCallNames = (message: AssistantMessage) => message.content.flatMap((part) => (part.type === "toolCall" ? [part.name] : []));

/** When the record began: the prompt, the request, the model call, or the tool run. */
export const recordStart = (record: LedgerRecord): number => {
  switch (record.kind) {
    case "user":
      return record.at;
    case "system":
      return record.request.at;
    case "assistant":
      return record.timing?.startedAt ?? record.step.request?.at ?? record.step.startedAt;
    case "tool":
      return record.run.timing?.startedAt ?? record.step.startedAt;
  }
};

/** A one-word outcome; a tool with no result is `running` while its turn runs. */
export const recordStatus = (record: LedgerRecord, running = false): string => {
  switch (record.kind) {
    case "user":
      return "sent";
    case "system":
      return record.previous === undefined ? "initial" : "changed";
    case "assistant":
      return record.message.stopReason === "toolUse" && !record.failed ? "tool use" : record.message.stopReason;
    case "tool":
      return record.run.result === undefined ? (running ? "running" : "no result") : record.run.result.isError ? "error" : "ok";
  }
};

/** The record in one line: prompt or reply text, the error, the tool call, or what changed in the system prompt. */
export const recordName = (record: LedgerRecord): string => {
  switch (record.kind) {
    case "user":
      return firstLine(contentText(record.message.content)) || "[image]";
    case "system":
      return record.previous === undefined
        ? "initial system prompt"
        : `system prompt changed: ${[...record.request.sections.filter((s) => s.changed).map((s) => s.id), ...record.request.removed].join(", ")}`;
    case "assistant": {
      if (record.failed) return record.message.errorMessage ?? `model call ${record.message.stopReason}`;
      const text = firstLine(contentText(record.message.content));
      if (text) return text;
      const thinking = firstLine(thinkingText(record.message));
      if (thinking) return thinking;
      return toolCallNames(record.message).length ? `→ ${toolCallNames(record.message).join(", ")}` : "(no output)";
    }
    case "tool":
      return `${record.run.call.name} ${JSON.stringify(record.run.call.arguments)}`;
  }
};

/** A record as flat, serializable data (records themselves point at their whole turn): for `--json` and exports. */
export const recordSummary = (record: LedgerRecord, running = false) => {
  const base = {
    id: record.id,
    kind: record.kind,
    turn: record.turn.index,
    start: recordStart(record),
    status: recordStatus(record, running),
    name: recordName(record),
    error: recordFailed(record),
  };
  switch (record.kind) {
    case "user":
      return { ...base, text: contentText(record.message.content) };
    case "system":
      return {
        ...base,
        request: record.requestNumber,
        requestEvent: record.request.eventId,
        sections: record.request.sections.map((s) => ({ id: s.id, source: s.source, chars: s.chars, changed: s.changed })),
        removed: record.request.removed,
      };
    case "assistant":
      return {
        ...base,
        step: record.step.index,
        request: record.requestNumber,
        requestEvent: record.step.request?.eventId,
        model: `${record.message.provider}/${record.message.model}`,
        usage: record.message.usage,
        duration: recordDuration(record),
        ttft: record.timing?.firstTokenAt === undefined ? undefined : record.timing.firstTokenAt - record.timing.startedAt,
        text: contentText(record.message.content),
        toolCalls: toolCallNames(record.message),
        ...(record.message.errorMessage === undefined ? {} : { errorMessage: record.message.errorMessage }),
      };
    case "tool":
      return {
        ...base,
        step: record.step.index,
        tool: record.run.call.name,
        callId: record.run.call.id,
        arguments: record.run.call.arguments,
        duration: recordDuration(record),
        result: record.run.result === undefined ? undefined : contentText(record.run.result.content),
      };
  }
};

export interface SectionDiff {
  readonly id: string;
  readonly source: string;
  readonly status: "added" | "removed" | "changed";
  readonly lines: ReturnType<typeof lineDiff>;
}

/** How a request's system sections differ from an earlier request's (section texts compared by id). */
export function promptDiff(previous: TrajectoryRequest | undefined, current: TrajectoryRequest): SectionDiff[] {
  const before = new Map((previous?.sections ?? []).map((section) => [section.id, section]));
  const out: SectionDiff[] = [];
  for (const section of current.sections) {
    const old = before.get(section.id);
    before.delete(section.id);
    if (old !== undefined && (old.text ?? old.chars) === (section.text ?? section.chars)) continue;
    out.push({ id: section.id, source: section.source, status: old === undefined ? "added" : "changed", lines: lineDiff(old?.text ?? "", section.text ?? "") });
  }
  for (const old of before.values()) out.push({ id: old.id, source: old.source, status: "removed", lines: lineDiff(old.text ?? "", "") });
  return out;
}

export const LEDGER_SORTS = ["time", "name", "status", "type", "tokens", "duration"] as const;
export type LedgerSort = (typeof LEDGER_SORTS)[number];

/** Records ordered by a column, as the web table's header and `lemma inspect --sort` do; `time` is log order. */
export function sortRecords(records: readonly LedgerRecord[], key: LedgerSort, desc = false, running = false): LedgerRecord[] {
  if (key === "time") return desc ? [...records].reverse() : [...records];
  const value = (record: LedgerRecord): string | number => {
    switch (key) {
      case "name":
        return recordName(record).toLowerCase();
      case "status":
        return recordStatus(record, running);
      case "type":
        return RECORD_KIND_LABEL[record.kind];
      case "tokens":
        return record.kind === "assistant"
          ? record.message.usage.input + record.message.usage.cacheRead + record.message.usage.cacheWrite + record.message.usage.output
          : -1;
      case "duration":
        return recordDuration(record) ?? -1;
    }
  };
  return [...records].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    const order = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
    return desc ? -order : order;
  });
}

/** Whether a record was active at any moment in `[from, to]` (epoch ms): its span (from `ledgerSpans`) overlaps, or without one it started inside. */
export const recordWithin = (record: LedgerRecord, span: LedgerSpan | undefined, from: number, to: number, now = Date.now()): boolean => {
  if (span !== undefined) return (span.end ?? now) >= from && span.start <= to;
  const at = recordStart(record);
  return at >= from && at <= to;
};

/** The records active at any moment in `[from, to]` (`recordWithin`). */
export function recordsBetween(records: readonly LedgerRecord[], from: number, to: number, now = Date.now()): LedgerRecord[] {
  const spans = new Map(ledgerSpans(records).map((span) => [span.record.id, span]));
  return records.filter((record) => recordWithin(record, spans.get(record.id), from, to, now));
}
