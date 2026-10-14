import { Effect, PubSub, Stream } from "effect";
import type { PluginFault, ReportedFault } from "../errors.ts";

/** Where a core's faults go: numbered, kept as their instance's latest, and published. */
export interface FaultLog {
  /**
   * Numbers `fault`, keeps it as `instance`'s latest (inspection has it even
   * without subscribers), then publishes it, unless the log has closed.
   */
  readonly report: (instance: { fault?: PluginFault }, fault: PluginFault) => Effect.Effect<void>;
  /** Faults from subscription on; at most 256 queued, the oldest dropped without blocking supervision. */
  readonly stream: Stream.Stream<ReportedFault>;
  /** The latest sequence reported, 0 before any. */
  readonly sequence: () => number;
  /** Ends every subscription; later reports are only kept. */
  readonly close: Effect.Effect<void>;
}

export const makeFaultLog: Effect.Effect<FaultLog> = Effect.map(PubSub.sliding<ReportedFault>(256), (faults) => {
  let sequence = 0;
  return {
    report: (instance, fault) =>
      Effect.suspend(() => {
        const reported = Object.assign(fault, { sequence: ++sequence });
        instance.fault = reported;
        return PubSub.isShutdown(faults).pipe(Effect.flatMap((closed) => (closed ? Effect.void : PubSub.publish(faults, reported).pipe(Effect.asVoid))));
      }),
    stream: Stream.fromPubSub(faults),
    sequence: () => sequence,
    close: PubSub.shutdown(faults),
  };
});
