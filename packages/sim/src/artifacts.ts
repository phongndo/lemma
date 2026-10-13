import { diskFiles, failureArtifact } from "@lemma/testing/artifacts";
import { digestOf } from "./host.ts";
import type { World } from "./world.ts";

/** Saves a failed world's evidence (`failureArtifact`): its seed and replay, what it did and was told, and its disk. */
export function saveWorldFailure(world: World, ticks: number, error: unknown): string {
  return failureArtifact(
    "simulation",
    {
      seed: world.sim.seed,
      ticks,
      replay: `nix develop -c pnpm sim --seed ${world.sim.seed} --ticks ${ticks} --dump`,
      error: error instanceof Error ? error.stack : String(error),
      description: world.describe(),
      swarm: world.swarm,
      shuffled: world.shuffled,
      digest: digestOf(world.disk),
      coverage: Object.fromEntries(world.coverage()),
      trace: world.trace,
      prompts: [...world.checker.sent.values()],
      // The requests themselves are in the logs on the disk: each rebuilds from its session's.
      calls: world.calls.map(({ host, request, summary }) => ({ host, sessionId: request.sessionId, summary, messages: request.messages.length })),
    },
    diskFiles(world.disk),
  );
}
