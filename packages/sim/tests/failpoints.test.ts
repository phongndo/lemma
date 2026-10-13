import { Effect, Exit, Fiber } from "effect";
import { expect, test } from "vitest";
import { Agent } from "@lemma/agent";
import { emptyUsage } from "@lemma/llm";
import { Sessions } from "@lemma/sessions";
import { SimDisk } from "@lemma/testing";
import { diskFiles, failureArtifact } from "@lemma/testing/artifacts";
import { SimHost } from "../src/host.ts";
import { simModel } from "../src/model.ts";
import { Simulation } from "../src/simulation.ts";

const text = (value: string) => [{ type: "text" as const, text: value }];
test("failed session appends and queue withdrawals survive restart and resume healthy work", async () => {
  const reached = new Set<string>();
  for (const operation of ["append", "withdraw"] as const)
    for (const persistent of [false, true])
      // Each of the attempt's disk operations in turn, until the attempt completes before its fault is due.
      for (let at = 0; ; at++) {
        expect(at, `the ${operation} takes a bounded number of disk operations`).toBeLessThan(200);
        const sim = new Simulation({ seed: 51, shuffle: true });
        const random = sim.random.split("disk");
        const disk = new SimDisk(() => random.next());
        const alive = new Set([1]);
        let slow = false;
        const parts = {
          plugins: [
            simModel(sim.random.split("model"), {
              keep: false,
              answering: () => ({
                kinds: ["reply"],
                latencyMs: slow ? 100000 : 1,
                deltas: [{ text: "ok", afterMs: 1 }],
                ending: { kind: "done", calls: [] },
                usage: emptyUsage,
              }),
            }).plugin,
          ],
          configs: { "agent.loop": { stopGrace: 0 } },
        };
        let host = await SimHost.start(sim, disk.mount(), 1, parts, alive);
        try {
          const session = await host.run(Effect.flatMap(Sessions, (sessions) => sessions.create()));
          await host.run(Effect.flatMap(Agent, (agent) => agent.prompt(session.id, text("before"))));
          if (operation === "withdraw") {
            slow = true;
            sim.fork(
              host.core.run(Effect.flatMap(Agent, (agent) => agent.prompt(session.id, text("held"), { requestId: "held" }))) as Effect.Effect<unknown, unknown>,
            );
            await sim.settle();
            sim.fork(
              host.core.run(
                Effect.flatMap(Agent, (agent) => agent.prompt(session.id, text("queued"), { requestId: "queued", whenBusy: "follow-up" })),
              ) as Effect.Effect<unknown, unknown>,
            );
            await sim.settle();
            expect((await host.run(Effect.flatMap(Agent, (agent) => agent.queue(session.id)))).map((item) => item.requestId)).toContain("queued");
          }
          const known = await host.run(Effect.flatMap(Sessions, (sessions) => sessions.events(session.id)));
          disk.faultAfter(at, { persistent });
          const attempt: Effect.Effect<unknown, unknown, Sessions | Agent> =
            operation === "append"
              ? Effect.flatMap(Sessions, (sessions) => sessions.append(session.id, { type: "custom", kind: "probe", data: { at } }))
              : Effect.flatMap(Agent, (agent) => agent.withdraw(session.id, "queued"));
          const attempted = await host.run(Effect.exit(attempt));
          const fired = disk.injected.size > 0;
          for (const [kind] of disk.injected) reached.add(kind);
          disk.clearFaults();
          await host.stop();
          alive.delete(1);
          disk.crash();
          slow = false;
          alive.add(2);
          host = await SimHost.start(sim, disk.mount(), 2, parts, alive);
          const served = await host.run(Effect.flatMap(Sessions, (sessions) => sessions.events(session.id)));
          expect(served.slice(0, known.length)).toEqual(known);
          if (operation === "append" && Exit.isSuccess(attempted))
            expect(served.some((event) => event.data.type === "custom" && event.data.kind === "probe")).toBe(true);
          if (operation === "withdraw" && Exit.isSuccess(attempted) && attempted.value === true) {
            expect(served.some((event) => event.data.type === "message" && event.data.requestId === "queued")).toBe(false);
            expect((await host.run(Effect.flatMap(Agent, (agent) => agent.queue(session.id)))).some((item) => item.requestId === "queued")).toBe(false);
          }
          const healthy = sim.fork(
            host.core.run(Effect.flatMap(Agent, (agent) => agent.prompt(session.id, text("after"), { whenBusy: "follow-up" }))) as Effect.Effect<
              unknown,
              unknown
            >,
          );
          expect(await sim.drive(() => healthy.pollUnsafe() !== undefined, 200000)).toBe(true);
          expect(Exit.isSuccess(await sim.value(Fiber.await(healthy)))).toBe(true);
          if (!fired) break;
        } catch (error) {
          failureArtifact(
            "failpoint",
            { operation, persistent, at, seed: 51, error: String(error), operations: Object.fromEntries(disk.operations) },
            diskFiles(disk),
          );
          throw error;
        } finally {
          disk.clearFaults();
          await host.stop();
        }
      }
  expect(reached.has("write")).toBe(true);
  expect(reached.has("sync")).toBe(true);
});
