import { Schema } from "effect";
import { CompositionChange, defineChannel, HostInfo, InspectorInfo, optionalPayload, PluginStatus, SpanRecord } from "@lemma/contracts";

/*
 * The devtools domain's host contract: the channels `devtools.trace` serves the host's trace on, and those
 * `devtools.host` serves the host's own state on. The dock and its panels are the web contract, `@lemma/devtools/web`.
 */

/** Which spans: those whose attributes have these values (`{ "session.id": … }`), ended after `since` (epoch ms). */
export const SpanQuery = Schema.Struct({
  where: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  since: Schema.optional(Schema.Number),
  /** At most this many, the newest (2000 when absent); a count, so a fraction rounds down and below zero is none. */
  limit: Schema.optional(Schema.Number),
});
export type SpanQuery = typeof SpanQuery.Type;

export const TraceChannels = {
  /** The spans the host kept that match, in the order they ended. */
  spans: defineChannel({
    kind: "call",
    id: "devtools.trace.spans",
    access: "read",
    title: "Spans",
    description: "The spans the host kept: what ran, for which plugin, and how long it took",
    payload: SpanQuery,
    success: Schema.Array(SpanRecord),
    repeatable: true,
  }),
  /** The spans that match as they end, in batches (a few a second at most). */
  follow: defineChannel({
    kind: "stream",
    id: "devtools.trace.follow",
    access: "read",
    title: "Follow spans",
    description: "Spans as they end, in batches",
    payload: Schema.Struct({ where: Schema.optional(Schema.Record(Schema.String, Schema.String)) }),
    success: Schema.Array(SpanRecord),
  }),
  /** The host composition's recent changes, newest first. */
  changes: defineChannel({
    kind: "call",
    id: "devtools.trace.changes",
    access: "read",
    title: "Composition changes",
    description: "What each recent reload, configure, and restart started, stopped, and restarted, or why it was refused",
    payload: Schema.Void,
    success: Schema.Array(CompositionChange),
    repeatable: true,
  }),
} as const;

/** The host as `devtools.host.info` tells it: `HostInfo` but its version, which only its transport knows. */
const { version: _version, ...hostFields } = HostInfo.fields;
export const HostState = Schema.Struct(hostFields);
export type HostState = typeof HostState.Type;

/**
 * The host's own state, as the runtime's calls give it to the web app and the `lemma` command (`Host.Info`,
 * `Host.Plugins`, `Host.Inspectors`, `Host.Inspect`), served as channels so that whatever reaches channels, an agent's
 * script among them, reads it too. Each only reads.
 */
export const HostChannels = {
  info: defineChannel({
    kind: "call",
    id: "devtools.host.info",
    access: "read",
    title: "Host",
    description: "This host: where it runs, what it provides itself, its process, and the plugin set it runs, whose id each logged request names",
    payload: Schema.Void,
    success: HostState,
    repeatable: true,
  }),
  /**
   * Every plugin the host knows, on or off, as `lemma plugins` lists them; those `ids` names, when given. A plugin's
   * config is as its settings form shows it: no secret's value, only which secrets are set; and a secret query
   * parameter in any of its text (a `baseUrl` with `?key=`) is hidden (`redactTexts`).
   */
  plugins: defineChannel({
    kind: "call",
    id: "devtools.host.plugins",
    access: "read",
    title: "Plugins",
    description:
      "Every plugin the host knows, on or off, or those ids names: where it comes from, its state, faults, and what halts it, what it provides and requires, its config (no secrets) and its fields, the file that sets each, and what it hooks, observes, and contributes",
    payload: optionalPayload({ ids: Schema.optional(Schema.Array(Schema.String)) }),
    success: Schema.Array(PluginStatus),
    repeatable: true,
  }),
  inspectors: defineChannel({
    kind: "call",
    id: "devtools.host.inspectors",
    access: "read",
    title: "Inspectors",
    description: "What running plugins let you look into (their tools, running turns, commands), each by the plugin that adds it",
    payload: Schema.Void,
    success: Schema.Array(InspectorInfo),
    repeatable: true,
  }),
  /**
   * One inspector's snapshot, as `lemma inspectors <id>` shows it: plain JSON, `null` for none, with its secrets hidden
   * (`redactJson`). Fails `NotFound`, or `Failed` when the inspector does.
   */
  inspect: defineChannel({
    kind: "call",
    id: "devtools.host.inspect",
    access: "read",
    title: "Inspect",
    description: "What one inspector (devtools.host.inspectors) shows now, as JSON, its secrets hidden",
    payload: Schema.Struct({ id: Schema.String }),
    success: Schema.Unknown,
    repeatable: true,
  }),
} as const;

/** A field or attribute whose value is a secret by its name: a credential, a cookie, a token (not a count of tokens). */
export const SECRET_KEY = /authorization|cookie|token(?![a-z])|secret|password|api[-_.]?key/i;
/** A secret in text: a query parameter that carries one, in a URL (`?token=…`) or a query on its own (`token=…`). */
const SECRET_PARAM = /((?:^|[?&])(?:token|key|secret|password|access_token|api[-_]?key|code)=)[^&#\s]+/gi;

/** `text` with the value of each secret query parameter in it hidden. */
export const redactText = (text: string): string => text.replace(SECRET_PARAM, "$1<redacted>");

/** `value`, JSON, with each secret query parameter in its text hidden (`redactText`), as a plugin's config can hold one. */
export const redactTexts = (value: unknown): unknown => hide(value, false);

/**
 * `value`, JSON, with its secrets hidden: each field named for one (`SECRET_KEY`), whatever it holds, and each secret
 * query parameter in its text (`redactText`). What a host's state shows of a URL a session opened can hold one.
 */
export const redactJson = (value: unknown): unknown => hide(value, true);

const hide = (value: unknown, byKey: boolean): unknown => {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((item) => hide(item, byKey));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, field]) => [key, byKey && SECRET_KEY.test(key) && field !== null ? "<redacted>" : hide(field, byKey)]),
  );
};

/** How many spans a query answers with when it names no limit. */
export const SPANS_ANSWERED = 2000;

/** The spans of `spans` that `query` asks for, in their order: those that match, ended after `since`, the newest `limit`. */
export const selectSpans = (spans: readonly SpanRecord[], { where, since, limit }: SpanQuery): readonly SpanRecord[] => {
  const found = spans.filter((span) => (since === undefined || span.start + span.ms > since) && matches(span, where));
  const count = limit === undefined || Number.isNaN(limit) ? SPANS_ANSWERED : Math.max(0, Math.floor(limit));
  return found.slice(Math.max(0, found.length - count));
};

/** Whether `span` has every attribute `where` names, with its value (a span without one has no value, not `"undefined"`). */
export const matches = (span: SpanRecord, where: Readonly<Record<string, string>> | undefined): boolean =>
  where === undefined || Object.entries(where).every(([key, value]) => Object.hasOwn(span.attributes, key) && String(span.attributes[key]) === value);
export { DEVTOOLS_CONTRACT } from "./version.ts";
