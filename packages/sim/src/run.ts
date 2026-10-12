import { Effect } from "effect";
import { Agent } from "@lemma/agent";
import { Sessions } from "@lemma/sessions";
import { SimDisk } from "@lemma/testing";
import { digestOf, SimHost } from "./host.ts";
import { simModel } from "./model.ts";
import { Simulation } from "./simulation.ts";
import { simTools } from "./tools.ts";

/**
 * A short run for a seed: a host takes a few prompts in two sessions, one after another and at once, stops, and a
 * second host starts on what it left and takes one more. Returns the digest of the disk it leaves, which the same
 * seed reproduces byte for byte.
 */
export async function digestRun(seed: number): Promise<string> {
  const sim = new Simulation({ seed });
  const diskRandom = sim.random.split("disk");
  const disk = new SimDisk(() => diskRandom.next());
  const model = simModel(sim.random.split("model"));
  const toolset = simTools(sim.random.split("tools"));
  const parts = { plugins: [model.plugin, toolset.plugin], configs: { "agent.loop": { maxSteps: 6, stopGrace: 0 } } };
  const alive = new Set<number>([1]);
  const first = await SimHost.start(sim, disk, 1, parts, alive);
  const sessions = await first.run(
    Effect.gen(function* () {
      const store = yield* Sessions;
      const agent = yield* Agent;
      const a = yield* store.create();
      const b = yield* store.create();
      yield* agent.prompt(a.id, [{ type: "text", text: "first" }]);
      yield* Effect.all([agent.prompt(a.id, [{ type: "text", text: "second" }]), agent.prompt(b.id, [{ type: "text", text: "third" }])], {
        concurrency: "unbounded",
      });
      return [a.id, b.id] as const;
    }),
  );
  await first.stop();
  alive.delete(1);
  alive.add(2);
  const second = await SimHost.start(sim, disk, 2, parts, alive);
  await second.run(Effect.flatMap(Agent, (agent) => agent.prompt(sessions[1], [{ type: "text", text: "fourth" }])));
  await second.stop();
  return digestOf(disk);
}
