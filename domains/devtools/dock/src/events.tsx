import { createEffect, createSignal, on } from "solid-js";
import type { Accessor } from "solid-js";
import type { ConnectionStatus } from "@lemma/client";
import { AgentChannels } from "@lemma/agent";
import { CommandChannels } from "@lemma/commands";
import { LlmChannels } from "@lemma/llm";
import { SessionChannels } from "@lemma/sessions";
import type { RuntimeEvent } from "@lemma/contracts";
import type { AgentActivity } from "@lemma/agent";
import type { CommandInfo } from "@lemma/commands";
import type { LlmChange } from "@lemma/llm";
import type { SessionsChange } from "@lemma/sessions";
import type { ClientService, RouterService, SlotItem } from "@lemma/web";
import type { DevtoolsPanel } from "@lemma/devtools/web";
import { viewOf } from "./lazy.ts";

export const EVENTS_PANEL = "devtools.events";
/** Lines kept, newest last; older ones drop off the top. */
const LIMIT = 1000;
/** The host's own event stream, beside the domains' streams. */
export const HOST_EVENTS = "Host.Events";

/** What a line heard: one of the host's own events, or an element of a domain's stream. */
type Heard =
  | { readonly stream: typeof HOST_EVENTS; readonly event: RuntimeEvent }
  | { readonly stream: "sessions.changes"; readonly event: SessionsChange }
  | { readonly stream: "agent.activity"; readonly event: AgentActivity }
  | { readonly stream: "llm.changes"; readonly event: LlmChange }
  | { readonly stream: "commands.changes"; readonly event: readonly CommandInfo[] };

/** A line of the log: what a stream sent, a stream ending, or a change in the connection carrying them. */
export type Line =
  | ({ readonly seq: number; readonly at: number; readonly kind: "event"; readonly bytes: number } & Heard)
  | { readonly seq: number; readonly at: number; readonly kind: "end"; readonly stream: string; readonly error?: string }
  | { readonly seq: number; readonly at: number; readonly kind: "conn"; readonly status: ConnectionStatus };

/** Follows the domains' streams, each element heard and each ending told; returns the stops. */
const followStreams = (client: ClientService, hear: (heard: Heard) => void, ended: (stream: string, error?: Error) => void): (() => void)[] => [
  client.follow(
    SessionChannels.changes,
    undefined,
    (event) => hear({ stream: "sessions.changes", event }),
    (error) => ended(SessionChannels.changes.id, error),
  ),
  client.follow(
    AgentChannels.activity,
    undefined,
    (event) => hear({ stream: "agent.activity", event }),
    (error) => ended(AgentChannels.activity.id, error),
  ),
  client.follow(
    LlmChannels.changes,
    undefined,
    (event) => hear({ stream: "llm.changes", event }),
    (error) => ended(LlmChannels.changes.id, error),
  ),
  client.follow(
    CommandChannels.changes,
    undefined,
    (event) => hear({ stream: "commands.changes", event }),
    (error) => ended(CommandChannels.changes.id, error),
  ),
];

export const streamOf = (line: Line): string => (line.kind === "conn" ? "connection" : line.stream);

/** What a line is about, for its colour. */
export const category = (line: Line): string => {
  if (line.kind !== "event") return "conn";
  if (line.stream === "commands.changes") return "host";
  const event = line.event;
  if (event.type === "notice") return `notice-${event.notice.level}`;
  if (event.type === "delta" || event.type === "tool-output") return "delta";
  if (event.type.startsWith("session")) return "session";
  if (event.type.startsWith("turn") || event.type === "queue-changed") return "turn";
  if (event.type.startsWith("interaction")) return "interaction";
  return "host";
};

export const typeOf = (line: Line): string => {
  if (line.kind === "conn") return line.status.state;
  if (line.kind === "end") return "ended";
  return line.stream === "commands.changes" ? "commands" : line.event.type;
};

export const sessionOf = (line: Line): string | undefined => {
  if (line.kind !== "event" || line.stream === "commands.changes") return undefined;
  const event = line.event;
  if ("sessionId" in event) return event.sessionId;
  if (event.type === "session-changed") return event.info.id;
  return undefined;
};

/** The line's message. */
export const describe = (line: Line): string => {
  if (line.kind === "conn") {
    const { generation, attempts, error } = line.status;
    return `generation ${generation}${attempts > 0 ? ` · attempt ${attempts}` : ""}${error === undefined ? "" : ` · ${error}`}`;
  }
  if (line.kind === "end") return line.error ?? "finished";
  if (line.stream === "commands.changes") return line.event.map((command) => command.id).join(" ") || "none";
  const event = line.event;
  switch (event.type) {
    case "subscribed":
      return "running" in event ? `running: ${event.running.join(" ") || "none"}` : "from here on it hears every change";
    case "notice":
      return `${event.notice.level}${event.notice.source === undefined ? "" : ` ${event.notice.source}:`} ${event.notice.message}`;
    case "delta":
      return `${event.event.type}${event.event.type === "text-delta" ? ` ${JSON.stringify(event.event.delta)}` : ""} · turn ${event.turnId} step ${event.stepId}`;
    case "tool-output":
      return `${JSON.stringify(event.chunk.length > 80 ? `${event.chunk.slice(0, 80)}…` : event.chunk)} · call ${event.toolCallId}`;
    case "session-removed":
      return "deleted";
    case "session-changed":
      return `lastSeq ${event.info.lastSeq}${event.info.title === undefined ? "" : ` "${event.info.title}"`}`;
    case "turn-started":
      return `turn ${event.turnId}`;
    case "queue-changed":
      return event.queue.length === 0 ? "empty" : event.queue.map((queued) => `${queued.mode} ${queued.requestId}`).join(" · ");
    case "turn-ended":
      return `turn ${event.turnId} ${event.reason} · ↑${event.usage.input} ↓${event.usage.output}`;
    case "models-changed":
      return "list them again";
    case "interaction":
      return `${event.request.id} ${event.request.type}: ${event.request.title}`;
    case "interaction-closed":
      return event.id;
    case "plugins-changed":
      return event.plugins.map((plugin) => `${plugin.id}=${plugin.state}`).join(" ");
    case "channels-changed":
      return event.channels.map((channel) => `${channel.id} (${channel.source})`).join(" ") || "none";
    case "web-changed":
      return `${Object.keys(event.web.plugins).length} rows · files ${event.web.files.map((file) => file.name).join(" ") || "none"}`;
  }
};

const EventLog = viewOf("EventLog");

/**
 * Records what the host sends this page from now until `onCleanup` runs, for
 * the Host events panel: its own events and the connection always, and the
 * domains' streams while `following` (the devtools are open), since
 * following them costs a subscription of the page's own, the agent's output
 * included.
 */
export function hostEventsPanel(
  client: ClientService,
  router: RouterService,
  following: Accessor<boolean>,
  onCleanup: (fn: () => void) => void,
): SlotItem<DevtoolsPanel> {
  const [lines, setLines] = createSignal<readonly Line[]>([]);
  let seq = 0;
  const push = (line: Line) => setLines((current) => [...(current.length >= LIMIT ? current.slice(current.length - LIMIT + 1) : current), line]);
  const hear = (heard: Heard) => push({ seq: ++seq, at: Date.now(), kind: "event", bytes: JSON.stringify(heard.event).length, ...heard });
  onCleanup(client.onEvent((event) => hear({ stream: HOST_EVENTS, event })));
  let streams: (() => void)[] = [];
  createEffect(
    on(following, (now) => {
      for (const stop of streams) stop();
      streams = now
        ? followStreams(client, hear, (stream, error) =>
            push({ seq: ++seq, at: Date.now(), kind: "end", stream, ...(error === undefined ? {} : { error: error.message }) }),
          )
        : [];
    }),
  );
  onCleanup(() => {
    for (const stop of streams) stop();
  });
  // One line per change of state or generation, not per retry countdown.
  createEffect(
    on(
      () => `${client.status().state}:${client.status().generation}`,
      () => push({ seq: ++seq, at: Date.now(), kind: "conn", status: client.status() }),
    ),
  );
  return {
    id: EVENTS_PANEL,
    order: 15,
    title: "Host events",
    component: () => <EventLog client={client} router={router} lines={lines} clear={() => setLines([])} />,
    snapshot: () => lines().map((line) => ({ at: line.at, stream: streamOf(line), type: typeOf(line), session: sessionOf(line), message: describe(line) })),
  };
}
