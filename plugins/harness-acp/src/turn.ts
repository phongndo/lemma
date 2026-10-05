import * as acp from "@agentclientprotocol/sdk";
import { Effect, Exit, Fiber, Queue, Runtime } from "effect";
import type { Context } from "effect";
import type { Events } from "@lemma/core";
import { AgentError, deriveMessages, InteractionOrigin, transcript } from "@lemma/contracts";
import type { HarnessTurn, Interaction, SessionEvent, Sessions, TurnReason } from "@lemma/contracts";
import { recordTurn } from "@lemma/plugin-harnesses";
import type { Ended, Producer, TurnRecorder } from "@lemma/plugin-harnesses";
import type { AgentSpec } from "./config.ts";
import type { Connection, SessionHandler } from "./connection.ts";
import { callOf, mergeCall, promptBlocks, resultOf, usageOf } from "./content.ts";
import type { CallState } from "./content.ts";

/** The `custom` event each turn logs first: which ACP session of which agent ran it, so the next turn can continue it. */
export const TURN_KIND = "acp.turn";

/** How long a cancelled prompt gets to wind down in the agent before the turn closes without it. */
const CANCEL_GRACE = "3 seconds";

export interface TurnDeps {
  readonly spec: AgentSpec;
  readonly title: string;
  readonly sessions: Context.Tag.Service<typeof Sessions>;
  readonly events: Context.Tag.Service<typeof Events>;
  readonly interaction: Context.Tag.Service<typeof Interaction>;
  /** The agent's connection, started (or restarted) when needed; `NoHarness` when it cannot start. */
  readonly connection: (sessionId: string) => Effect.Effect<Connection, AgentError>;
}

interface TurnMarker {
  readonly agent: string;
  readonly session: string;
  readonly turnId: string;
}

const markerOf = (event: SessionEvent): TurnMarker | undefined => {
  const data = event.data;
  if (data.type !== "custom" || data.kind !== TURN_KIND) return undefined;
  const marker = data.data as Partial<TurnMarker> | null;
  return typeof marker?.agent === "string" && typeof marker.session === "string" && typeof marker.turnId === "string" ? (marker as TurnMarker) : undefined;
};

/** The ACP session a turn runs in, and the conversation it must be told first when it has not seen it. */
interface Plan {
  readonly session: string;
  readonly handoff?: string;
  readonly model?: string;
}

const failed = (sessionId: string, message: string, cause?: unknown) =>
  new AgentError({ sessionId, reason: "NoHarness", message, ...(cause === undefined ? {} : { cause }) });

const errorText = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "object" && cause !== null && "message" in cause) {
    const data = "data" in cause && cause.data !== undefined ? ` (${JSON.stringify(cause.data)})` : "";
    return `${String(cause.message)}${data}`;
  }
  return String(cause);
};

const modelOf = (options: readonly acp.SessionConfigOption[] | null | undefined): string | undefined => {
  const option = options?.find((candidate) => candidate.category === "model" && candidate.type === "select");
  return option !== undefined && "currentValue" in option && typeof option.currentValue === "string" ? option.currentValue : undefined;
};

const describe = (request: acp.RequestPermissionRequest): string | undefined => {
  const call = request.toolCall;
  const lines = [
    ...(call.locations ?? []).map((location) => location.path),
    ...(call.rawInput === undefined ? [] : [typeof call.rawInput === "string" ? call.rawInput : JSON.stringify(call.rawInput, null, 2)]),
  ];
  const text = lines.join("\n");
  return text === "" ? undefined : text.length > 4_000 ? `${text.slice(0, 4_000)}…` : text;
};

const KIND_LABEL: Readonly<Record<acp.PermissionOptionKind, string>> = {
  allow_once: "Allow this time",
  allow_always: "Allow from now on",
  reject_once: "Refuse this time",
  reject_always: "Refuse from now on",
};

const ENDED: Readonly<Record<acp.StopReason, Ended>> = {
  end_turn: { reason: "done" },
  max_turn_requests: { reason: "max-steps" },
  max_tokens: { reason: "error", error: "The model reached its output limit" },
  refusal: { reason: "error", error: "The model refused to continue" },
  cancelled: { reason: "cancelled" },
};

type Item =
  | { readonly type: "update"; readonly update: acp.SessionUpdate }
  | { readonly type: "stop"; readonly response: acp.PromptResponse }
  | { readonly type: "failed"; readonly error: unknown };

/**
 * Runs Lemma turns on an ACP agent. A session keeps one ACP session while
 * its turns run there in order: the next turn continues it (in the same
 * process, or by `session/resume` or `session/load` after a restart). When it
 * cannot (the agent is new to the session, the session was checked out to an
 * earlier point, or another harness ran the turns since), a new ACP session
 * starts and is handed the conversation so far as text.
 */
export function runAcpTurn(deps: TurnDeps, turn: HarnessTurn): Effect.Effect<TurnReason, AgentError> {
  const { spec, title, sessions, events, interaction } = deps;
  const producer: Producer = { harness: spec.id, api: "acp", provider: spec.id, model: "default", title };

  /** Which ACP session the turn runs in: the one the branch's last turn ran in when that is still its latest, else a new one. */
  const plan = (connection: Connection) =>
    Effect.gen(function* () {
      const sessionError = (error: { readonly message: string }) => failed(turn.sessionId, error.message, error);
      const log = yield* sessions.events(turn.sessionId).pipe(Effect.mapError(sessionError));
      const branch = yield* sessions.branch(turn.sessionId).pipe(Effect.mapError(sessionError));
      let lastTurn: string | undefined;
      for (const event of branch) if (event.data.type === "turn-start") lastTurn = event.data.turnId;
      const marker = branch.map(markerOf).find((found) => found !== undefined && found.turnId === lastTurn && found.agent === spec.id);
      // A later turn in the same ACP session on another branch: that session has moved past this branch.
      const latest =
        marker === undefined
          ? undefined
          : log
              .map(markerOf)
              .filter((found) => found?.session === marker.session)
              .at(-1);
      const capabilities = connection.initialized.agentCapabilities;
      if (marker !== undefined && latest?.turnId === marker.turnId) {
        if (connection.sessions.has(marker.session)) return { session: marker.session } satisfies Plan;
        const request = { sessionId: marker.session, cwd: turn.cwd, mcpServers: [] };
        // `session/load` replays the conversation as updates; no turn listens yet, so they are dropped.
        const reopen = (): Promise<acp.ResumeSessionResponse | acp.LoadSessionResponse> | undefined =>
          capabilities?.sessionCapabilities?.resume
            ? connection.agent.request(acp.methods.agent.session.resume, request)
            : capabilities?.loadSession
              ? connection.agent.request(acp.methods.agent.session.load, request)
              : undefined;
        const reopened = yield* Effect.either(Effect.tryPromise(() => reopen() ?? Promise.reject(new Error("cannot reopen"))));
        if (reopened._tag === "Right") {
          connection.sessions.set(marker.session, marker.turnId);
          const model = modelOf(reopened.right.configOptions);
          return { session: marker.session, ...(model === undefined ? {} : { model }) } satisfies Plan;
        }
      }
      const created = yield* Effect.tryPromise({
        try: () => connection.agent.request(acp.methods.agent.session.new, { cwd: turn.cwd, mcpServers: [] }),
        catch: (cause) => failed(turn.sessionId, `${title} could not start a session: ${errorText(cause)}`, cause),
      });
      connection.sessions.set(created.sessionId, turn.turnId);
      const history = deriveMessages(branch);
      const model = modelOf(created.configOptions);
      return {
        session: created.sessionId,
        ...(history.length === 0 ? {} : { handoff: transcript(history) }),
        ...(model === undefined ? {} : { model }),
      } satisfies Plan;
    });

  const prompt = (connection: Connection, chosen: Plan, rec: TurnRecorder) =>
    Effect.gen(function* () {
      const { session } = chosen;
      yield* rec.custom(TURN_KIND, {
        agent: spec.id,
        session,
        turnId: turn.turnId,
        ...(chosen.handoff === undefined ? {} : { handoffChars: chosen.handoff.length }),
      } satisfies TurnMarker & { readonly handoffChars?: number });
      if (chosen.model !== undefined) yield* rec.model(chosen.model);
      connection.sessions.set(session, turn.turnId);

      const runtime = yield* Effect.runtime<never>();
      const items = yield* Queue.unbounded<Item>();
      const asking = new Set<Fiber.RuntimeFiber<acp.RequestPermissionResponse>>();
      const calls = new Map<string, CallState>();

      const permission = (request: acp.RequestPermissionRequest): Effect.Effect<acp.RequestPermissionResponse> => {
        const refuse = request.options.find((option) => option.kind === "reject_once") ?? request.options.find((option) => option.kind === "reject_always");
        return interaction
          .select(
            `${title} wants to ${request.toolCall.title ?? "use a tool"}`,
            request.options.map((option) => ({ value: option.optionId, label: option.name, description: KIND_LABEL[option.kind] })),
            describe(request),
          )
          .pipe(
            Effect.map((optionId): acp.RequestPermissionResponse => ({ outcome: { outcome: "selected", optionId } })),
            // Nobody to ask, or the question dismissed: the agent is told no, and goes on without it.
            Effect.catchAll(() =>
              Effect.succeed<acp.RequestPermissionResponse>(
                refuse === undefined ? { outcome: { outcome: "cancelled" } } : { outcome: { outcome: "selected", optionId: refuse.optionId } },
              ),
            ),
            Effect.locally(InteractionOrigin, `session:${turn.sessionId}`),
          );
      };

      const handler: SessionHandler = {
        update: (update) => Queue.unsafeOffer(items, { type: "update", update }),
        permission: (request) =>
          new Promise((resolve) => {
            const fiber = Runtime.runFork(runtime)(permission(request));
            asking.add(fiber);
            fiber.addObserver((exit) => {
              asking.delete(fiber);
              resolve(Exit.isSuccess(exit) ? exit.value : { outcome: { outcome: "cancelled" } });
            });
          }),
      };

      const apply = (update: acp.SessionUpdate): Effect.Effect<void, AgentError> => {
        switch (update.sessionUpdate) {
          case "agent_message_chunk":
            return update.content.type === "text" ? rec.text(update.content.text) : Effect.void;
          case "agent_thought_chunk":
            return update.content.type === "text" ? rec.thinking(update.content.text) : Effect.void;
          case "tool_call":
          case "tool_call_update": {
            const state = mergeCall(calls.get(update.toolCallId), update);
            calls.set(update.toolCallId, state);
            const done = state.status === "completed" || state.status === "failed";
            return Effect.zipRight(rec.toolCall({ id: state.id, ...callOf(state) }), done ? rec.toolResult(state.id, resultOf(state)) : Effect.void);
          }
          case "usage_update": {
            // A running total for the session: the turn's share is what it grew by.
            const cost = update.cost;
            if (cost === undefined || cost === null || cost.currency.toUpperCase() !== "USD") return Effect.void;
            const before = connection.costs.get(session);
            connection.costs.set(session, cost.amount);
            return before === undefined || cost.amount <= before ? Effect.void : rec.usage(usageOf(undefined, cost.amount - before));
          }
          default:
            return Effect.void;
        }
      };

      const content = [
        ...(chosen.handoff === undefined
          ? []
          : [
              {
                type: "text" as const,
                text: `This conversation began before you joined it. Here it is so far, as text:\n\n<conversation>\n${chosen.handoff}\n</conversation>\n\nThe user's new message follows.`,
              },
            ]),
        ...turn.prompts.flatMap((placed, index) => [
          ...(index === 0 ? [] : [{ type: "text" as const, text: "\n\n" }]),
          ...promptBlocks(placed.content, connection.initialized.agentCapabilities?.promptCapabilities?.image === true),
        ]),
      ];

      const sent = Effect.sync(() => {
        connection.handlers.set(session, handler);
        connection.agent.request(acp.methods.agent.session.prompt, { sessionId: session, prompt: content }).then(
          (response) => Queue.unsafeOffer(items, { type: "stop", response }),
          (error: unknown) => Queue.unsafeOffer(items, { type: "failed", error }),
        );
      });

      /** Updates in order until the prompt's response: how the turn ends. */
      const drain: Effect.Effect<Ended, AgentError> = Effect.gen(function* () {
        for (;;) {
          const item = yield* Queue.take(items);
          if (item.type === "update") {
            yield* apply(item.update);
            continue;
          }
          if (item.type === "failed") {
            const reason = connection.ended() ?? `${title} failed: ${errorText(item.error)}`;
            return { reason: "error", error: reason } satisfies Ended;
          }
          yield* rec.usage(usageOf(item.response.usage));
          return ENDED[item.response.stopReason] ?? { reason: "done" };
        }
      });

      /** Asks the agent to stop, answers its open questions as cancelled, and gives it a moment to wind down. */
      const cancel = Effect.gen(function* () {
        yield* Effect.promise(() => connection.agent.notify(acp.methods.agent.session.cancel, { sessionId: session }).catch(() => undefined));
        yield* Fiber.interruptAll([...asking]);
        const settled = Effect.gen(function* () {
          for (;;) if ((yield* Queue.take(items)).type !== "update") return;
        });
        yield* settled.pipe(Effect.timeout(CANCEL_GRACE), Effect.ignore);
      });

      return yield* Effect.zipRight(sent, drain).pipe(
        Effect.onInterrupt(() => cancel),
        Effect.ensuring(
          Effect.sync(() => {
            if (connection.handlers.get(session) === handler) connection.handlers.delete(session);
          }),
        ),
      );
    });

  return Effect.gen(function* () {
    // Cut off by a restart: the agent's prompt died with the process, so the record closes it.
    if (turn.resume !== undefined) return yield* recordTurn({ sessions, events }, turn, producer, () => Effect.dieMessage("not continued"));
    const connection = yield* deps.connection(turn.sessionId);
    const chosen = yield* plan(connection);
    return yield* recordTurn({ sessions, events }, turn, producer, (rec) => prompt(connection, chosen, rec));
  });
}
