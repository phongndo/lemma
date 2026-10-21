import { Effect } from "effect";
import type { Context } from "effect";
import { definePlugin, Events, Registries } from "@lemma/core";
import { AgentChannels } from "@lemma/agent";
import type { QueuedPrompt } from "@lemma/agent";
import { contentText } from "@lemma/llm";
import { SessionChannels } from "@lemma/sessions";
import { callHere, CliCommandError, CliCommands, defineCliCommand, followHere, table } from "@lemma/cli";
import { runCommand } from "./run.ts";

type Reader = Context.Service.Shape<typeof Registries>;

const session = [{ name: "session", description: "A session's id (lemma sessions list)", required: true }] as const;

/** Prompts waiting for a turn: mode, request id, age, and their text on one line. */
export const formatQueue = (queue: readonly QueuedPrompt[]): string =>
  queue.length === 0
    ? "Nothing queued."
    : table([
        ["mode", "request", "queued", "prompt"],
        ...queue.map((queued) => [
          queued.mode,
          queued.requestId,
          new Date(queued.at).toISOString(),
          contentText(queued.content).replace(/\s+/g, " ").trim().slice(0, 100),
        ]),
      ]);

/** The agent's commands: run a prompt, and see and steer what is running and queued. */
export const agentCommands = (registries: Reader, events: Context.Service.Shape<typeof Events>) => [
  runCommand(registries, events),
  defineCliCommand({
    path: ["agent", "cancel"],
    summary: "Cancel the session's running turn, and answer once it has ended",
    args: session,
    run: ({ args }) =>
      Effect.as(callHere(registries, AgentChannels.cancel, { sessionId: args.session }), {
        json: { cancelled: args.session },
        text: `cancelled any running turn in ${args.session}`,
      }),
  }),
  defineCliCommand({
    path: ["agent", "running"],
    summary: "The sessions with a turn running",
    run: () =>
      Effect.map(callHere(registries, AgentChannels.running, undefined), (running) => ({
        json: running,
        text: running.length === 0 ? "No turn runs." : running.join("\n"),
        ids: running,
      })),
  }),
  defineCliCommand({
    path: ["agent", "queue"],
    summary: "Prompts waiting for a turn in a session: mode, request id, and text",
    args: session,
    run: ({ args }) =>
      Effect.gen(function* () {
        yield* callHere(registries, SessionChannels.get, { sessionId: args.session });
        const queue = yield* callHere(registries, AgentChannels.queue, { sessionId: args.session });
        return { json: queue, text: formatQueue(queue), ids: queue.map((queued) => queued.requestId) };
      }),
  }),
  defineCliCommand({
    path: ["agent", "withdraw"],
    summary: "Take a prompt out of a session's queue",
    args: [...session, { name: "request", description: "Its request id (lemma agent queue)", required: true }],
    run: ({ args }) =>
      Effect.gen(function* () {
        if (!(yield* callHere(registries, AgentChannels.withdraw, { sessionId: args.session, requestId: args.request })))
          return yield* new CliCommandError({
            reason: "NotFound",
            message: `No queued prompt ${args.request} in ${args.session}: a turn may have placed it already`,
            subject: args.request,
          });
        return { json: { withdrawn: args.request }, text: `withdrew ${args.request}` };
      }),
  }),
  defineCliCommand({
    path: ["agent", "steer"],
    summary: "Make a queued follow-up a steer, which the running turn places after its current step",
    args: [...session, { name: "request", description: "Its request id (lemma agent queue)", required: true }],
    run: ({ args }) =>
      Effect.gen(function* () {
        if (!(yield* callHere(registries, AgentChannels.promote, { sessionId: args.session, requestId: args.request })))
          return yield* new CliCommandError({
            reason: "NotFound",
            message: `${args.request} is no queued follow-up in ${args.session}, or no turn runs there to place it`,
            subject: args.request,
          });
        return { json: { steering: args.request }, text: `${args.request} steers the running turn` };
      }),
  }),
  defineCliCommand({
    path: ["agent", "wait"],
    summary: "Wait until a session is idle: no turn running and nothing queued",
    description: "For a script or an agent that started work with run and does something else meanwhile. Answers at once when it is idle already.",
    args: session,
    run: ({ args }) =>
      Effect.gen(function* () {
        const sessionId = args.session;
        yield* callHere(registries, SessionChannels.get, { sessionId });
        const idle = Effect.map(
          Effect.all([callHere(registries, AgentChannels.running, undefined), callHere(registries, AgentChannels.queue, { sessionId })]),
          ([running, queue]) => !running.includes(sessionId) && queue.length === 0,
        );
        // Each turn or queue change in the session is a reason to look again; the first look is once the stream hears them.
        let done = false;
        yield* followHere(
          registries,
          AgentChannels.activity,
          () => ({ output: false }),
          (element) =>
            element.type === "subscribed" || (element.sessionId === sessionId && (element.type === "turn-ended" || element.type === "queue-changed"))
              ? Effect.flatMap(idle, (now) => (now ? Effect.sync(() => (done = true)).pipe(Effect.andThen(Effect.interrupt)) : Effect.void))
              : Effect.void,
        ).pipe(Effect.catchCause((cause) => (done ? Effect.void : Effect.failCause(cause))));
        return { json: { session: sessionId, idle: true }, text: `${sessionId} is idle` };
      }),
  }),
];

/**
 * The agent's commands for the `lemma` command (`CliCommands`): `run`, and
 * `agent cancel|running|queue|withdraw|steer|wait`. It reaches the agent and
 * the sessions through their channels, so it requires nothing, and a reload of
 * either goes on under a running `run` as it would under a client's.
 */
export default definePlugin({
  id: "agent.cli",
  version: "0.1.0",
  setup: function* (_, owner) {
    const registries = yield* Registries;
    const events = yield* Events;
    for (const command of agentCommands(registries, events)) yield* owner.add(CliCommands, command);
  },
});
