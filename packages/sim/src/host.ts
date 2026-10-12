import { createHash } from "node:crypto";
import { Effect, Exit, Layer, Scope } from "effect";
import { definePlugin, makeCore } from "@lemma/core";
import type { Core, Plugin } from "@lemma/core";
import { HostControl } from "@lemma/contracts";
import { pathsPlugin } from "@lemma/contracts/testing";
import { makeAgentPlugin } from "@lemma/agent-loop";
import { makeSessionsPlugin } from "@lemma/sessions-files";
import type { Claimant } from "@lemma/sessions-files";
import tools from "@lemma/tools-registry";
import type { SimDisk } from "@lemma/testing";
import type { Simulation } from "./simulation.ts";

/** Where a simulated host keeps its state on the simulated disk, and the platform its prompt names. */
export const HOME = "/lemma";
export const PLATFORM = "sim (x64)";

/** `HostControl` for a host with no plugins of its own to control. */
const hostControl = definePlugin({
  id: "host",
  provides: [HostControl],
  layer: Layer.succeed(HostControl, {
    runtime: [HostControl.key],
    plugins: Effect.succeed([]),
    composition: Effect.succeed({ id: "sim", plugins: [] }),
    restart: () => Effect.succeed({}),
    reload: Effect.die("A simulated host does not reload its config"),
    configure: () => Effect.die("A simulated host has no config"),
    web: Effect.succeed({ plugins: {}, enabledIn: {}, configIn: {}, files: [] }),
  }),
});

/** What a host runs besides its sessions store, its agent, and its tool registry: the model and the tools. */
export interface HostParts {
  readonly plugins: readonly Plugin[];
  /** Each plugin's config, by id. */
  readonly configs?: Readonly<Record<string, unknown>>;
}

/**
 * One host process of a simulation: a core with the bundled sessions store, agent loop, and tool registry, on a
 * mount of the simulated disk, its ids and its lock's claim drawn from the run. Hosts of one run are told apart by
 * `generation`, which the sessions lock takes as its pid.
 */
export class SimHost {
  readonly generation: number;
  readonly core: Core<any>;
  private readonly scope: Scope.Closeable;
  private readonly sim: Simulation;

  private constructor(generation: number, core: Core<any>, scope: Scope.Closeable, sim: Simulation) {
    this.generation = generation;
    this.core = core;
    this.scope = scope;
    this.sim = sim;
  }

  static async start(sim: Simulation, disk: SimDisk, generation: number, parts: HostParts, alive: ReadonlySet<number>): Promise<SimHost> {
    const fs = disk.mount();
    const claimant: Claimant = {
      pid: generation,
      hostname: "sim",
      bootedAt: 0,
      isAlive: (pid) => alive.has(pid),
      now: () => sim.clock.currentTimeMillisUnsafe(),
      token: () => `host-${generation}`,
    };
    const plugins: Plugin[] = [
      pathsPlugin(HOME),
      hostControl,
      makeSessionsPlugin({ fs, ids: sim.random.split(`sessions ids ${generation}`).ids(), claimant }),
      makeAgentPlugin({ fs, ids: sim.random.split(`agent ids ${generation}`).ids(), platform: PLATFORM }),
      tools,
      ...parts.plugins,
    ];
    const [scope, core] = await sim.value(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const core = yield* makeCore(plugins, { configs: { ...parts.configs } }).pipe(Scope.provide(scope));
        return [scope, core] as const;
      }),
    );
    return new SimHost(generation, core, scope, sim);
  }

  /** Runs `effect` with the host's capabilities, in the simulation, to its end. */
  run<A, E>(effect: Effect.Effect<A, E, any>): Promise<A> {
    return this.sim.value(this.core.run(effect) as Effect.Effect<A, E>);
  }

  /** Stops the host as a host stops: its plugins close, its agent suspending its turns. */
  stop(): Promise<void> {
    return this.sim.value(Scope.close(this.scope, Exit.void));
  }
}

/**
 * `writeFileAtomic`'s temporary file names end in its process's pid and a count of the writes that process has made,
 * in every run before this one too.
 */
const TEMPORARY = /\.\d+-\d+\.tmp$/;

/**
 * A digest of every file on `disk` as it stands, names and bytes: two runs that wrote the same have the same. A
 * temporary file a crash left behind counts by the file it was for and what it holds, not the pid and count its name
 * ends in.
 */
export const digestOf = (disk: SimDisk): string => {
  const hash = createHash("sha256");
  const files = disk.list().map((path) => ({ name: path.replace(TEMPORARY, ".tmp"), bytes: disk.read(path) ?? "" }));
  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.bytes < b.bytes ? -1 : a.bytes > b.bytes ? 1 : 0));
  for (const { name, bytes } of files) {
    hash.update(`${name}\u0000`);
    hash.update(bytes);
    hash.update("\u0000");
  }
  return hash.digest("hex");
};
