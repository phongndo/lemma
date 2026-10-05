import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { Effect, Layer } from "effect";
import { definePlugin, Events, PluginContext } from "@lemma/core";
import { AgentError, Harnesses, Inspectors, Interaction, Paths, Sessions } from "@lemma/contracts";
import type { HarnessStatus } from "@lemma/contracts";
import { AcpConfig } from "./config.ts";
import type { AgentSpec } from "./config.ts";
import { openConnection, spawnAgent } from "./connection.ts";
import type { Connection, StartAgent } from "./connection.ts";
import { runAcpTurn } from "./turn.ts";

export { AcpConfig, AgentSpec, DEFAULT_AGENTS } from "./config.ts";
export { openConnection, spawnAgent } from "./connection.ts";
export type { Connection, StartAgent, Transport } from "./connection.ts";
export { TURN_KIND } from "./turn.ts";

const executable = (path: string) =>
  access(path, constants.X_OK).then(
    () => true,
    () => false,
  );

/** Whether the agent's program is there to start: a path, or a name found on PATH. */
const statusOf = (spec: AgentSpec, cwd: string): Effect.Effect<HarnessStatus> =>
  Effect.promise(async (): Promise<HarnessStatus> => {
    const { command } = spec;
    const candidates = command.includes("/")
      ? [isAbsolute(command) ? command : resolve(cwd, command)]
      : (process.env.PATH ?? "").split(delimiter).flatMap((dir) => (dir === "" ? [] : [join(dir, command)]));
    for (const candidate of candidates) if (await executable(candidate)) return { state: "ready" };
    const where = command.includes("/") ? `${command} is not an executable file.` : `${command} was not found on PATH.`;
    return { state: "unavailable", detail: spec.install === undefined ? where : `${where} ${spec.install}` };
  });

export interface AcpOptions {
  /** How an agent is started: its process by default. Tests run one in this process. */
  readonly start?: StartAgent;
  /** Whether an agent can be started: its program on PATH by default. */
  readonly status?: (spec: AgentSpec) => Effect.Effect<HarnessStatus>;
}

/**
 * Registers each configured ACP agent as a harness. An agent's process starts
 * with its first turn and serves every session after it; one that exits is
 * started again by the next turn. Every process stops with the plugin.
 */
export function acpPlugin(options: AcpOptions = {}) {
  return definePlugin({
    id: "acp",
    version: "0.1.0",
    config: AcpConfig,
    requires: [Harnesses, Sessions, Interaction, Paths],
    layer: (config) =>
      Layer.scopedDiscard(
        Effect.gen(function* () {
          const owner = yield* PluginContext;
          const registry = yield* Harnesses;
          const sessions = yield* Sessions;
          const events = yield* Events;
          const interaction = yield* Interaction;
          const paths = yield* Paths;
          const start = options.start ?? spawnAgent;
          const running = new Map<string, Connection>();

          for (const spec of config.agents) {
            const title = spec.title ?? spec.id;
            const lock = yield* Effect.makeSemaphore(1);
            let current: Connection | undefined;
            /** The agent's live connection; a dead one is replaced. Serialized, so two first turns start one process. */
            const connection = (sessionId: string) =>
              lock.withPermits(1)(
                Effect.gen(function* () {
                  if (current?.alive()) return current;
                  const stale = current;
                  current = undefined;
                  running.delete(spec.id);
                  if (stale !== undefined) yield* Effect.promise(() => stale.close());
                  const opened = yield* Effect.tryPromise({
                    try: () => openConnection(spec, start(spec, paths.cwd)),
                    catch: (cause) =>
                      new AgentError({
                        sessionId,
                        reason: "NoHarness",
                        message: `${title} could not start: ${cause instanceof Error ? cause.message : String(cause)}`,
                        cause,
                      }),
                  });
                  current = opened;
                  running.set(spec.id, opened);
                  return opened;
                }),
              );
            yield* Effect.addFinalizer(() => Effect.promise(() => current?.close() ?? Promise.resolve()));
            yield* registry.register({
              id: spec.id,
              title,
              description: spec.description ?? `${title}, an ACP agent (${spec.command}).`,
              capabilities: { steer: false, models: false, resume: false, requests: false },
              status: options.status?.(spec) ?? statusOf(spec, paths.cwd),
              run: (turn) => runAcpTurn({ spec, title, sessions, events, interaction, connection }, turn),
            });
          }

          // What the devtools and `lemma inspect` show of it. Only a view: failing to add it never stops the plugin.
          yield* owner
            .add(Inspectors, {
              id: "acp.agents",
              title: "ACP agents",
              description: "Each configured agent, how it is started, and its process: running, the sessions it has open, or why it stopped",
              snapshot: Effect.sync(() =>
                config.agents.map((spec) => {
                  const connection = running.get(spec.id);
                  return {
                    id: spec.id,
                    command: [spec.command, ...spec.args].join(" "),
                    running: connection?.alive() ?? false,
                    sessions: connection?.sessions.size ?? 0,
                    ...(connection?.initialized.agentInfo?.version === undefined ? {} : { version: connection.initialized.agentInfo.version }),
                    ...(connection?.ended() === undefined ? {} : { stopped: connection.ended() }),
                  };
                }),
              ),
            })
            .pipe(Effect.ignore);
        }),
      ),
  });
}

export default acpPlugin();
